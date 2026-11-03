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
        globalThis.clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  send(message) {
    this.socket.send(JSON.stringify({ v: 1, ...message }));
  }

  waitFor(predicate, timeout = 15000) {
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
        reject(
          new Error(
            'Timed out waiting for room message; buffered=' +
              JSON.stringify(
                this.messages.map((message) => message.type + ':' + (message.code || '')),
              ),
          ),
        );
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

test('server match accepts a placed cue ball and a real physical shot for both clients', async () => {
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
    guest.send({
      type: 'room.join',
      requestId: 'join-1',
      roomId: created.roomId,
      displayName: 'Guest',
    });
    const joined = await guest.waitFor(
      (message) => message.type === 'room.joined' && message.requestId === 'join-1',
    );
    for (const [client, identity] of [
      [host, created],
      [guest, joined],
    ]) {
      client.send({
        type: 'room.ready',
        requestId: 'ready-' + identity.playerId,
        roomId: created.roomId,
        playerId: identity.playerId,
        token: identity.token,
        ready: true,
      });
    }
    await host.waitFor(
      (message) => message.type === 'room.state' && message.state.status === 'ready',
    );
    host.send({
      type: 'room.start',
      requestId: 'start-1',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
    });
    const playingRoom = await host.waitFor(
      (message) => message.type === 'room.state' && message.state.status === 'playing',
    );
    const matchId = playingRoom.state.match.matchId;
    assert.match(matchId, /^[0-9a-f-]{36}$/);
    const started = await host.waitFor(
      (message) => message.type === 'match.snapshot' && message.event === 'start',
    );
    assert.equal(started.state.version, 0);
    assert.equal(started.state.turn, 0);
    assert.equal(started.state.inHand, 2);
    assert.equal(started.snapshot.balls.length, 22);
    assert.equal(started.snapshot.match.players.length, 2);
    await guest.waitFor(
      (message) => message.type === 'match.snapshot' && message.event === 'start',
    );

    host.send({
      type: 'match.place',
      requestId: 'place-1',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      matchId,
      commandId: 'place-command-1',
      matchVersion: 0,
      turn: 0,
      position: { x: -1.04, z: -0.145 },
    });
    const placed = await host.waitFor(
      (message) => message.type === 'match.snapshot' && message.event === 'place',
    );
    assert.equal(placed.state.version, 1);
    assert.equal(placed.state.inHand, 1);
    assert.equal(placed.snapshot.balls[0].position[0], -1.04);

    host.send({
      type: 'match.shot',
      requestId: 'shot-1',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      matchId,
      commandId: 'shot-command-1',
      matchVersion: 1,
      turn: 0,
      shot: { direction: { x: 1, z: 0 }, power: 0.25 },
    });
    const shot = await host.waitFor(
      (message) => message.type === 'match.snapshot' && message.event === 'shot',
    );
    const guestShot = await guest.waitFor(
      (message) => message.type === 'match.snapshot' && message.event === 'shot',
    );
    assert.equal(shot.result.version, 2);
    assert.equal(shot.result.state.nRounds, 1);
    assert.equal(shot.result.state.turn, 1);
    assert.equal(shot.result.simulator.firstKissIndex > 0, true);
    assert.equal(shot.result.simulator.nKissed, 1);
    assert.equal(shot.result.score, 0);
    assert.deepEqual(guestShot.snapshot, shot.snapshot);

    host.send({
      type: 'match.shot',
      requestId: 'shot-duplicate',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      matchId,
      commandId: 'shot-command-1',
      matchVersion: 1,
      turn: 0,
      shot: { direction: { x: 1, z: 0 }, power: 0.25 },
    });
    const duplicate = await host.waitFor(
      (message) =>
        message.type === 'match.snapshot' &&
        message.event === 'shot' &&
        message.requestId === 'shot-duplicate',
    );
    assert.equal(duplicate.result.version, 2);
    assert.equal(duplicate.result.state.nRounds, 1);
    assert.deepEqual(duplicate.snapshot, shot.snapshot);

    host.send({
      type: 'match.shot',
      requestId: 'shot-stale',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      matchId,
      commandId: 'shot-command-2',
      matchVersion: 0,
      turn: 0,
      shot: { direction: { x: 1, z: 0 }, power: 0.25 },
    });
    const stale = await host.waitFor(
      (message) => message.type === 'room.error' && message.requestId === 'shot-stale',
    );
    assert.equal(stale.code, 'stale_match');

    host.send({
      type: 'match.shot',
      requestId: 'shot-wrong-player',
      roomId: created.roomId,
      playerId: created.playerId,
      token: created.token,
      matchId,
      commandId: 'shot-command-3',
      matchVersion: 2,
      turn: 1,
      shot: { direction: { x: 1, z: 0 }, power: 0.25 },
    });
    const wrongPlayer = await host.waitFor(
      (message) => message.type === 'room.error' && message.requestId === 'shot-wrong-player',
    );
    assert.equal(wrongPlayer.code, 'wrong_turn');

    guest.send({
      type: 'match.state',
      requestId: 'state-1',
      roomId: created.roomId,
      playerId: joined.playerId,
      token: joined.token,
      matchId,
    });
    const state = await guest.waitFor(
      (message) => message.type === 'match.snapshot' && message.requestId === 'state-1',
    );
    assert.equal(state.state.version, 2);
    assert.deepEqual(state.snapshot, shot.snapshot);
  } finally {
    await host.close();
    await guest.close();
    await server.close();
  }
});
