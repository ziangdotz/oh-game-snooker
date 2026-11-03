import test from 'node:test';
import assert from 'node:assert/strict';
import createStrokeRecorder from '../../src/server/matches/stroke-recorder.mjs';
import createMotionPlayer from '../../src/infrastructure/net/motion-player.js';
import createRemoteBridge from '../../src/infrastructure/net/remote-bridge.js';

/** A tiny stand-in for the physics world the modules actually touch. */
function fakeWorld(count = 2) {
  const balls = [];
  for (let index = 0; index < count; index += 1) {
    balls.push({
      active: true,
      position: { x: index, y: 0.9, z: -0.145 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      states: {
        position: { copy: (value) => Object.assign(balls[index].position, value) },
        orientation: { copy: (value) => Object.assign(balls[index].orientation, value) },
      },
    });
  }
  return { balls };
}

/** Move every ball by `delta` so captured frames differ over time. */
function advance(world, delta) {
  for (const ball of world.balls) {
    ball.position.x += delta;
  }
}

test('stroke recorder samples a fixed-interval track and stops cleanly', () => {
  const world = fakeWorld(2);
  const recorder = createStrokeRecorder(40);
  recorder.start(world);
  assert.equal(recorder.active, true);
  assert.equal(recorder.frameCount, 1);
  assert.equal(recorder.frames ?? undefined, undefined, 'the track is private until stopped');

  let elapsed = 0;
  while (elapsed < 1.2) {
    recorder.advance(world, 0.1);
    advance(world, 0.05);
    elapsed += 0.1;
  }
  const motion = recorder.stop(world);
  assert.equal(recorder.active, false);
  assert.equal(motion.interval, 0.05);
  assert.ok(motion.frames.length >= 10, 'a 1.2 s stroke must yield several frames');
  assert.equal(motion.frames[0].t, 0);
  assert.ok(motion.frames.at(-1).t > motion.frames[0].t);
  assert.equal(motion.frames[0].balls.length, 2);
  assert.deepEqual(motion.frames[0].balls[1], [1, 0.9, -0.145, 0, 0, 0, 1]);
  // Values are rounded so the wire payload stays small.
  for (const frame of motion.frames) {
    for (const pose of frame.balls) {
      for (const value of pose) {
        assert.equal(Number.isFinite(value), true);
      }
    }
  }
});

test('stroke recorder drops the track when the limit is exceeded', () => {
  const world = fakeWorld(1);
  const recorder = createStrokeRecorder(3);
  recorder.start(world);
  let running = true;
  let elapsed = 0;
  while (running && elapsed < 5) {
    running = recorder.advance(world, 0.1);
    elapsed += 0.1;
  }
  assert.equal(running, false, 'the recorder must signal that tracking stopped');
  assert.equal(recorder.stop(world), null, 'an over-long stroke is not replayed');
});

test('motion player interpolates between frames and reports progress', () => {
  const world = fakeWorld(1);
  const frames = [];
  for (let index = 0; index <= 10; index += 1) {
    frames.push({ t: index * 0.05, balls: [[index * 0.1, 0.9, -0.145, 0, 0, 0, 1]] });
  }
  const player = createMotionPlayer(world);
  assert.equal(player.play({ interval: 0.05, frames }), true);
  assert.equal(player.active, true);
  assert.equal(player.play({ frames: [] }), false, 'an empty track is rejected');
  // Rejecting an empty track must not disturb the running one.
  assert.equal(player.active, true);

  // Half-way through the track the ball sits between the sampled poses.
  let guard = 0;
  while (player.progress < 0.4 && guard < 200) {
    player.update(0.05);
    guard += 1;
  }
  const midway = world.balls[0].position.x;
  assert.ok(midway > 0 && midway < 1, 'the interpolated pose lies inside the track');
  assert.equal(world.balls[0].active, true);

  guard = 0;
  while (player.active && guard < 400) {
    player.update(0.05);
    guard += 1;
  }
  assert.equal(player.active, false, 'the replay ends once the track is consumed');
  assert.ok(world.balls[0].position.x >= 0.9, 'the replay ends at the final pose');
  assert.equal(player.progress, 1);
});

test('motion player clamps a very long frame so the replay cannot skip', () => {
  const world = fakeWorld(1);
  const frames = [];
  for (let index = 0; index <= 20; index += 1) {
    frames.push({ t: index * 0.05, balls: [[index, 0.9, 0, 0, 0, 0, 1]] });
  }
  const player = createMotionPlayer(world);
  player.play({ interval: 0.05, frames });
  // A stalled tab (or a breakpoint) must not jump straight to the finish.
  player.update(5);
  assert.ok(player.progress < 0.2, 'one frame advances at most one sample');
  assert.ok(world.balls[0].position.x < 2);
});

test('remote replay runs once per version and releases control at the settled snapshot', () => {
  const applied = [];
  const bridge = createRemoteBridge({
    room: { matchId: 'first' },
    rooms: {},
    simulator: {},
    model: {
      applySnapshot: (message) => {
        applied.push(message);
        return true;
      },
    },
  });
  const message = {
    matchId: 'first',
    commandId: 'shot',
    state: { version: 1 },
    snapshot: {},
    result: { motion: { frames: [{ t: 0 }, { t: 10 }] } },
  };
  assert.equal(bridge.apply(message), true);
  assert.equal(bridge.apply(message), false, 'duplicate confirmation must not restart motion');
  assert.equal(applied.length, 1);
  assert.equal(bridge.flush(), true);
  assert.equal(applied.at(-1).result.motion, null, 'settling releases the replay input lock');
  assert.equal(message.result.motion.frames.length, 2, 'the cached server result stays intact');
  assert.equal(bridge.flush(), false);
  assert.equal(bridge.apply(message), false, 'a completed stroke is never replayed twice');
  bridge.apply({ ...message, state: { version: 2 } });
  bridge.resetFrame('second');
  assert.equal(bridge.flush(), false, 'a new frame drops the previous replay deadline');
  assert.equal(bridge.apply({ ...message, state: { version: 3 } }), false);
  bridge.dispose();
});
