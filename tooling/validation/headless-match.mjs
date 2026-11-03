import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../config/project.config.mjs';
import {
  createRuntimeCatalog,
  loadCollisionMesh,
} from '../../src/server/matches/runtime-loader.mjs';

const DEFAULT_REFERENCE = path.join(ROOT, 'artifacts/testing/regression/chrome-physics.json');

export { createRuntimeCatalog, loadCollisionMesh };

export const PHYSICS_FIXTURES = [
  {
    name: 'break-center',
    start: [-1.18, 0.90625, -0.1],
    velocity: [3, 0, 0.14],
    arm: [0, 0, 0],
  },
  {
    name: 'cushion-side-spin',
    start: [-0.8, 0.90625, 0.4],
    velocity: [0.5, 0, 2],
    arm: [0.012, 0, 0],
  },
  {
    name: 'draw',
    start: [-0.8, 0.90625, 0],
    velocity: [2.5, 0, 0],
    arm: [0, -0.012, 0],
  },
  {
    name: 'follow',
    start: [-0.8, 0.90625, 0],
    velocity: [2.5, 0, 0],
    arm: [0, 0.012, 0],
  },
  {
    name: 'middle-pocket',
    start: [0, 0.90625, 0.65],
    velocity: [0, 0, 1.5],
    arm: [0, 0, 0],
  },
];

export async function createHeadlessTable(loadModule) {
  const World = loadModule('domain/physics/world');
  const WorldClient = loadModule('domain/physics/world-client');
  const SnookerBall = loadModule('domain/simulation/snooker-ball');
  const layout = loadModule('domain/scene/initial-layout').default;
  const mesh = await loadCollisionMesh(loadModule);
  const world = new WorldClient();
  world.setMeshBody(mesh.body);
  const spotY = mesh.body.ground.centerPosition.y + layout.ballRadius;
  for (let index = 0; index < layout.ballSet.length / 3; index += 1) {
    const number = layout.ballSet[3 * index];
    const x = layout.ballSet[3 * index + 1];
    const z = layout.ballSet[3 * index + 2];
    const ball = new SnookerBall(number, layout.ballRadius, layout.ballMass, x, spotY, z, index);
    ball.reset(x, spotY, z);
    world.addBall(ball);
  }
  world.reset();
  const initialSerial = World.makeSerialData();
  world.serialize(initialSerial);
  return {
    world,
    mesh,
    layout,
    initialSerial,
    spotY,
  };
}

export function resetTransientBallState(world) {
  for (const ball of world.balls) {
    ball.rfPower = 0;
    ball.rfDir.set(0, 0, 0);
  }
}

function attachInteractionHandlers(world) {
  const contacts = { ball: 0, cushion: 0 };
  const removed = [];
  world.onTouchPresolve((contact) => {
    if (contact.isSS) {
      contacts.ball += 1;
    } else if (!contact.bj.ground) {
      contacts.cushion += 1;
    }
    if (!contact.isSS && contact.bj.end) {
      const ball = contact.bi;
      if (ball.active) {
        world.inactivateBall(ball);
        removed.push(ball.number);
      }
    }
  });
  world.onOutOfBounds((ball) => {
    removed.push(ball.number);
  });
  return { contacts, removed };
}

function captureFrame(world) {
  return world.balls.map((ball) => ({
    active: ball.active,
    position: [ball.position.x, ball.position.y, ball.position.z],
    velocity: [ball.v.x, ball.v.y, ball.v.z],
    spin: [ball.w.x, ball.w.y, ball.w.z],
    orientation: [ball.orientation.x, ball.orientation.y, ball.orientation.z, ball.orientation.w],
  }));
}

/** Set up one shot and expose deterministic step recording for single or paired runs. */
export function prepareShot(world, initialSerial, fixture, VectorThree) {
  const interaction = attachInteractionHandlers(world);
  world.deserialize(initialSerial);
  resetTransientBallState(world);
  world.accumulator = 0;
  const cue = world.balls[0];
  cue.reset(...fixture.start);
  world.reset();
  cue.applyImpulseAtPoint(
    new VectorThree(...fixture.velocity.map((value) => value * cue.mass)),
    new VectorThree(...fixture.arm),
    0,
  );
  const trace = {
    index: 0,
    frames: [],
    contacts: interaction.contacts,
    removed: interaction.removed,
  };
  function step() {
    world.step(world.stepSize);
    if (trace.index % 20 === 0 || trace.index === 479) {
      trace.frames.push(captureFrame(world));
    }
    trace.index += 1;
  }
  function finish() {
    while (trace.index < 480) {
      step();
    }
    return {
      frames: trace.frames,
      contacts: trace.contacts,
      removed: trace.removed,
      ballCount: world.balls.length,
    };
  }
  return { trace, step, finish };
}

export function runPhysicsFixture(world, initialSerial, fixture, VectorThree) {
  return prepareShot(world, initialSerial, fixture, VectorThree).finish();
}

export function runPhysicsFixturePair(
  leftWorld,
  leftInitialSerial,
  leftFixture,
  rightWorld,
  rightInitialSerial,
  rightFixture,
  VectorThree,
) {
  const left = prepareShot(leftWorld, leftInitialSerial, leftFixture, VectorThree);
  const right = prepareShot(rightWorld, rightInitialSerial, rightFixture, VectorThree);
  for (let index = 0; index < 480; index += 1) {
    left.step();
    right.step();
  }
  return { left: left.finish(), right: right.finish() };
}

export function compareFrames(
  actual,
  expected,
  { positionVelocityTolerance = 1e-9, spinOrientationTolerance = 1e-3 } = {},
) {
  const mismatches = [];
  let maxAbsDiff = 0;
  let maxPositionVelocityDiff = 0;
  let maxSpinOrientationDiff = 0;
  if (actual.length !== expected.length) {
    mismatches.push({
      field: 'frameCount',
      actual: actual.length,
      expected: expected.length,
    });
    return {
      passed: false,
      maxAbsDiff,
      maxPositionVelocityDiff,
      maxSpinOrientationDiff,
      mismatches,
    };
  }
  for (let frameIndex = 0; frameIndex < expected.length; frameIndex += 1) {
    const actualFrame = actual[frameIndex];
    const expectedFrame = expected[frameIndex];
    if (actualFrame.length !== expectedFrame.length) {
      mismatches.push({
        frame: frameIndex,
        field: 'ballCount',
        actual: actualFrame.length,
        expected: expectedFrame.length,
      });
      continue;
    }
    for (let ballIndex = 0; ballIndex < expectedFrame.length; ballIndex += 1) {
      const actualBall = actualFrame[ballIndex];
      const expectedBall = expectedFrame[ballIndex];
      if (actualBall.active !== expectedBall.active) {
        mismatches.push({
          frame: frameIndex,
          ball: ballIndex,
          field: 'active',
          actual: actualBall.active,
          expected: expectedBall.active,
        });
      }
      for (const field of ['position', 'velocity', 'spin', 'orientation']) {
        const tolerance =
          field === 'position' || field === 'velocity'
            ? positionVelocityTolerance
            : spinOrientationTolerance;
        for (let axis = 0; axis < expectedBall[field].length; axis += 1) {
          const actualValue = actualBall[field][axis];
          const expectedValue = expectedBall[field][axis];
          const difference = Math.abs(actualValue - expectedValue);
          maxAbsDiff = Math.max(maxAbsDiff, Number.isFinite(difference) ? difference : Infinity);
          if (field === 'position' || field === 'velocity') {
            maxPositionVelocityDiff = Math.max(
              maxPositionVelocityDiff,
              Number.isFinite(difference) ? difference : Infinity,
            );
          } else {
            maxSpinOrientationDiff = Math.max(
              maxSpinOrientationDiff,
              Number.isFinite(difference) ? difference : Infinity,
            );
          }
          if (!Number.isFinite(difference) || difference > tolerance) {
            mismatches.push({
              frame: frameIndex,
              ball: ballIndex,
              field: field + '[' + axis + ']',
              actual: actualValue,
              expected: expectedValue,
              difference,
            });
          }
        }
      }
    }
  }
  return {
    passed: mismatches.length === 0,
    maxAbsDiff,
    maxPositionVelocityDiff,
    maxSpinOrientationDiff,
    mismatches: mismatches.slice(0, 10),
  };
}

export async function loadBrowserReference(file = DEFAULT_REFERENCE) {
  const metadata = await stat(file);
  const reference = JSON.parse(await readFile(file, 'utf8'));
  return { file, modifiedAt: metadata.mtime.toISOString(), reference };
}
