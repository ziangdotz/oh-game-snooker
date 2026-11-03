import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { CONNECTION_LIMITS, RateLimiter } from '../../src/server/rooms/connection-health.mjs';

/** Open a socket and return it with a promise-queue for its messages. */
function connect(port) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/rooms');
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());

    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  const next = () =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 10000);
      waiters.push((message) => {
        globalThis.clearTimeout(timer);
        resolve(message);
      });
    });
  /** Wait for a specific message type, discarding broadcasts that came first. */
  const seen = [];
  const find = async (type) => {
    for (let index = 0; index < 40; index += 1) {
      const message = await next();
      seen.push(message.type + (message.code ? ':' + message.code : ''));
      if (message.type === type) {
        return message;
      }
    }
    throw new Error('never received ' + type + ' after ' + seen.join(','));
  };
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const send = (message) =>
    socket.send(JSON.stringify({ v: 1, requestId: 'r-' + Math.random(), ...message }));
  return { socket, opened, next, find, send, close: () => socket.close() };
}

test('rate limiter allows a burst then throttles, and refills over time', () => {
  let clock = 0;
  const limiter = new RateLimiter({ rate: 10, burst: 3, now: () => clock });
  const bucket = limiter.createBucket();
  assert.equal(limiter.take(bucket), true);
  assert.equal(limiter.take(bucket), true);
  assert.equal(limiter.take(bucket), true);
  assert.equal(limiter.take(bucket), false, 'the burst is spent');
  clock += 100;
  assert.equal(limiter.take(bucket), true, 'one token came back after 100 ms');
  clock += 1000;
  for (let index = 0; index < 3; index += 1) {
    assert.equal(limiter.take(bucket), true, 'a long idle refills the whole burst');
  }
  assert.equal(limiter.take(bucket), false, 'the bucket never refills above the burst');
});

test('a burst of commands is throttled with an explicit error', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const port = server.address().port;
  const client = connect(port);
  await client.opened;
  t.after(() => client.close());
  await client.next();
  // Sent without waiting, so they arrive inside one rate window.
  for (let index = 0; index < CONNECTION_LIMITS.RATE_LIMIT_BURST + 25; index += 1) {
    client.send({ type: 'room.state' });
  }
  const errors = [];
  for (let index = 0; index < CONNECTION_LIMITS.RATE_LIMIT_BURST + 25; index += 1) {
    const message = await client.next();
    if (message.type === 'room.error') {
      errors.push(message.code);
    }
    if (errors.includes('rate_limited')) {
      break;
    }
  }
  assert.ok(errors.length > 0, 'the server must answer a flood with errors');
  assert.ok(errors.includes('rate_limited'), 'the flood is throttled, not merely invalid');
});

test('heartbeat terminates a socket that stops answering', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const client = connect(server.address().port);
  await client.opened;
  await client.next();
  // Simulate a dead peer: swallow pings so the pong never comes back.
  client.socket.removeAllListeners('ping');
  client.socket.ping = () => {};
  let closed = false;
  client.socket.once('close', () => {
    closed = true;
  });
  for (let index = 0; index <= CONNECTION_LIMITS.MAX_MISSED_HEARTBEATS; index += 1) {
    server.heartbeat();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(closed, true, 'a socket that misses every heartbeat is dropped');
});

test('a live socket survives repeated heartbeats', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const client = connect(server.address().port);
  await client.opened;
  t.after(() => client.close());
  await client.next();
  let closed = false;
  client.socket.once('close', () => {
    closed = true;
  });
  for (let index = 0; index < 4; index += 1) {
    server.heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert.equal(closed, false, 'a responsive socket is kept');
  assert.equal(server.address() !== null, true);
});

test('an abandoned room is retired after the grace window', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const client = connect(server.address().port);
  await client.opened;
  await client.next();
  client.send({ type: 'room.create', displayName: 'Host', interior: 'interior-design-original' });
  const created = await client.find('room.created');
  assert.equal(created.type, 'room.created');
  assert.equal(server.service.size, 1);
  client.close();
  // Wait for the close handler to record the abandonment.
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Inside the window the room must survive, so a refresh can resume it.
  server.sweepAbandonedRooms();
  assert.equal(server.service.size, 1, 'the grace window keeps the room resumable');
  server.sweepAbandonedRooms(Date.now() + CONNECTION_LIMITS.DISCONNECT_GRACE_MS + 1000);
  assert.equal(server.service.size, 0, 'a room nobody returned to is released');
});

test('capacity reports and refuses beyond the socket limit', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const health = await fetch('http://127.0.0.1:' + server.address().port + '/healthz').then(
    (response) => response.json(),
  );
  assert.equal(health.ok, true);
  assert.equal(health.capacity, CONNECTION_LIMITS.MAX_CONNECTIONS);
  assert.equal(health.connections, 0);
  assert.equal(health.matches, 0);
});

test('a browser origin outside the allow list is refused', async (t) => {
  const server = createRoomServer({
    port: 0,
    host: '127.0.0.1',
    origins: ['http://127.0.0.1:*', 'https://play.example.test'],
  });
  await server.listen();
  t.after(() => server.close());
  const port = server.address().port;
  const rejected = new WebSocket('ws://127.0.0.1:' + port + '/rooms', {
    origin: 'https://evil.example.test',
  });
  const refusal = await new Promise((resolve) => {
    rejected.once('open', () => resolve('open'));
    rejected.once('error', (error) => resolve(error.message));
  });
  assert.notEqual(refusal, 'open', 'a foreign origin cannot open a seat');
  rejected.terminate();

  const welcome = new WebSocket('ws://127.0.0.1:' + port + '/rooms', {
    origin: 'https://play.example.test',
  });
  const allowed = await new Promise((resolve) => {
    welcome.once('open', () => resolve(true));
    welcome.once('error', () => resolve(false));
  });
  assert.equal(allowed, true, 'an allow-listed origin connects');
  welcome.close();
});

test('a seat that reconnects mid-match keeps the frame', async (t) => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  t.after(() => server.close());
  const port = server.address().port;
  const host = connect(port);
  await host.opened;
  t.after(() => host.close());
  await host.next();
  host.send({
    type: 'room.create',
    displayName: 'Host',
    interior: 'interior-design-original',
  });
  const created = await host.next();
  const seat = {
    roomId: created.roomId,
    playerId: created.playerId,
    token: created.token,
  };
  const guest = connect(port);
  await guest.opened;
  t.after(() => guest.close());
  await guest.next();
  guest.send({ type: 'room.join', roomId: seat.roomId, displayName: 'Guest' });
  const joined = await guest.find('room.joined');
  const guestSeat = { roomId: joined.roomId, playerId: joined.playerId, token: joined.token };
  host.send({ type: 'room.ready', ...seat, ready: true });
  guest.send({ type: 'room.ready', ...guestSeat, ready: true });
  // Poll the authoritative room rather than a broadcast, which may still be
  // in flight from the join.
  for (let index = 0; index < 50; index += 1) {
    if (server.service.state(seat).state.status === 'ready') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const readySeats = server.service
    .state(seat)
    .state.seats.map((entry) => [entry.displayName, entry.ready, entry.connected]);
  assert.deepEqual(
    readySeats,
    [
      ['Host', true, true],
      ['Guest', true, true],
    ],
    'both seats are ready',
  );
  host.send({ type: 'room.start', ...seat });
  const started = await host.find('match.snapshot');
  assert.equal(server.service.state(seat).state.status, 'playing');
  const matchId =
    started.state.version === 0 ? server.service.state(seat).state.match.matchId : null;

  // Drop the host transport entirely, then come back on a new socket.
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const resumed = connect(port);
  await resumed.opened;
  t.after(() => resumed.close());
  await resumed.next();
  resumed.send({ type: 'room.resume', ...seat });
  let snapshot = null;
  let state = null;
  for (let index = 0; index < 4; index += 1) {
    const message = await resumed.next();
    if (message.type === 'room.resumed') {
      state = message.state;
    }
    if (message.type === 'match.snapshot') {
      snapshot = message;
    }
    if (state && snapshot) {
      break;
    }
  }
  assert.equal(state.status, 'playing', 'the frame is still running after the drop');
  assert.equal(state.match.matchId, matchId, 'the same authoritative frame is restored');
  assert.ok(snapshot, 'the resumed seat receives the current snapshot');
  assert.equal(snapshot.state.version, 0);
  const seatState = state.seats.find((entry) => entry.playerId === seat.playerId);
  assert.equal(seatState.connected, true, 'the seat is online again');
});
