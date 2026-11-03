import { randomUUID } from 'node:crypto';
import { ROOM_PROTOCOL_VERSION, ROOM_STATUS, normalizeDisplayName } from './room-protocol.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// The halls a room may be created in. The physical table is identical in all of
// them (one collision mesh), so this list governs the backdrop only.
const KNOWN_INTERIORS = Object.freeze([
  'interior-design-original',
  'interior-design-001',
  'interior-design-002',
  'interior-design-003',
]);
const DEFAULT_INTERIOR = KNOWN_INTERIORS[0];

function isKnownInterior(value) {
  return typeof value === 'string' && KNOWN_INTERIORS.includes(value);
}

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export class RoomService {
  constructor({ now = () => Date.now(), uuid = randomUUID } = {}) {
    this._now = now;
    this._uuid = uuid;
    this._rooms = new Map();
  }

  get size() {
    return this._rooms.size;
  }

  _timestamp() {
    return new Date(this._now()).toISOString();
  }

  _touch(room) {
    room.revision += 1;
    room.updatedAt = this._timestamp();
  }

  _createCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const raw = this._uuid().replace(/-/g, '').toUpperCase();
      let code = '';
      for (let index = 0; index < 6; index += 1) {
        code +=
          CODE_ALPHABET[
            Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16) % CODE_ALPHABET.length
          ];
      }
      if (!this._rooms.has(code)) {
        return code;
      }
    }
    throw new RoomError('room_code_exhausted', 'Unable to allocate a room code');
  }

  _room(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) {
      throw new RoomError('room_not_found', 'Room not found');
    }
    return room;
  }

  _seat(room, playerId, token) {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId);
    if (!seat || seat.token !== token) {
      throw new RoomError('unauthorized', 'Player token does not match this room seat');
    }
    return seat;
  }

  _publicState(room) {
    return {
      roomId: room.roomId,
      status: room.status,
      hostId: room.hostId,
      interior: room.interior,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      revision: room.revision,
      seats: room.seats.map((seat) => ({
        playerId: seat.playerId,
        displayName: seat.displayName,
        ready: seat.ready,
        connected: seat.connected,
        joinedAt: seat.joinedAt,
      })),
      match: room.match ? { ...room.match } : null,
    };
  }

  createRoom({ displayName, interior = DEFAULT_INTERIOR }) {
    const name = normalizeDisplayName(displayName);
    if (!name.ok) {
      throw new RoomError(name.error.code, name.error.message);
    }
    // Only known halls are accepted: every seat must be able to switch to the
    // room's venue, and an unknown id would leave the two players on different
    // backdrops for the whole frame.
    if (!isKnownInterior(interior)) {
      throw new RoomError('invalid_interior', 'interior must be a known venue id');
    }
    const roomId = this._createCode();
    const now = this._timestamp();
    const playerId = this._uuid();
    const token = this._uuid();
    const room = {
      roomId,
      status: ROOM_STATUS.WAITING,
      hostId: playerId,
      interior,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      seats: [
        {
          playerId,
          displayName: name.value,
          token,
          ready: false,
          connected: true,
          joinedAt: now,
        },
      ],
      match: null,
    };
    this._rooms.set(roomId, room);
    return { roomId, playerId, token, state: this._publicState(room) };
  }

  joinRoom({ roomId, displayName }) {
    const room = this._room(roomId);
    if (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.CLOSED) {
      throw new RoomError('room_unavailable', 'Room is not accepting players');
    }
    if (room.seats.length >= 2) {
      throw new RoomError('room_full', 'Room already has two players');
    }
    const name = normalizeDisplayName(displayName);
    if (!name.ok) {
      throw new RoomError(name.error.code, name.error.message);
    }
    if (room.seats.some((seat) => seat.displayName.toLowerCase() === name.value.toLowerCase())) {
      throw new RoomError('name_taken', 'That display name is already used in this room');
    }
    const playerId = this._uuid();
    const token = this._uuid();
    const now = this._timestamp();
    room.seats.push({
      playerId,
      displayName: name.value,
      token,
      ready: false,
      connected: true,
      joinedAt: now,
    });
    this._touch(room);
    return { roomId, playerId, token, state: this._publicState(room) };
  }

  setReady({ roomId, playerId, token, ready }) {
    const room = this._room(roomId);
    const seat = this._seat(room, playerId, token);
    if (![ROOM_STATUS.WAITING, ROOM_STATUS.READY].includes(room.status)) {
      throw new RoomError('room_unavailable', 'Room is not accepting ready changes');
    }
    seat.ready = ready;
    room.status =
      room.seats.length === 2 && room.seats.every((candidate) => candidate.ready)
        ? ROOM_STATUS.READY
        : ROOM_STATUS.WAITING;
    this._touch(room);
    return { state: this._publicState(room) };
  }

  _assertStartable(room, playerId) {
    if (room.status === ROOM_STATUS.FINISHED || room.status === ROOM_STATUS.CLOSED) {
      throw new RoomError('room_unavailable', 'A finished frame requires both rematch votes');
    }
    if (room.hostId !== playerId) {
      throw new RoomError('not_host', 'Only the host can start the match');
    }
    if (room.seats.length !== 2) {
      throw new RoomError('not_enough_players', 'Two players are required');
    }
    if (!room.seats.every((seat) => seat.ready && seat.connected)) {
      throw new RoomError('players_not_ready', 'Both players must be ready and connected');
    }
    return room;
  }

  startRoom({ roomId, playerId, token }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    this._assertStartable(room, playerId);
    if (room.status === ROOM_STATUS.PLAYING) {
      return { state: this._publicState(room), restarted: false };
    }
    room.status = ROOM_STATUS.PLAYING;
    room.match = {
      matchId: this._uuid(),
      protocolVersion: ROOM_PROTOCOL_VERSION,
      startedAt: this._timestamp(),
    };
    this._touch(room);
    return { state: this._publicState(room), restarted: true };
  }

  assertStartable({ roomId, playerId, token }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    this._assertStartable(room, playerId);
    return { state: this._publicState(room) };
  }

  resume({ roomId, playerId, token }) {
    const room = this._room(roomId);
    const seat = this._seat(room, playerId, token);
    seat.connected = true;
    this._touch(room);
    return { state: this._publicState(room), resumed: true };
  }

  /** Mark a frame complete and record the final figures both seats must agree on. */
  finishMatch({ roomId, playerId, token, matchId, result }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    if (room.status !== ROOM_STATUS.PLAYING) {
      throw new RoomError('room_not_playing', 'Room is not in the playing state');
    }
    if (room.match?.matchId !== matchId) {
      throw new RoomError('stale_match', 'matchId does not match the active match');
    }
    room.status = ROOM_STATUS.FINISHED;
    room.match = {
      ...room.match,
      finishedAt: this._timestamp(),
      result: {
        winnerIndex: result.winnerIndex ?? null,
        draw: Boolean(result.draw),
        players: result.players.map((player) => ({
          displayName: player.displayName,
          pts: player.pts,
          penalty: player.penalty,
          maxbrk: player.maxbrk,
          accuracy: player.accuracy,
        })),
      },
      rematch: [],
    };
    this._touch(room);
    return { state: this._publicState(room) };
  }

  /** Both seats must accept before a new frame replaces the finished one. */
  requestRematch({ roomId, playerId, token, matchId }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    if (room.status !== ROOM_STATUS.FINISHED) {
      throw new RoomError('room_not_finished', 'The frame has not finished');
    }
    if (room.match?.matchId !== matchId) {
      throw new RoomError('stale_match', 'matchId does not match the finished match');
    }
    if (!room.match.rematch.includes(playerId)) {
      room.match.rematch.push(playerId);
    }
    const accepted = room.match.rematch.length === room.seats.length;
    this._touch(room);
    return {
      state: this._publicState(room),
      accepted,
      acceptedPlayerIds: [...room.match.rematch],
    };
  }

  /** Replace a finished frame with a fresh one once both seats accepted. */
  startRematch({ roomId, playerId, token, matchId }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    if (room.status !== ROOM_STATUS.FINISHED) {
      throw new RoomError('room_not_finished', 'The frame has not finished');
    }
    if (room.match?.matchId !== matchId) {
      throw new RoomError('stale_match', 'matchId does not match the finished match');
    }
    if (room.match.rematch.length !== room.seats.length) {
      throw new RoomError('rematch_pending', 'Both players must accept a rematch');
    }
    room.status = ROOM_STATUS.PLAYING;
    room.match = {
      matchId: this._uuid(),
      protocolVersion: ROOM_PROTOCOL_VERSION,
      startedAt: this._timestamp(),
      previousMatchId: matchId,
    };
    this._touch(room);
    return { state: this._publicState(room), rematch: true };
  }

  abortStart({ roomId, playerId, token }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    if (room.status !== ROOM_STATUS.PLAYING) {
      throw new RoomError('room_not_playing', 'Room is not in the playing state');
    }
    room.status = room.seats.every((seat) => seat.ready && seat.connected)
      ? ROOM_STATUS.READY
      : ROOM_STATUS.WAITING;
    room.match = null;
    this._touch(room);
    return { state: this._publicState(room) };
  }

  /** Drop a room that nobody came back to. Used by the abandonment sweeper. */
  retire(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) {
      return false;
    }
    this._rooms.delete(roomId);
    return true;
  }

  disconnect({ roomId, playerId, token }) {
    const room = this._room(roomId);
    const seat = this._seat(room, playerId, token);
    seat.connected = false;
    if (room.status === ROOM_STATUS.READY) {
      room.status = ROOM_STATUS.WAITING;
    }
    this._touch(room);
    return { state: this._publicState(room) };
  }

  leave({ roomId, playerId, token }) {
    const room = this._room(roomId);
    const seat = this._seat(room, playerId, token);
    const index = room.seats.indexOf(seat);
    room.seats.splice(index, 1);
    if (room.seats.length === 0 || room.status === ROOM_STATUS.PLAYING) {
      this._rooms.delete(roomId);
      return { roomId, closed: true, state: null };
    }
    if (room.status === ROOM_STATUS.FINISHED) {
      // Leaving after a finished frame returns the room to the lobby.
      room.status = ROOM_STATUS.WAITING;
      room.match = null;
    }
    if (room.hostId === playerId) {
      room.hostId = room.seats[0].playerId;
    }
    room.status = ROOM_STATUS.WAITING;
    this._touch(room);
    return { roomId, closed: false, state: this._publicState(room) };
  }

  state({ roomId, playerId, token }) {
    const room = this._room(roomId);
    this._seat(room, playerId, token);
    return { state: this._publicState(room) };
  }
}

export function createRoomService(options) {
  return new RoomService(options);
}
