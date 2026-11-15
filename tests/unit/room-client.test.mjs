import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import roomProtocolFactory from '../../src/shared/net/room-protocol.js';
import createRoomClient from '../../src/infrastructure/net/room-client.js';
import createRoomSession from '../../src/infrastructure/net/room-session.js';

const protocol = roomProtocolFactory();

/** In-memory WebSocket double: records sends and lets the test push replies. */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
    Promise.resolve().then(() => {
      this.readyState = 1;
      this._emit('open', {});
    });
  }

  addEventListener(event, handler) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  removeEventListener(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      handler(payload);
    }
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error('socket is not open');
    }
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this._emit('close', { code, reason });
  }

  /** Simulate the service: mark open and deliver a decoded message. */
  opened() {
    this.readyState = 1;
    this._emit('open', {});
    return this;
  }

  reply(message) {
    this.readyState = 1;
    this._emit('message', { data: JSON.stringify(message) });
    return this;
  }
}

function createHost() {
  const timers = new Map();
  let id = 0;
  return {
    WebSocket: FakeSocket,
    location: { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:5173' },
    sessionStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key, value) {
        this.store.set(key, value);
      },
      removeItem(key) {
        this.store.delete(key);
      },
    },
    setTimeout(callback) {
      id += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((callback) => callback());
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

async function waitForSocket() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = FakeSocket.instances.at(-1);
    if (socket) {
      return socket;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('No WebSocket instance was created');
}

test('room protocol shares room-code normalization with the browser', () => {
  assert.deepEqual(protocol.normalizeRoomCode(' abc 234 '), { ok: true, value: 'ABC234' });
  assert.deepEqual(protocol.normalizeRoomCode('abc-234'), { ok: true, value: 'ABC234' });
  assert.equal(protocol.normalizeRoomCode('ABC23').ok, false);
  assert.equal(protocol.formatRoomCode('ABC234'), 'ABC 234');
  assert.equal(protocol.validateRoomId('ABC234'), true);
  assert.equal(protocol.validateRoomId('abc234'), false);
});

test('room client correlates responses and keeps the newest authoritative state', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  const client = createRoomClient(host, { reconnectDelays: [] });
  const states = [];
  const snapshots = [];
  client.on('state', (state) => states.push(state.revision));
  client.on('snapshot', (message) => snapshots.push(message.state.version));

  const opening = client.open();
  const socket = await waitForSocket();
  socket.opened();
  await opening;
  assert.equal(client.connected, true);

  const creating = client.send({ type: 'room.create', displayName: 'Host' });
  const request = socket.sent.at(-1);
  assert.equal(request.type, 'room.create');
  assert.match(request.requestId, /^room\.create-/);
  socket.reply({
    type: 'room.created',
    requestId: request.requestId,
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
    state: { roomId: 'ABC234', status: 'waiting', revision: 1 },
  });
  const created = await creating;
  assert.equal(created.roomId, 'ABC234');
  assert.deepEqual(client.identity, {
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
  });
  assert.equal(client.state.revision, 1);
  socket.reply({ type: 'room.state', state: { revision: 0 } });
  assert.deepEqual(states, [1], 'creation establishes the ordering baseline');

  // Later requests carry the bound seat identity.
  const ready = client.send({ type: 'room.ready', ready: true });
  assert.equal(socket.sent.at(-1).playerId, 'player-1');
  socket.reply({
    type: 'room.state',
    requestId: socket.sent.at(-1).requestId,
    state: { revision: 2 },
  });
  await ready;
  assert.deepEqual(states, [1, 2]);

  // Out-of-order revisions are ignored, so an old panel state cannot win.
  socket.reply({ type: 'room.state', state: { revision: 1 } });
  socket.reply({ type: 'room.state', state: { revision: 3 } });
  assert.deepEqual(states, [1, 2, 3]);

  socket.reply({ type: 'match.snapshot', state: { version: 2 }, snapshot: { schemaVersion: 1 } });
  socket.reply({ type: 'match.snapshot', state: { version: 1 }, snapshot: { schemaVersion: 1 } });
  assert.deepEqual(snapshots, [2]);

  client.close();
  assert.equal(client.connected, false);
});

test('room client accepts a new frame at version zero and ignores the previous frame', async () => {
  const client = createRoomClient(createHost(), { reconnectDelays: [] });
  await client.open();
  const socket = FakeSocket.instances.at(-1);
  const received = [];
  client.on('snapshot', (message) => received.push(message.matchId));
  socket.reply({ type: 'room.state', state: { revision: 1, match: { matchId: 'first' } } });
  socket.reply({ type: 'match.snapshot', matchId: 'first', state: { version: 10 }, snapshot: {} });
  socket.reply({ type: 'room.state', state: { revision: 2, match: { matchId: 'second' } } });
  socket.reply({
    type: 'match.snapshot',
    event: 'rematch',
    matchId: 'second',
    state: { version: 0 },
    snapshot: {},
  });
  socket.reply({
    type: 'match.snapshot',
    event: 'finished',
    matchId: 'first',
    state: { version: 11 },
    snapshot: {},
  });
  assert.deepEqual(received, ['first', 'second']);
  assert.equal(client.snapshot.matchId, 'second');
  assert.equal(client.snapshot.state.version, 0);
  client.close();
});

test('a replaced room connection never attempts to reclaim the same seat', async () => {
  const host = createHost();
  const client = createRoomClient(host);
  await client.open();
  const count = FakeSocket.instances.length;
  FakeSocket.instances.at(-1).close(4001, 'session replaced');
  host.flushTimers();
  await Promise.resolve();
  assert.equal(FakeSocket.instances.length, count);
  assert.equal(client.connected, false);
  client.close();
});

test('closing during connection rejects all open callers and permits retry', async () => {
  const host = createHost();
  const client = createRoomClient(host);
  const first = client.open();
  const second = client.open();
  const rejected = Promise.all([
    assert.rejects(first, (error) => error.code === 'connection_closed'),
    assert.rejects(second, (error) => error.code === 'connection_closed'),
  ]);
  client.close();
  await rejected;
  await client.open();
  assert.equal(client.connected, true);
  assert.equal(host.pendingTimers, 0);
  client.close();
});

test('room client rejects requests that are not answered', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  const client = createRoomClient(host, { reconnectDelays: [] });
  const opening = client.open();
  const socket = await waitForSocket();
  socket.opened();
  await opening;

  const pending = client.send({ type: 'room.state' });
  socket.close(1006, 'transport lost');
  await assert.rejects(pending, (error) => error.code === 'connection_closed');
  assert.equal(client.connected, false);
});

test('room client surfaces protocol errors with their service code', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  const client = createRoomClient(host, { reconnectDelays: [] });
  const opening = client.open();
  const socket = await waitForSocket();
  socket.opened();
  await opening;

  const joining = client.send({ type: 'room.join', roomId: 'ZZZZZZ', displayName: 'Guest' });
  socket.reply({
    type: 'room.error',
    requestId: socket.sent.at(-1).requestId,
    code: 'room_not_found',
    message: 'Room not found',
  });
  await assert.rejects(joining, (error) => error.code === 'room_not_found');
});

test('room session persists its seat and clears it when the room is left', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  const session = createRoomSession(host, {
    reconnectDelays: [],
    eventEmitter: class {
      constructor() {
        this.events = [];
      }
      on(event, handler) {
        this.events.push([event, handler]);
      }
      emit(event, payload) {
        for (const [name, handler] of this.events) {
          if (name === event) {
            handler(payload);
          }
        }
      }
      removeListener() {}
    },
  });
  const creating = session.createRoom({
    displayName: 'Host',
    interior: 'interior-design-original',
  });
  const socket = await waitForSocket();
  socket.opened();
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.reply({
    type: 'room.created',
    requestId: socket.sent.at(-1).requestId,
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
    state: { roomId: 'ABC234', status: 'waiting', revision: 1, seats: [] },
  });
  await creating;
  assert.deepEqual(session.seat, {
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
  });
  assert.match(host.sessionStorage.getItem('oh-game-snooker:room-seat'), /token-12345678/);

  const leaving = session.leave();
  socket.reply({ type: 'room.left', requestId: socket.sent.at(-1).requestId, closed: false });
  await leaving;
  assert.equal(session.seat, null);
  assert.equal(host.sessionStorage.getItem('oh-game-snooker:room-seat'), null);
});

test('room session restores a saved seat on resume and drops a stale one', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  host.sessionStorage.setItem(
    'oh-game-snooker:room-seat',
    JSON.stringify({
      version: 1,
      roomId: 'ABC234',
      playerId: 'player-1',
      token: 'token-12345678',
    }),
  );
  const session = createRoomSession(host, { reconnectDelays: [] });
  assert.equal(session.hasStoredSeat, true);

  const resuming = session.resume();
  const socket = await waitForSocket();
  socket.opened();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = socket.sent.at(-1);
  assert.equal(request.type, 'room.resume');
  assert.equal(request.roomId, 'ABC234');
  socket.reply({
    type: 'room.resumed',
    requestId: request.requestId,
    state: { roomId: 'ABC234', status: 'playing', revision: 4, seats: [] },
  });
  await resuming;
  assert.equal(session.state.status, 'playing');

  const failing = session.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.reply({
    type: 'room.error',
    requestId: socket.sent.at(-1).requestId,
    code: 'room_not_found',
    message: 'Room not found',
  });
  await assert.rejects(failing, (error) => error.code === 'room_not_found');
  assert.equal(session.seat, null);
});

test('room session retains errors between controllers and skips leaving an absent seat', async () => {
  FakeSocket.instances.length = 0;
  const host = createHost();
  const session = createRoomSession(host, { eventEmitter: EventEmitter, reconnectDelays: [] });
  const creating = session.createRoom({ displayName: 'Host' });
  const rejected = assert.rejects(creating, (error) => error.code === 'invalid_name');
  const socket = await waitForSocket();
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.reply({
    type: 'room.error',
    requestId: socket.sent.at(-1).requestId,
    code: 'invalid_name',
    message: 'Display name rejected',
  });
  await rejected;
  assert.equal(session.lastError.code, 'invalid_name');
  const sent = socket.sent.length;
  assert.equal(await session.leave(), null);
  assert.equal(socket.sent.length, sent, 'no unauthorized leave command is sent');
});
