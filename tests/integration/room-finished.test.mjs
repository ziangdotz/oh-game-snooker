import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomService } from '../../src/server/rooms/room-service.mjs';

function startedRoom() {
  const service = new RoomService();
  const host = service.createRoom({ displayName: 'Host' });
  const guest = service.joinRoom({ roomId: host.roomId, displayName: 'Guest' });
  for (const seat of [host, guest]) {
    service.setReady({
      roomId: host.roomId,
      playerId: seat.playerId,
      token: seat.token,
      ready: true,
    });
  }
  const started = service.startRoom({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
  });
  return { service, host, guest, started };
}

const FINAL = {
  draw: false,
  winnerIndex: 0,
  players: [
    { displayName: 'Host', pts: 32, penalty: 0, maxbrk: 18, accuracy: 0.5 },
    { displayName: 'Guest', pts: 12, penalty: -4, maxbrk: 8, accuracy: 0.25 },
  ],
};

test('a finished frame records one authoritative result for both seats', () => {
  const { service, host, started } = startedRoom();
  const finished = service.finishMatch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId: started.state.match.matchId,
    result: FINAL,
  });
  assert.equal(finished.state.status, 'finished');
  assert.equal(finished.state.match.result.winnerIndex, 0);
  assert.equal(finished.state.match.result.draw, false);
  assert.deepEqual(
    finished.state.match.result.players.map((player) => player.pts),
    [32, 12],
  );
  assert.deepEqual(finished.state.match.rematch, []);
  const identity = { roomId: host.roomId, playerId: host.playerId, token: host.token };
  for (const action of [
    () => service.setReady({ ...identity, ready: true }),
    () => service.startRoom(identity),
    () => service.assertStartable(identity),
  ]) {
    assert.throws(
      action,
      (error) => error.code === 'room_unavailable',
      'lobby commands cannot bypass the rematch vote',
    );
  }
  assert.throws(
    () =>
      service.finishMatch({
        roomId: host.roomId,
        playerId: host.playerId,
        token: host.token,
        matchId: started.state.match.matchId,
        result: FINAL,
      }),
    (error) => error instanceof RoomError && error.code === 'room_not_playing',
  );
});

test('a rematch needs both seats and creates a new match identity', () => {
  const { service, host, guest, started } = startedRoom();
  const matchId = started.state.match.matchId;
  service.finishMatch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId,
    result: FINAL,
  });
  const first = service.requestRematch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId,
  });
  assert.equal(first.accepted, false);
  assert.deepEqual(first.acceptedPlayerIds, [host.playerId]);
  assert.throws(
    () =>
      service.startRematch({
        roomId: host.roomId,
        playerId: host.playerId,
        token: host.token,
        matchId,
      }),
    (error) => error instanceof RoomError && error.code === 'rematch_pending',
  );
  // A repeated vote from the same seat is not two votes.
  service.requestRematch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId,
  });
  const second = service.requestRematch({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
    matchId,
  });
  assert.equal(second.accepted, true);
  assert.equal(second.acceptedPlayerIds.length, 2);

  const restarted = service.startRematch({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
    matchId,
  });
  assert.equal(restarted.rematch, true);
  assert.equal(restarted.state.status, 'playing');
  assert.notEqual(restarted.state.match.matchId, matchId);
  assert.equal(restarted.state.match.previousMatchId, matchId);
});

test('a finished room can be left and reloaded as a lobby', () => {
  const { service, host, guest, started } = startedRoom();
  service.finishMatch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId: started.state.match.matchId,
    result: FINAL,
  });
  const left = service.leave({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(left.closed, false);
  assert.equal(left.state.status, 'waiting');
  assert.equal(left.state.match, null);
  assert.equal(left.state.seats.length, 1);
  assert.equal(left.state.hostId, host.playerId);
});

test('rematch votes are rejected before the frame finishes and for stale matches', () => {
  const { service, host, started } = startedRoom();
  assert.throws(
    () =>
      service.requestRematch({
        roomId: host.roomId,
        playerId: host.playerId,
        token: host.token,
        matchId: started.state.match.matchId,
      }),
    (error) => error instanceof RoomError && error.code === 'room_not_finished',
  );
  service.finishMatch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId: started.state.match.matchId,
    result: FINAL,
  });
  assert.throws(
    () =>
      service.requestRematch({
        roomId: host.roomId,
        playerId: host.playerId,
        token: host.token,
        matchId: 'stale-match-id',
      }),
    (error) => error instanceof RoomError && error.code === 'stale_match',
  );
});

test('a disconnect keeps the finished frame so a refresh can resume it', () => {
  const { service, host, guest, started } = startedRoom();
  const matchId = started.state.match.matchId;
  service.finishMatch({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    matchId,
    result: FINAL,
  });
  const offline = service.disconnect({
    roomId: guest.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(offline.state.status, 'finished');
  const resumed = service.resume({
    roomId: guest.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(resumed.state.status, 'finished');
  assert.equal(resumed.state.match.result.winnerIndex, 0);
  assert.equal(
    resumed.state.seats.find((seat) => seat.playerId === guest.playerId).connected,
    true,
  );
});
