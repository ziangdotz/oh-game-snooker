import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { RoomError, RoomService } from './room-service.mjs';
import { ROOM_PROTOCOL_VERSION, validateClientMessage } from './room-protocol.mjs';
import { createRuntimeCatalog } from '../matches/runtime-loader.mjs';
import { createMatchSession } from '../matches/match-session.mjs';
import { CONNECTION_LIMITS, RateLimiter, createConnectionHealth } from './connection-health.mjs';

function send(socket, message) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, ...message }));
  }
}

function errorMessage(error, requestId = null) {
  return {
    type: 'room.error',
    requestId,
    code: error.code || 'internal_error',
    message: error.message || 'Room request failed',
  };
}

export function createRoomServer({
  port = 8787,
  host = '127.0.0.1',
  service = new RoomService(),
  matchFactory = createMatchSession,
  // Origins a browser tab may connect from. Empty means "no browser origin
  // filtering", which is correct while the service only listens on loopback.
  // A public deployment must pass the site origins explicitly.
  origins = [],
  // Optional TLS material. Supplying it serves HTTPS/WSS directly instead of
  // relying on a reverse proxy; the page then has to use wss://.
  tls = null,
} = {}) {
  const allowedOrigins = origins.slice();
  const connections = new Map();
  const roomSockets = new Map();
  const matches = new Map();
  const startingRooms = new Set();
  const limiter = new RateLimiter();
  const abandonedSeats = new Map();
  let runtimePromise;
  const requestHandler = (request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          rooms: service.size,
          connections: connections.size,
          sockets: wss.clients.size,
          matches: matches.size,
          capacity: CONNECTION_LIMITS.MAX_CONNECTIONS,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  };
  // With TLS material the same handler serves HTTPS, so WSS needs no proxy.
  const httpServer = tls ? createSecureServer(tls, requestHandler) : createServer(requestHandler);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/rooms',
    maxPayload: 64 * 1024,
    // A browser tab sends Origin; a foreign page must not drive a local seat.
    // Requests without an Origin header (native clients, the test harness and
    // the CLI) are allowed, which is what the loopback-only default relies on.
    verifyClient: ({ origin }, done) => {
      // Refuse at the handshake so an over-capacity client never reaches an
      // open socket, and a foreign origin cannot drive a local seat.
      if (wss.clients.size >= CONNECTION_LIMITS.MAX_CONNECTIONS) {
        done(false, 503, 'server at capacity');
        return;
      }
      if (!origin || allowedOrigins.length === 0) {
        done(true);
        return;
      }
      const allowed = allowedOrigins.some(
        (pattern) => pattern === origin || pattern === '*' || matchesOrigin(pattern, origin),
      );
      done(allowed, allowed ? 200 : 403, allowed ? undefined : 'origin not allowed');
    },
  });

  /** Allow `ws://127.0.0.1:*` style patterns to match any port. */
  function matchesOrigin(pattern, origin) {
    const wildcard = pattern.indexOf('*');
    if (wildcard < 0) {
      return false;
    }
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return origin.startsWith(prefix) && origin.endsWith(suffix);
  }

  function bind(socket, identity) {
    for (const [otherSocket, other] of connections) {
      if (
        otherSocket !== socket &&
        other.roomId === identity.roomId &&
        other.playerId === identity.playerId
      ) {
        // A refresh/reconnect replaces the previous transport for this seat.
        // Remove it before closing so its close event cannot mark the new seat offline.
        unbind(otherSocket);
        otherSocket.close(4001, 'session replaced');
      }
    }
    const bound = { ...identity };
    connections.set(socket, bound);
    let sockets = roomSockets.get(identity.roomId);
    if (!sockets) {
      sockets = new Set();
      roomSockets.set(identity.roomId, sockets);
    }
    sockets.add(socket);
    return bound;
  }

  function unbind(socket) {
    const identity = connections.get(socket);
    connections.delete(socket);
    if (!identity) {
      return null;
    }
    const sockets = roomSockets.get(identity.roomId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        roomSockets.delete(identity.roomId);
      }
    }
    return identity;
  }

  function broadcast(roomId, state, extra = {}) {
    const sockets = roomSockets.get(roomId);
    if (!sockets) {
      return;
    }
    const message = { type: 'room.state', state, ...extra };
    for (const socket of sockets) {
      send(socket, message);
    }
  }

  function matchSnapshotMessage(match, event, extra = {}) {
    return {
      type: 'match.snapshot',
      matchId: match.matchId,
      event,
      ...extra,
      state: match.state(),
      snapshot: match.snapshot(),
    };
  }

  function broadcastMatch(roomId, event, extra = {}) {
    const match = matches.get(roomId);
    const sockets = roomSockets.get(roomId);
    if (!match || !sockets) {
      return;
    }
    const message = matchSnapshotMessage(match, event, extra);
    for (const socket of sockets) {
      send(socket, message);
    }
  }

  function getMatch(roomId) {
    const match = matches.get(roomId);
    if (!match) {
      throw new RoomError('match_not_found', 'The room has no active match');
    }
    return match;
  }

  function getRuntime() {
    runtimePromise ??= createRuntimeCatalog();
    return runtimePromise;
  }

  /** Publish the authoritative frame result and move the room to `finished`. */
  function finishFrame(identity, matchId) {
    const { roomId } = identity;
    const match = matches.get(roomId);
    if (!match) {
      return;
    }
    const snapshot = match.snapshot();
    const players = snapshot.match.players.map((player) => ({
      displayName: player.displayName,
      pts: player.pts,
      penalty: player.penalty,
      maxbrk: player.maxbrk,
      accuracy: player.accuracy,
    }));
    const scores = players.map((player, index) => player.pts - players[1 - index].penalty);
    const result = {
      draw: scores[0] === scores[1],
      winnerIndex: scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1,
      players,
    };
    let state;
    try {
      state = service.finishMatch({ ...identity, matchId, result }).state;
    } catch (error) {
      if (error.code === 'room_not_found') {
        return;
      }
      throw error;
    }
    if (!state) {
      return;
    }
    broadcast(roomId, state);
    broadcastMatch(roomId, 'finished', { result });
  }

  function requireBinding(socket, message) {
    const identity = connections.get(socket);
    if (
      !identity ||
      identity.roomId !== message.roomId ||
      identity.playerId !== message.playerId ||
      identity.token !== message.token
    ) {
      throw new RoomError('unauthorized', 'Connection is not bound to this seat');
    }
    return identity;
  }

  wss.on('connection', (socket) => {
    // Count every transport, not just bound seats: an unbound socket still
    // costs a buffer and a slot.
    if (wss.clients.size > CONNECTION_LIMITS.MAX_CONNECTIONS) {
      socket.close(4008, 'server at capacity');
      return;
    }
    const bucket = limiter.createBucket();
    socket.isAlive = true;
    socket.missedHeartbeats = 0;
    socket.on('pong', () => {
      socket.missedHeartbeats = 0;
      socket.isAlive = true;
    });
    send(socket, { type: 'room.hello', protocolVersion: ROOM_PROTOCOL_VERSION });
    socket.on('message', async (raw) => {
      if (!limiter.take(bucket)) {
        send(socket, errorMessage(new RoomError('rate_limited', 'Too many commands')));
        return;
      }
      let input;
      try {
        input = JSON.parse(raw.toString());
      } catch {
        send(socket, errorMessage(new RoomError('invalid_json', 'Message must be JSON')));
        return;
      }
      const validated = validateClientMessage(input);
      if (!validated.ok) {
        send(socket, errorMessage(validated.error, input?.requestId ?? null));
        return;
      }
      const message = validated.message;
      try {
        if (message.type === 'room.create') {
          if (connections.has(socket)) {
            throw new RoomError('already_joined', 'Connection already has a room seat');
          }
          const created = service.createRoom({
            displayName: message.displayName,
            interior: message.interior,
          });
          bind(socket, {
            roomId: created.roomId,
            playerId: created.playerId,
            token: created.token,
          });
          send(socket, {
            type: 'room.created',
            requestId: message.requestId,
            roomId: created.roomId,
            playerId: created.playerId,
            token: created.token,
            state: created.state,
          });
          return;
        }
        if (message.type === 'room.join') {
          if (connections.has(socket)) {
            throw new RoomError('already_joined', 'Connection already has a room seat');
          }
          const joined = service.joinRoom({
            roomId: message.roomId,
            displayName: message.displayName,
          });
          bind(socket, {
            roomId: joined.roomId,
            playerId: joined.playerId,
            token: joined.token,
          });
          send(socket, {
            type: 'room.joined',
            requestId: message.requestId,
            roomId: joined.roomId,
            playerId: joined.playerId,
            token: joined.token,
            state: joined.state,
          });
          broadcast(joined.roomId, joined.state);
          return;
        }
        if (message.type === 'room.resume') {
          if (connections.has(socket)) {
            throw new RoomError('already_joined', 'Connection already has a room seat');
          }
          const resumed = service.resume(message);
          bind(socket, {
            roomId: message.roomId,
            playerId: message.playerId,
            token: message.token,
          });
          send(socket, {
            type: 'room.resumed',
            requestId: message.requestId,
            state: resumed.state,
          });
          broadcast(message.roomId, resumed.state);
          const resumedMatch = matches.get(message.roomId);
          // Both an in-progress frame and a finished one carry authoritative
          // match state the resumed tab must render.
          if (resumedMatch && ['playing', 'finished'].includes(resumed.state.status)) {
            send(
              socket,
              matchSnapshotMessage(resumedMatch, 'resume', { requestId: message.requestId }),
            );
            if (resumed.state.status === 'finished' && resumed.state.match?.result) {
              send(socket, {
                type: 'match.snapshot',
                event: 'finished',
                requestId: message.requestId,
                result: resumed.state.match.result,
                state: resumedMatch.state(),
                snapshot: resumedMatch.snapshot(),
              });
            }
          }
          return;
        }
        const identity = requireBinding(socket, message);
        if (message.type === 'room.ready') {
          const result = service.setReady(message);
          send(socket, {
            type: 'room.state',
            requestId: message.requestId,
            state: result.state,
          });
          broadcast(identity.roomId, result.state);
          return;
        }
        if (message.type === 'room.start') {
          if (startingRooms.has(identity.roomId)) {
            throw new RoomError('match_starting', 'The match is already starting');
          }
          startingRooms.add(identity.roomId);
          let startedResult = null;
          try {
            const room = service.assertStartable(message).state;
            if (room.status === 'playing') {
              const existing = matches.get(identity.roomId);
              if (!existing) {
                throw new RoomError('match_not_found', 'The room has no active match');
              }
              broadcast(identity.roomId, room, { restarted: false });
              broadcastMatch(identity.roomId, 'start', { requestId: message.requestId });
              return;
            }
            const names = room.seats.map((seat) => seat.displayName);
            const runtime = await getRuntime();
            const match = await matchFactory({
              loadModule: runtime.createLoader(),
              names,
            });
            if (!connections.has(socket)) {
              return;
            }
            startedResult = service.startRoom(message);
            match.matchId = startedResult.state.match.matchId;
            matches.set(identity.roomId, match);
            broadcast(identity.roomId, startedResult.state, { restarted: true });
            broadcastMatch(identity.roomId, 'start', { requestId: message.requestId });
          } catch (error) {
            if (startedResult?.restarted) {
              try {
                const aborted = service.abortStart(message);
                matches.delete(identity.roomId);
                broadcast(identity.roomId, aborted.state, { matchStartFailed: true });
              } catch (abortError) {
                if (!(abortError instanceof RoomError) || abortError.code !== 'room_not_found') {
                  throw abortError;
                }
              }
            }
            throw error;
          } finally {
            startingRooms.delete(identity.roomId);
          }
          return;
        }
        if (message.type === 'room.state') {
          const result = service.state(message);
          send(socket, {
            type: 'room.state',
            requestId: message.requestId,
            state: result.state,
          });
          return;
        }
        if (message.type === 'match.state') {
          const room = service.state(message).state;
          if (room.match?.matchId !== message.matchId) {
            throw new RoomError('stale_match', 'matchId does not match the active match');
          }
          const match = getMatch(identity.roomId);
          send(socket, matchSnapshotMessage(match, 'state', { requestId: message.requestId }));
          return;
        }
        if (message.type === 'match.place' || message.type === 'match.shot') {
          const room = service.state(message).state;
          if (room.status !== 'playing') {
            throw new RoomError('room_not_playing', 'The room is not playing');
          }
          if (room.match?.matchId !== message.matchId) {
            throw new RoomError('stale_match', 'matchId does not match the active match');
          }
          const playerIndex = room.seats.findIndex((seat) => seat.playerId === identity.playerId);
          if (playerIndex < 0) {
            throw new RoomError('unauthorized', 'Player is not seated in this room');
          }
          const match = getMatch(identity.roomId);
          const result =
            message.type === 'match.place'
              ? match.placeCueBall({
                  playerIndex,
                  commandId: message.commandId,
                  matchVersion: message.matchVersion,
                  turn: message.turn,
                  position: message.position,
                })
              : match.shoot({
                  playerIndex,
                  commandId: message.commandId,
                  matchVersion: message.matchVersion,
                  turn: message.turn,
                  shot: message.shot,
                });
          broadcastMatch(identity.roomId, message.type === 'match.place' ? 'place' : 'shot', {
            requestId: message.requestId,
            commandId: message.commandId,
            result,
          });
          if (result.state.ballOn === 0) {
            finishFrame(identity, message.matchId);
          }
          return;
        }
        if (message.type === 'match.rematch') {
          const room = service.state(message).state;
          if (room.match?.matchId !== message.matchId) {
            throw new RoomError('stale_match', 'matchId does not match the active match');
          }
          const accepted = service.requestRematch({
            roomId: identity.roomId,
            playerId: identity.playerId,
            token: identity.token,
            matchId: message.matchId,
          });
          broadcast(identity.roomId, accepted.state);
          broadcastMatch(identity.roomId, 'rematch-vote', {
            requestId: message.requestId,
            acceptedPlayerIds: accepted.acceptedPlayerIds,
          });
          if (accepted.accepted) {
            // Build the new instance before replacing the room frame, so a load
            // failure cannot leave `playing` pointing at a finished match.
            const names = accepted.state.seats.map((seat) => seat.displayName);
            const runtime = await getRuntime();
            const fresh = await matchFactory({
              loadModule: runtime.createLoader(),
              names,
            });
            const restarted = service.startRematch({
              roomId: identity.roomId,
              playerId: identity.playerId,
              token: identity.token,
              matchId: message.matchId,
            });
            fresh.matchId = restarted.state.match.matchId;
            matches.set(identity.roomId, fresh);
            const rematchSnapshot = matchSnapshotMessage(fresh, 'rematch', {
              requestId: message.requestId,
              matchId: restarted.state.match.matchId,
            });
            broadcast(identity.roomId, restarted.state, { rematch: true });
            for (const socket of roomSockets.get(identity.roomId) ?? []) {
              send(socket, rematchSnapshot);
            }
          }
          return;
        }
        if (message.type === 'room.leave') {
          const result = service.leave(message);
          matches.delete(result.roomId);
          unbind(socket);
          send(socket, {
            type: 'room.left',
            requestId: message.requestId,
            roomId: result.roomId,
            closed: result.closed,
          });
          if (result.state) {
            broadcast(result.roomId, result.state);
          } else {
            for (const peer of [...(roomSockets.get(result.roomId) ?? [])]) {
              send(peer, { type: 'room.closed', roomId: result.roomId, reason: 'player_left' });
              unbind(peer);
            }
          }
          return;
        }
        throw new RoomError('unknown_type', 'Unsupported message type');
      } catch (error) {
        send(socket, errorMessage(error, message.requestId));
      }
    });
    socket.on('close', () => {
      const identity = unbind(socket);
      if (!identity) {
        return;
      }
      try {
        const result = service.disconnect(identity);
        broadcast(identity.roomId, result.state);
        // A seat that is still the only one online gets a grace window to come
        // back, so a refresh or a brief network drop does not end the frame.
        rememberAbandonedRoom(identity.roomId, result.state);
      } catch (error) {
        if (!(error instanceof RoomError) || error.code !== 'room_not_found') {
          throw error;
        }
        matches.delete(identity.roomId);
        abandonedSeats.delete(identity.roomId);
      }
    });
  });

  /** Track when a room lost its last live socket. */
  function rememberAbandonedRoom(roomId, state) {
    const live = state?.seats?.some((seat) => seat.connected);
    if (live) {
      abandonedSeats.delete(roomId);
      return;
    }
    if (!abandonedSeats.has(roomId)) {
      abandonedSeats.set(roomId, Date.now());
    }
  }

  /** Close rooms whose players never came back inside the grace window. */
  function sweepAbandonedRooms(now = Date.now()) {
    for (const [roomId, since] of abandonedSeats) {
      if (roomSockets.has(roomId) && roomSockets.get(roomId).size > 0) {
        abandonedSeats.delete(roomId);
        continue;
      }
      if (now - since < CONNECTION_LIMITS.DISCONNECT_GRACE_MS) {
        continue;
      }
      abandonedSeats.delete(roomId);
      matches.delete(roomId);
      service.retire?.(roomId);
    }
  }

  /** Ping every socket and drop the ones that stopped answering. */
  function heartbeat() {
    for (const socket of wss.clients) {
      if (socket.missedHeartbeats >= CONNECTION_LIMITS.MAX_MISSED_HEARTBEATS) {
        socket.terminate();
        continue;
      }
      socket.missedHeartbeats = (socket.missedHeartbeats ?? 0) + 1;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }

  const health = createConnectionHealth({
    onHeartbeat: heartbeat,
    onSweep: () => sweepAbandonedRooms(),
  });

  return {
    httpServer,
    wss,
    service,
    /** True when the service is serving WSS directly from TLS material. */
    get secure() {
      return Boolean(tls);
    },
    /** Exposed so tests and the deploy probe can drive the timers directly. */
    heartbeat,
    sweepAbandonedRooms,
    address() {
      const address = httpServer.address();
      return address && typeof address === 'object' ? address : null;
    },
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', reject);
          health.start();
          resolve(httpServer.address());
        });
      });
    },
    close() {
      health.stop();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      connections.clear();
      roomSockets.clear();
      matches.clear();
      startingRooms.clear();
      abandonedSeats.clear();
      httpServer.closeAllConnections?.();
      return new Promise((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}
