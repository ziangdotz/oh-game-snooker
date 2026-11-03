import createRoomClient from './room-client.js';

/**
 * Owns the online room connection and the seat credential.
 * The room state is always the authoritative one received from the service;
 * nothing here derives match results.
 */
export default function createRoomSession(host, options = {}) {
  const STORAGE_KEY = 'oh-my-snooker:room-seat';
  const EventEmitter = options.eventEmitter;
  const emitter = EventEmitter ? new (EventEmitter.a ?? EventEmitter)() : null;
  // Command promises and lastError retain service errors while no controller
  // owns the connection during a screen transition.
  emitter?.on('error', () => {});
  const client = createRoomClient(host, options);
  let seat = readSeat();
  let lastError = null;

  function readSeat() {
    try {
      const value = JSON.parse(host.sessionStorage.getItem(STORAGE_KEY));
      if (
        value?.version === 1 &&
        typeof value.roomId === 'string' &&
        /^[A-Z0-9]{6}$/u.test(value.roomId) &&
        typeof value.playerId === 'string' &&
        typeof value.token === 'string'
      ) {
        return { roomId: value.roomId, playerId: value.playerId, token: value.token };
      }
    } catch {
      // Disabled or corrupt storage simply means there is no seat to resume.
    }
    return null;
  }

  function persist(next) {
    seat = next;
    try {
      if (next) {
        host.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...next }));
      } else {
        host.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // The in-memory seat still works when storage is unavailable.
    }
  }

  function notify(event, payload) {
    if (emitter) {
      emitter.emit(event, payload);
    }
  }

  client.on('state', (state) => notify('state', state));
  client.on('snapshot', (message) => notify('snapshot', message));
  client.on('finished', (message) => notify('finished', message));
  client.on('rematch', (message) => notify('rematch', message));
  client.on('open', () => notify('open'));
  client.on('close', (event) => notify('close', event));
  client.on('identity', (identity) => {
    persist(identity);
    notify('identity', identity);
  });
  client.on('left', (message) => {
    persist(null);
    notify('left', message);
  });
  client.on('closed', (message) => {
    persist(null);
    notify('closed', message);
  });
  client.on('error', (error) => {
    lastError = error;
    notify('error', error);
  });

  return {
    client,
    on(event, handler) {
      if (!emitter) {
        return () => {};
      }
      emitter.on(event, handler);
      return () => emitter.removeListener(event, handler);
    },
    get seat() {
      return seat;
    },
    get state() {
      return client.state;
    },
    get snapshot() {
      return client.snapshot;
    },
    get lastError() {
      return lastError;
    },
    get connected() {
      return client.connected;
    },
    get endpoint() {
      return client.endpoint;
    },
    get hasStoredSeat() {
      return Boolean(seat);
    },
    async connect() {
      await client.open();
      return client.hello;
    },
    async createRoom({ displayName, interior }) {
      await client.open();
      const message = await client.send({ type: 'room.create', displayName, interior });
      persist({
        roomId: message.roomId,
        playerId: message.playerId,
        token: message.token,
      });
      return message;
    },
    async joinRoom({ roomId, displayName }) {
      await client.open();
      const message = await client.send({ type: 'room.join', roomId, displayName });
      persist({
        roomId: message.roomId,
        playerId: message.playerId,
        token: message.token,
      });
      return message;
    },
    async resume() {
      if (!seat) {
        throw Object.assign(new Error('There is no saved room seat'), {
          code: 'no_saved_seat',
        });
      }
      await client.open();
      try {
        return await client.resume(seat);
      } catch (error) {
        if (['room_not_found', 'unauthorized', 'room_unavailable'].includes(error.code)) {
          persist(null);
        }
        throw error;
      }
    },
    setReady(ready) {
      return client.send({ type: 'room.ready', ready });
    },
    startMatch() {
      return client.send({ type: 'room.start' });
    },
    async leave() {
      try {
        if (!seat) {
          return null;
        }
        return await client.send({ type: 'room.leave' });
      } finally {
        persist(null);
        client.close();
      }
    },
    requestState() {
      return client.send({ type: 'room.state' });
    },
    placeCueBall(command) {
      return client.send({ type: 'match.place', ...command });
    },
    shoot(command) {
      return client.send({ type: 'match.shot', ...command });
    },
    requestSnapshot(matchId) {
      return client.send({ type: 'match.state', matchId });
    },
    requestRematch(matchId) {
      return client.send({ type: 'match.rematch', matchId });
    },
    disconnect() {
      client.close();
    },
    forgetSeat() {
      persist(null);
    },
  };
}
