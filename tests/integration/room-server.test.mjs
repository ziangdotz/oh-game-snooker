import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = this.waiters.find((candidate) => candidate.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  send(message) {
    this.socket.send(JSON.stringify({ v: 1, ...message }));
  }

  waitFor(predicate, timeout = 5000) {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((candidate) => candidate.timer === timer),
          1,
        );
        reject(new Error('Timed out waiting for room message'));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  close() {
    this.socket.terminate();
    return Promise.resolve();
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new TestClient(socket);
}

test('room server creates, joins, starts and resumes over WebSocket', async () => {
  const server = createRoomServer({ port: 0, host: '127.0.0.1' });
  await server.listen();
  const port = server.address().port;
  const url = 'ws://127.0.0.1:' + port + '/rooms';
  const host = await connect(url);
  const guest = await connect(url);
  try {
    host.send({ type: 'room.create', requestId: 'create-1', displayName: 'Host' });
    const created = await host.waitFor(
      (message) => message.type === 'room.created' && message.requestId === 'create-1',
    );
    assert.match(created.roomId, /^[A-Z0-9]{6}$/);
    assert.equal(created.state.seats.length, 1);

    guest.send({
      type: 'room.join',
      requestId: 'join-1',
      roomId: created.roomId,
      displayName: 'Guest',
    });
    const joined = await guest.waitFor(
      (message) => message.type === 'room.joined' && message.requestId === 'join-1',
    );
    assert.equal(joined.state.seats.length, 2);

    host.send({
      type: 'room.ready',
      requestId: 'ready-host',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      ready: true,
    });
    guest.send({
      type: 'room.ready',
      requestId: 'ready-guest',
      roomId: joined.roomId,
      playerId: joined.playerId,
      token: joined.token,
      ready: true,
    });
    const ready = await host.waitFor(
      (message) => message.type === 'room.state' && message.state.status === 'ready',
    );
    assert.equal(
      ready.state.seats.every((seat) => seat.ready),
      true,
    );
    assert.ok(ready.state.revision > created.state.revision);

    host.send({
      type: 'room.start',
      requestId: 'start-1',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
    });
    const started = await host.waitFor(
      (message) => message.type === 'room.state' && message.state.status === 'playing',
    );
    assert.equal(started.state.match.protocolVersion, 1);
    assert.ok(started.state.revision > ready.state.revision);

    const resumed = await connect(url);
    try {
      resumed.send({
        type: 'room.resume',
        requestId: 'resume-1',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
      });
      const resumedMessage = await resumed.waitFor(
        (message) => message.type === 'room.resumed' && message.requestId === 'resume-1',
      );
      assert.equal(resumedMessage.state.status, 'playing');
      assert.equal(
        resumedMessage.state.seats.find((seat) => seat.playerId === joined.playerId).connected,
        true,
      );
      const state = await resumed.waitFor(
        (message) =>
          message.type === 'room.state' &&
          message.state.seats.find((seat) => seat.playerId === joined.playerId)?.connected === true,
      );
      assert.equal(state.state.status, 'playing');

      // Closing the replaced transport must not mark the resumed seat offline.
      await guest.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      resumed.send({
        type: 'room.state',
        requestId: 'state-after-old-close',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
      });
      const afterOldClose = await resumed.waitFor(
        (message) => message.type === 'room.state' && message.requestId === 'state-after-old-close',
      );
      assert.equal(
        afterOldClose.state.seats.find((seat) => seat.playerId === joined.playerId).connected,
        true,
      );
      assert.equal(afterOldClose.state.status, 'playing');
    } finally {
      await resumed.close();
    }
  } finally {
    await host.close();
    await guest.close();
    await server.close();
  }
});
