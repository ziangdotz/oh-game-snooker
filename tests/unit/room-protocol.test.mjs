import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  ROOM_PROTOCOL_VERSION,
  normalizeDisplayName,
  validateClientMessage,
} from '../../src/server/rooms/room-protocol.mjs';

const base = {
  v: ROOM_PROTOCOL_VERSION,
  requestId: 'request-1',
};

test('room protocol accepts create, join and ready messages', () => {
  const create = validateClientMessage({
    ...base,
    type: 'room.create',
    displayName: '  Player One  ',
    interior: 'interior-design-original',
  });
  assert.equal(create.ok, true);
  assert.deepEqual(create.message, {
    ...base,
    type: 'room.create',
    displayName: 'Player One',
    interior: 'interior-design-original',
  });
  assert.equal(
    validateClientMessage({
      ...base,
      type: 'room.join',
      roomId: 'ABC234',
      displayName: 'Player Two',
    }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({
      ...base,
      type: 'room.ready',
      roomId: 'ABC234',
      playerId: 'player-1',
      token: 'token-12345678',
      ready: true,
    }).ok,
    true,
  );
});

test('room protocol rejects malformed identity and state messages', () => {
  const cases = [
    [{ ...base, type: 'room.create', displayName: '' }, 'invalid_name'],
    [{ ...base, type: 'room.create', displayName: 'x'.repeat(11) }, 'invalid_name'],
    [{ ...base, type: 'room.join', roomId: 'abc234', displayName: 'P' }, 'invalid_room_id'],
    [
      { ...base, type: 'room.start', roomId: 'ABC234', playerId: 'p', token: 'short' },
      'invalid_token',
    ],
    [
      { ...base, type: 'room.ready', roomId: 'ABC234', playerId: 'p', token: 'token-12345678' },
      'invalid_ready',
    ],
    [{ ...base, type: 'room.unknown' }, 'unknown_type'],
    [{ ...base, v: 2, type: 'room.create', displayName: 'P' }, 'unsupported_version'],
  ];
  for (const [message, code] of cases) {
    const result = validateClientMessage(message);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});

test('display names are trimmed, control-free and limited by code points', () => {
  assert.deepEqual(normalizeDisplayName('  Player  '), { ok: true, value: 'Player' });
  assert.equal(normalizeDisplayName('a\u0000b').ok, false);
  assert.equal(normalizeDisplayName('😀'.repeat(MAX_DISPLAY_NAME_CODE_POINTS)).ok, true);
  assert.equal(normalizeDisplayName('😀'.repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1)).ok, false);
});

test('match protocol accepts placement, shot and state messages', () => {
  const identity = {
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
    matchId: 'match-1',
  };
  const place = validateClientMessage({
    ...base,
    type: 'match.place',
    ...identity,
    commandId: 'command-1',
    matchVersion: 0,
    turn: 0,
    position: { x: -1.04, z: -0.145 },
  });
  assert.equal(place.ok, true);
  assert.deepEqual(place.message.position, { x: -1.04, z: -0.145 });

  const shot = validateClientMessage({
    ...base,
    type: 'match.shot',
    ...identity,
    commandId: 'command-2',
    matchVersion: 1,
    turn: 1,
    shot: { direction: { x: 1, z: 0 }, power: 0.1 },
  });
  assert.equal(shot.ok, true);
  assert.deepEqual(shot.message.shot, { direction: { x: 1, z: 0 }, power: 0.1 });

  assert.equal(validateClientMessage({ ...base, type: 'match.state', ...identity }).ok, true);
});

test('match protocol carries an optional full-cue strike point', () => {
  const identity = {
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
    matchId: 'match-1',
  };
  const command = {
    ...base,
    type: 'match.shot',
    ...identity,
    commandId: 'command-3',
    matchVersion: 1,
    turn: 0,
    shot: {
      direction: { x: 1, z: 0 },
      power: 0.25,
      kiss: { x: -1.038, y: 0.8973, z: -0.145 },
      axis: { x: 2, y: 0, z: 0 },
    },
  };
  const spun = validateClientMessage(command);
  assert.equal(spun.ok, true);
  assert.deepEqual(spun.message.shot.kiss, { x: -1.038, y: 0.8973, z: -0.145 });
  // The axis is normalised so the service never has to trust a scaled vector.
  assert.deepEqual(spun.message.shot.axis, { x: 1, y: 0, z: 0 });
  assert.equal(spun.message.shot.power, 0.25);

  // A centre hit simply omits the strike point and keeps working.
  const plain = validateClientMessage({
    ...command,
    shot: { direction: { x: 1, z: 0 }, power: 0.25 },
  });
  assert.equal(plain.ok, true);
  assert.equal(plain.message.shot.kiss, undefined);
  assert.equal(plain.message.shot.axis, undefined);

  for (const [shot, reason] of [
    [
      { direction: { x: 1, z: 0 }, power: 0.25, kiss: { x: 0, y: 0 }, axis: { x: 1, y: 0, z: 0 } },
      '2D kiss',
    ],
    [
      {
        direction: { x: 1, z: 0 },
        power: 0.25,
        kiss: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 0 },
      },
      'zero axis',
    ],
    [
      {
        direction: { x: 1, z: 0 },
        power: 0.25,
        kiss: { x: Number.NaN, y: 0, z: 0 },
        axis: { x: 1, y: 0, z: 0 },
      },
      'non-finite kiss',
    ],
  ]) {
    const rejected = validateClientMessage({ ...command, shot });
    assert.equal(rejected.ok, false, reason);
    assert.equal(rejected.error.code, 'invalid_shot', reason);
  }
});

test('match protocol rejects missing or invalid command fields', () => {
  const identity = {
    roomId: 'ABC234',
    playerId: 'player-1',
    token: 'token-12345678',
    matchId: 'match-1',
  };
  const cases = [
    [{ ...base, type: 'match.state', ...identity, matchId: '' }, 'invalid_match_id'],
    [
      {
        ...base,
        type: 'match.shot',
        ...identity,
        commandId: 'command-1',
        matchVersion: -1,
        turn: 0,
        shot: { direction: { x: 1, z: 0 }, power: 0.1 },
      },
      'invalid_match_version',
    ],
    [
      {
        ...base,
        type: 'match.shot',
        ...identity,
        commandId: 'command-1',
        matchVersion: 0,
        turn: 0,
        shot: { direction: { x: 0, z: 0 }, power: 0.1 },
      },
      'invalid_shot',
    ],
    [
      {
        ...base,
        type: 'match.place',
        ...identity,
        commandId: 'command-1',
        matchVersion: 0,
        turn: 0,
        position: { x: Number.NaN, z: 0 },
      },
      'invalid_position',
    ],
  ];
  for (const [message, code] of cases) {
    const result = validateClientMessage(message);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});
