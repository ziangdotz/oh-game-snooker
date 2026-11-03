import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import createRoomClient from '../../src/infrastructure/net/room-client.js';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { createMatchSession } from '../../src/server/matches/match-session.mjs';
import { prepareFinalBlack } from '../helpers/room-match-fixture.mjs';

test('browser transport confirms ready, receives referee results and plays a new frame', async (t) => {
  const frames = [];
  const server = createRoomServer({
    port: 0,
    matchFactory: async (options) => {
      const frame = await createMatchSession(options);
      frames.push(frame);
      return frame;
    },
  });
  await server.listen();
  t.after(() => server.close());
  const options = {
    endpoint: 'ws://127.0.0.1:' + server.address().port + '/rooms',
    WebSocket,
    reconnectDelays: [],
    requestTimeout: 2000,
  };
  const host = createRoomClient(globalThis, options);
  const guest = createRoomClient(globalThis, options);
  t.after(() => {
    host.close();
    guest.close();
  });
  await Promise.all([host.open(), guest.open()]);
  await host.send({ type: 'room.create', displayName: 'Host' });
  assert.equal(host.state.seats.length, 1);
  await guest.send({ type: 'room.join', roomId: host.identity.roomId, displayName: 'Guest' });
  await Promise.all([
    host.send({ type: 'room.ready', ready: true }),
    guest.send({ type: 'room.ready', ready: true }),
  ]);
  await host.send({ type: 'room.start' });
  const matchId = host.state.match.matchId;
  await host.send({
    type: 'match.place',
    matchId,
    commandId: 'place-first',
    matchVersion: 0,
    turn: 0,
    position: { x: -1.04, z: -0.145 },
  });
  prepareFinalBlack(frames[0]);
  const finished = new Promise((resolve) => guest.on('finished', resolve));
  const finalShot = await host.send({
    type: 'match.shot',
    matchId,
    commandId: 'final-black',
    matchVersion: 1,
    turn: 0,
    shot: { direction: { x: 1, z: 0 }, power: 0.25 },
  });
  assert.equal(finalShot.state.ballOn, 0);
  assert.equal((await finished).result.winnerIndex, 0);
  assert.equal(guest.state.status, 'finished');
  assert.equal(guest.state.match.result.players[0].pts, 49);
  assert.equal(JSON.stringify(guest.state).includes(host.identity.token), false);
  const rematched = new Promise((resolve) => host.on('rematch', resolve));
  await host.send({ type: 'match.rematch', matchId });
  await guest.send({ type: 'match.rematch', matchId });
  const rematch = await rematched;
  assert.notEqual(rematch.matchId, matchId);
  assert.equal(host.snapshot.state.version, 0);
  assert.equal(host.snapshot.matchId, rematch.matchId);
  await host.send({
    type: 'match.place',
    matchId: rematch.matchId,
    commandId: 'place-rematch',
    matchVersion: 0,
    turn: 0,
    position: { x: -1.04, z: -0.145 },
  });
  assert.equal(host.snapshot.state.version, 1);
  const closed = new Promise((resolve) => guest.on('closed', resolve));
  await host.leave();
  assert.equal((await closed).reason, 'player_left');
  assert.equal(guest.identity, null);
  assert.equal(guest.state, null);
  await guest.send({ type: 'room.create', displayName: 'Guest2' });
  assert.equal(guest.state.seats.length, 1, 'the remaining transport can join a new room');
});
