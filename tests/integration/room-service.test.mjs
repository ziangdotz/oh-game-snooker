import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomService } from '../../src/server/rooms/room-service.mjs';

test('room service rejects an unknown venue and defaults to the original hall', () => {
  const service = new RoomService();
  for (const interior of ['tigerClubSno', '', null, 'interior-design-999', 42]) {
    assert.throws(
      () => service.createRoom({ displayName: 'Host', interior }),
      (error) => error instanceof RoomError && error.code === 'invalid_interior',
      String(interior),
    );
  }
  const defaulted = service.createRoom({ displayName: 'Host' });
  assert.equal(defaulted.state.interior, 'interior-design-original');
});

test('room service handles create, join, ready and start', () => {
  const service = new RoomService();
  const host = service.createRoom({ displayName: 'Host', interior: 'interior-design-original' });
  assert.match(host.roomId, /^[A-Z0-9]{6}$/);
  assert.equal(host.state.status, 'waiting');
  assert.equal(host.state.hostId, host.playerId);
  assert.equal(host.state.seats.length, 1);
  assert.equal('token' in host.state.seats[0], false);

  const guest = service.joinRoom({ roomId: host.roomId, displayName: 'Guest' });
  assert.equal(guest.state.seats.length, 2);
  assert.equal(guest.state.status, 'waiting');

  service.setReady({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
    ready: true,
  });
  const ready = service.setReady({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
    ready: true,
  });
  assert.equal(ready.state.status, 'ready');

  assert.throws(
    () =>
      service.startRoom({
        roomId: host.roomId,
        playerId: guest.playerId,
        token: guest.token,
      }),
    (error) => error instanceof RoomError && error.code === 'not_host',
  );
  const started = service.startRoom({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
  });
  assert.equal(started.state.status, 'playing');
  assert.equal(started.state.match.protocolVersion, 1);
  assert.match(started.state.match.matchId, /^[0-9a-f-]{36}$/);
  assert.equal(started.restarted, true);
  assert.equal(
    service.startRoom({
      roomId: host.roomId,
      playerId: host.playerId,
      token: host.token,
    }).restarted,
    false,
  );
});

test('aborting a start returns the room to ready without a match', () => {
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
  service.startRoom({ roomId: host.roomId, playerId: host.playerId, token: host.token });
  const aborted = service.abortStart({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
  });
  assert.equal(aborted.state.status, 'ready');
  assert.equal(aborted.state.match, null);
  assert.equal(
    service.startRoom({
      roomId: host.roomId,
      playerId: host.playerId,
      token: host.token,
    }).restarted,
    true,
  );
});

test('room service supports reconnect, leave and host transfer', () => {
  const service = new RoomService();
  const host = service.createRoom({ displayName: 'Host' });
  const guest = service.joinRoom({ roomId: host.roomId, displayName: 'Guest' });

  const disconnected = service.disconnect({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(
    disconnected.state.seats.find((seat) => seat.playerId === guest.playerId).connected,
    false,
  );
  const resumed = service.resume({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(
    resumed.state.seats.find((seat) => seat.playerId === guest.playerId).connected,
    true,
  );

  const left = service.leave({
    roomId: host.roomId,
    playerId: host.playerId,
    token: host.token,
  });
  assert.equal(left.closed, false);
  assert.equal(left.state.hostId, guest.playerId);
  assert.equal(left.state.seats.length, 1);
  assert.equal(left.state.status, 'waiting');

  const last = service.leave({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(last.closed, true);
  assert.equal(last.state, null);
  assert.equal(service.size, 0);
});

test('room service rejects full rooms, duplicate names and wrong tokens', () => {
  const service = new RoomService();
  const host = service.createRoom({ displayName: 'Host' });
  assert.throws(
    () => service.joinRoom({ roomId: host.roomId, displayName: 'host' }),
    (error) => error instanceof RoomError && error.code === 'name_taken',
  );
  service.joinRoom({ roomId: host.roomId, displayName: 'Guest' });
  assert.throws(
    () => service.joinRoom({ roomId: host.roomId, displayName: 'Third' }),
    (error) => error instanceof RoomError && error.code === 'room_full',
  );
  assert.throws(
    () =>
      service.setReady({
        roomId: host.roomId,
        playerId: host.playerId,
        token: 'wrong-token',
        ready: true,
      }),
    (error) => error instanceof RoomError && error.code === 'unauthorized',
  );
  assert.throws(
    () => service.state({ roomId: 'ZZZZZZ', playerId: host.playerId, token: host.token }),
    (error) => error instanceof RoomError && error.code === 'room_not_found',
  );
});

test('starting a playing room after a leave closes the room', () => {
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
  service.startRoom({ roomId: host.roomId, playerId: host.playerId, token: host.token });
  const left = service.leave({
    roomId: host.roomId,
    playerId: guest.playerId,
    token: guest.token,
  });
  assert.equal(left.closed, true);
  assert.equal(service.size, 0);
});
