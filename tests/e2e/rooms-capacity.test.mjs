import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ROOT } from '../../config/project.config.mjs';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { CONNECTION_LIMITS } from '../../src/server/rooms/connection-health.mjs';

/**
 * Capacity probe. It measures how many rooms this machine can hold and how the
 * service behaves at the socket ceiling. It is not a benchmark of a deployment:
 * everything runs on one loopback process with no TLS.
 */
const output = path.join(ROOT, 'artifacts/testing/rooms-capacity');
const ROOM_TARGETS = [8, 24, 48];
const MAX_SOCKETS = CONNECTION_LIMITS.MAX_CONNECTIONS;

function connect(port, origin) {
  const socket = new WebSocket(
    'ws://127.0.0.1:' + port + '/rooms',
    origin ? { origin } : undefined,
  );
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
      const timer = setTimeout(() => reject(new Error('message timeout')), 15000);
      waiters.push((message) => {
        globalThis.clearTimeout(timer);
        resolve(message);
      });
    });
  const find = async (type) => {
    for (let index = 0; index < 60; index += 1) {
      const message = await next();
      if (message.type === type) {
        return message;
      }
    }
    throw new Error('never received ' + type);
  };
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    opened,
    next,
    find,
    send: (message) =>
      socket.send(JSON.stringify({ v: 1, requestId: 'c-' + Math.random(), ...message })),
    close: () => socket.close(),
  };
}

/** Create `count` rooms, each with a host and a joined guest. */
async function fillRooms(port, count) {
  const clients = [];
  for (let index = 0; index < count; index += 1) {
    const host = connect(port);
    await host.opened;
    await host.find('room.hello');
    host.send({
      type: 'room.create',
      displayName: 'H' + index,
      interior: 'interior-design-original',
    });
    const created = await host.find('room.created');
    const guest = connect(port);
    await guest.opened;
    await guest.find('room.hello');
    guest.send({ type: 'room.join', roomId: created.roomId, displayName: 'G' + index });
    const joined = await guest.find('room.joined');
    clients.push(host, guest, { roomId: created.roomId, playerId: joined.playerId });
  }
  return clients;
}

async function health(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/healthz');
  return response.json();
}

const report = {
  date: new Date().toISOString(),
  limits: { ...CONNECTION_LIMITS },
  samples: [],
  ceiling: null,
  passed: false,
  limitations: [
    'One loopback process, one machine, no TLS: these numbers size the local service, not a public deployment.',
    'Rooms are filled but no frame is started, so the cost measured is lobby state rather than live physics.',
    'Each live match owns a full physics world; starting many frames is the expensive path and is measured separately by the room count that stays responsive.',
  ],
};

try {
  for (const rooms of ROOM_TARGETS) {
    const server = createRoomServer({ port: 0, host: '127.0.0.1' });
    await server.listen();
    const port = server.address().port;
    const startedAt = process.hrtime.bigint();
    const clients = await fillRooms(port, rooms);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const snapshot = await health(port);
    const memoryMb = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
    // Every room must be visible and reachable through the health endpoint.
    assert.equal(snapshot.rooms, rooms, rooms + ' rooms are held');
    assert.equal(snapshot.connections, clients.length - rooms, 'every seat is bound');
    assert.equal(snapshot.sockets, clients.filter((c) => c.socket).length, 'all sockets are live');
    report.samples.push({
      rooms,
      sockets: snapshot.connections,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      roomsPerSecond: Number((rooms / (elapsedMs / 1000)).toFixed(1)),
      heapUsedMb: memoryMb,
    });
    for (const client of clients) {
      client.socket?.terminate();
    }
    await server.close();
  }

  // Live frames are the expensive path: every running match owns a physics
  // world. Start two rooms concurrently and measure the real cost.
  {
    const server = createRoomServer({ port: 0, host: '127.0.0.1' });
    await server.listen();
    const port = server.address().port;
    const rooms = [];
    for (let index = 0; index < 2; index += 1) {
      const host = connect(port);
      await host.opened;
      await host.find('room.hello');
      host.send({
        type: 'room.create',
        displayName: 'LH' + index,
        interior: 'interior-design-original',
      });
      const created = await host.find('room.created');
      const seat = { roomId: created.roomId, playerId: created.playerId, token: created.token };
      const guest = connect(port);
      await guest.opened;
      await guest.find('room.hello');
      guest.send({ type: 'room.join', roomId: created.roomId, displayName: 'LG' + index });
      const joined = await guest.find('room.joined');
      const guestSeat = { roomId: joined.roomId, playerId: joined.playerId, token: joined.token };
      host.send({ type: 'room.ready', ...seat, ready: true });
      guest.send({ type: 'room.ready', ...guestSeat, ready: true });
      for (let wait = 0; wait < 60; wait += 1) {
        if (server.service.state(seat).state.status === 'ready') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      rooms.push({ host, guest, seat });
    }
    const startedAt = process.hrtime.bigint();
    for (const room of rooms) {
      room.host.send({ type: 'room.start', ...room.seat });
    }
    for (const room of rooms) {
      await room.host.find('match.snapshot');
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const snapshot = await health(port);
    report.liveFrames = {
      rooms: rooms.length,
      startMs: Number(elapsedMs.toFixed(1)),
      matches: snapshot.matches,
      heapUsedMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    };
    assert.equal(snapshot.matches, rooms.length, 'every started room owns a match');
    for (const room of rooms) {
      room.host.socket.terminate();
      room.guest.socket.terminate();
    }
    await server.close();
  }

  // Push past the socket ceiling and confirm the service refuses politely.
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  const port = server.address().port;
  const sockets = [];
  for (let index = 0; index < MAX_SOCKETS; index += 1) {
    const client = connect(port);
    try {
      await client.opened;
    } catch {
      break;
    }
    sockets.push(client);
  }
  assert.equal(sockets.length, MAX_SOCKETS, 'the server accepts up to its stated capacity');
  const extra = connect(port);
  // The handshake itself is refused, so the client reports an error instead of
  // ever becoming an open socket.
  const refused = await extra.opened.then(
    () => 'open',
    (error) => error.message,
  );
  report.ceiling = { accepted: sockets.length, extra: refused };
  assert.notEqual(refused, 'open', 'the socket beyond the ceiling is not accepted');
  const atCeiling = await health(port);
  assert.equal(atCeiling.sockets, MAX_SOCKETS, 'the health endpoint reports the ceiling');
  for (const client of sockets) {
    client.socket.terminate();
  }
  extra.socket.terminate();
  await server.close();

  report.passed = true;
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'rooms-capacity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-capacity/rooms-capacity.json');
  for (const sample of report.samples) {
    console.log(
      sample.rooms +
        ' rooms / ' +
        sample.sockets +
        ' sockets in ' +
        sample.elapsedMs +
        ' ms (' +
        sample.roomsPerSecond +
        ' rooms/s), heap ' +
        sample.heapUsedMb +
        ' MB',
    );
  }
  console.log('ceiling', JSON.stringify(report.ceiling));
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'rooms-capacity.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
