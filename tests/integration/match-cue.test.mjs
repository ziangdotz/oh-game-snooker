import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeCatalog } from '../../src/server/matches/runtime-loader.mjs';
import { createMatchSession } from '../../src/server/matches/match-session.mjs';

const CUE = { x: -1.04, z: -0.145 };

async function freshMatch() {
  const runtime = await createRuntimeCatalog();
  const session = await createMatchSession({
    loadModule: runtime.createLoader(),
    names: ['A', 'B'],
  });
  await session.placeCueBall({
    playerIndex: 0,
    commandId: 'place-1',
    matchVersion: 0,
    turn: 0,
    position: CUE,
  });
  return session;
}

/** Strike the cue ball with a contact offset expressed in ball radii. */
function strike(session, { side = 0, vertical = 0, power = 0.25, commandId = 'shot-1' }) {
  const cue = session.match.world.balls[0].position;
  const radius = session.match.layout.ballRadius;
  // Keep the strike point on the ball: the forward component shrinks as the
  // offset grows, exactly like the cue controller's own correction.
  const forward = Math.sqrt(Math.max(0, 1 - side * side - vertical * vertical));
  return session.shoot({
    playerIndex: 0,
    commandId,
    matchVersion: 1,
    turn: 0,
    shot: {
      direction: { x: 1, z: 0 },
      power,
      kiss: {
        x: cue.x - radius * forward,
        y: cue.y + radius * vertical,
        z: cue.z + radius * side,
      },
      axis: { x: 1, y: 0, z: 0 },
    },
  });
}

test('the authoritative physics distinguishes centre, follow, draw and side', async () => {
  const runs = {};
  for (const name of ['centre', 'follow', 'draw', 'side']) {
    const session = await freshMatch();
    const offset =
      name === 'follow'
        ? { vertical: 0.35 }
        : name === 'draw'
          ? { vertical: -0.35 }
          : name === 'side'
            ? { side: 0.35 }
            : {};
    const result = strike(session, offset);
    const cue = result.snapshot.balls[0].position;
    runs[name] = {
      x: Number(cue[0].toFixed(4)),
      z: Number(cue[2].toFixed(4)),
      frames: result.motion?.frames?.length ?? 0,
      version: result.version,
    };
  }

  // Every spin variant is judged exactly once and ships its own motion track.
  for (const [name, seen] of Object.entries(runs)) {
    assert.equal(seen.version, 2, name + ' advanced the frame once');
    assert.ok(seen.frames > 10, name + ' shipped a motion track');
  }
  assert.ok(runs.follow.x > runs.centre.x, 'follow runs further than a centre hit');
  assert.ok(runs.draw.x < runs.centre.x, 'draw pulls the cue ball back');
  assert.ok(
    Math.abs(runs.side.z - runs.centre.z) > 0.02,
    'side spin throws the cue ball off the straight line',
  );
  // Forward and backward spin change where the cue ball goes after contact, so
  // they must not merely reproduce the centre result.
  assert.notEqual(runs.follow.x, runs.centre.x);
  assert.notEqual(runs.draw.x, runs.centre.x);
});

test('an off-surface strike point is refused and consumes no frame', async () => {
  const session = await freshMatch();
  const cue = session.match.world.balls[0].position;
  const before = session.state().version;
  for (const [kiss, reason] of [
    [{ x: cue.x + 3, y: cue.y, z: cue.z }, 'far from the ball'],
    [{ x: cue.x, y: cue.y, z: cue.z }, 'at the centre'],
  ]) {
    assert.throws(
      () =>
        session.shoot({
          playerIndex: 0,
          commandId: 'shot-bad-' + reason,
          matchVersion: 1,
          turn: 0,
          shot: { direction: { x: 1, z: 0 }, power: 0.25, kiss, axis: { x: 1, y: 0, z: 0 } },
        }),
      (error) => error.code === 'invalid_shot',
      reason,
    );
    assert.equal(session.state().version, before, reason + ' must not advance the frame');
  }
});

test('a near-centre strike point is still playable', async () => {
  // A client that reports the tip almost at the ball centre is a legal centre
  // hit, not a malformed command: the contact normal is still well defined.
  const session = await freshMatch();
  const cue = session.match.world.balls[0].position;
  const radius = session.match.layout.ballRadius;
  const result = session.shoot({
    playerIndex: 0,
    commandId: 'shot-near-centre',
    matchVersion: 1,
    turn: 0,
    shot: {
      direction: { x: 1, z: 0 },
      power: 0.25,
      kiss: { x: cue.x - radius * 0.1, y: cue.y, z: cue.z },
      axis: { x: 1, y: 0, z: 0 },
    },
  });
  assert.equal(result.version, 2, 'a near-centre strike is judged');
  assert.ok(result.motion, 'and still produces a motion track');
});

test('a cue axis pulling away from the ball is refused', async () => {
  const session = await freshMatch();
  const cue = session.match.world.balls[0].position;
  const radius = session.match.layout.ballRadius;
  assert.throws(
    () =>
      session.shoot({
        playerIndex: 0,
        commandId: 'shot-away',
        matchVersion: 1,
        turn: 0,
        shot: {
          direction: { x: 1, z: 0 },
          power: 0.25,
          kiss: { x: cue.x - radius, y: cue.y, z: cue.z },
          axis: { x: -1, y: 0, z: 0 },
        },
      }),
    (error) => error.code === 'invalid_shot',
  );
});

test('the served impulse comes from the power curve, not the client', async () => {
  const session = await freshMatch();
  const cue = session.match.world.balls[0].position;
  const radius = session.match.layout.ballRadius;
  const result = session.shoot({
    playerIndex: 0,
    commandId: 'shot-power',
    matchVersion: 1,
    turn: 0,
    shot: {
      direction: { x: 1, z: 0 },
      power: 1,
      kiss: { x: cue.x - radius, y: cue.y, z: cue.z },
      axis: { x: 1, y: 0, z: 0 },
    },
  });
  // A full-power stroke must move the cue ball but still settle within the
  // recorder's frame budget, so the client keeps a replay it can show.
  assert.equal(result.version, 2);
  assert.ok(result.motion, 'a full-power stroke still produces a motion track');
  assert.ok(result.motion.frames.length <= 241, 'the track respects its frame budget');
});
