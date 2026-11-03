/**
 * Browser transport for the room protocol.
 * Owns request/response correlation, revision ordering and reconnect attempts;
 * it never interprets gameplay state beyond the last authoritative message.
 */
export default function createRoomClient(host, options = {}) {
  const WebSocketImpl = options.WebSocket || host.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('RoomClient requires a WebSocket implementation');
  }
  const requestTimeout = options.requestTimeout ?? 15000;
  const reconnectDelays = options.reconnectDelays ?? [0, 250, 1000, 2500, 5000];

  function defaultEndpoint(location) {
    const secure = location?.protocol === 'https:';
    const scheme = secure ? 'wss://' : 'ws://';
    // The room service is a separate local process; the game page keeps its own origin.
    const hostname = location?.hostname || '127.0.0.1';
    return scheme + hostname + ':8787/rooms';
  }

  const endpoint = options.endpoint || defaultEndpoint(host.location);
  const listeners = new Map();
  let socket = null;
  let pending = new Map();
  let sequence = 0;
  let identity = null;
  let state = null;
  let snapshot = null;
  let closedByUs = false;
  let reconnectIndex = 0;
  let reconnectTimer = null;
  let connecting = null;
  let cancelConnecting = null;
  let hello = null;

  function on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (set) {
      for (const handler of [...set]) {
        handler(payload);
      }
    }
  }

  function rejectAll(code, message) {
    for (const [, entry] of pending) {
      host.clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(message), { code }));
    }
    pending = new Map();
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      emit('error', { code: 'invalid_json', message: 'Malformed room message' });
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return;
    }
    // A correlated reply settles its request first, then still updates the
    // authoritative state the panel renders from.
    if (message.requestId && pending.has(message.requestId)) {
      const entry = pending.get(message.requestId);
      pending.delete(message.requestId);
      host.clearTimeout(entry.timer);
      if (message.type === 'room.error') {
        entry.reject(Object.assign(new Error(message.message), { code: message.code }));
        emit('error', { code: message.code, message: message.message });
        return;
      }
      entry.resolve(message);
    }
    applyMessage(message);
  }

  function applyMessage(message) {
    if (message.type === 'room.hello') {
      hello = message;
      emit('hello', message);
      return;
    }
    if (message.type === 'room.created' || message.type === 'room.joined') {
      identity = {
        roomId: message.roomId,
        playerId: message.playerId,
        token: message.token,
      };
      state = message.state;
      snapshot = null;
      emit('identity', identity);
      emit('state', state);
      return;
    }
    if (message.type === 'room.state' && message.state) {
      if (!state || message.state.revision >= state.revision) {
        const matchId = message.state.match?.matchId;
        if (matchId !== state?.match?.matchId) {
          snapshot = null;
        }
        state = message.state;
        emit('state', state);
      }
      return;
    }
    if (message.type === 'match.snapshot' && message.snapshot) {
      if (message.matchId && state?.match?.matchId && message.matchId !== state.match.matchId) {
        return;
      }
      const incoming = message.state?.version ?? 0;
      const current = snapshot?.state?.version ?? -1;
      if (incoming < current) {
        return;
      }
      if (incoming >= current) {
        snapshot = message;
        emit('snapshot', message);
      }
      // A finished or rematched frame is a lifecycle event the controller needs
      // even when an equal-version snapshot was already applied.
      if (message.event === 'finished' || message.event === 'rematch') {
        emit(message.event, message);
      }
      return;
    }
    if (message.type === 'room.left' || message.type === 'room.closed') {
      identity = null;
      state = null;
      snapshot = null;
      if (message.type === 'room.closed') {
        rejectAll('room_closed', 'The room has closed');
        emit('closed', message);
      } else {
        emit('left', message);
      }
      return;
    }
    if (message.type === 'room.resumed') {
      if (message.state) {
        state = message.state;
        emit('state', state);
      }
      emit('resumed', message);
      return;
    }
    if (message.type === 'room.error') {
      emit('error', { code: message.code, message: message.message });
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || reconnectIndex >= reconnectDelays.length) {
      return;
    }
    const delay = reconnectDelays[reconnectIndex];
    reconnectIndex += 1;
    reconnectTimer = host.setTimeout(() => {
      reconnectTimer = null;
      open()
        .then(() => {
          if (identity) {
            return send({ type: 'room.resume' }).catch(() => null);
          }
          return null;
        })
        .catch(() => scheduleReconnect());
    }, delay);
  }

  function open() {
    if (connecting) {
      return connecting;
    }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      return Promise.resolve();
    }
    closedByUs = false;
    const attempt = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cancelConnecting = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      cancelConnecting = settle;
      let current;
      try {
        current = new WebSocketImpl(endpoint);
      } catch (error) {
        settle(
          Object.assign(new Error('Unable to open the room connection'), {
            code: 'connect_failed',
            cause: error,
          }),
        );
        return;
      }
      socket = current;
      current.addEventListener('open', () => {
        if (socket !== current) {
          return;
        }
        reconnectIndex = 0;
        emit('open');
        settle(null);
      });
      current.addEventListener('message', (event) => {
        if (socket === current) {
          handleMessage(event.data);
        }
      });
      current.addEventListener('error', () => {
        if (!settled) {
          settle(Object.assign(new Error('Room connection failed'), { code: 'connect_failed' }));
        }
      });
      current.addEventListener('close', (event) => {
        if (socket !== current) {
          return;
        }
        socket = null;
        rejectAll('connection_closed', 'The room connection closed');
        if (!settled) {
          settle(Object.assign(new Error('Room connection closed'), { code: 'connect_failed' }));
        }
        emit('close', { code: event?.code ?? 0, reason: event?.reason ?? '' });
        if (!closedByUs && event?.code !== 4001) {
          scheduleReconnect();
        }
      });
    });
    connecting = attempt;
    return attempt.finally(() => {
      if (connecting === attempt) {
        connecting = null;
      }
    });
  }

  function send(message) {
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(
        Object.assign(new Error('The room connection is not open'), { code: 'not_connected' }),
      );
    }
    sequence += 1;
    const requestId =
      message.requestId || message.type + '-' + sequence + '-' + Date.now().toString(36);
    const payload = {
      v: 1,
      ...message,
      requestId,
      ...(identity || {}),
    };
    const promise = new Promise((resolve, reject) => {
      const timer = host.setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error('Room request timed out'), { code: 'request_timeout' }));
      }, requestTimeout);
      pending.set(requestId, { resolve, reject, timer });
    });
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      const entry = pending.get(requestId);
      if (entry) {
        host.clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      return Promise.reject(
        Object.assign(new Error('Unable to send the room request'), { code: 'send_failed' }),
      );
    }
    return promise;
  }

  function close() {
    closedByUs = true;
    cancelConnecting?.(
      Object.assign(new Error('Room connection closed'), { code: 'connection_closed' }),
    );
    if (reconnectTimer !== null) {
      host.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    rejectAll('connection_closed', 'The room connection closed');
    const current = socket;
    socket = null;
    identity = null;
    state = null;
    snapshot = null;
    if (current && (current.readyState === 0 || current.readyState === 1)) {
      current.close(1000, 'client closed');
    }
  }

  return {
    endpoint,
    on,
    open,
    send,
    close,
    get connected() {
      return Boolean(socket && socket.readyState === 1);
    },
    get hello() {
      return hello;
    },
    get identity() {
      return identity;
    },
    get state() {
      return state;
    },
    get snapshot() {
      return snapshot;
    },
    resume(seat) {
      identity = { roomId: seat.roomId, playerId: seat.playerId, token: seat.token };
      return send({ type: 'room.resume' });
    },
    leave() {
      return send({ type: 'room.leave' });
    },
  };
}
