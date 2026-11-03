import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHYSICS_FIXTURES,
  compareFrames,
  createHeadlessTable,
  createRuntimeCatalog,
  runPhysicsFixture,
  runPhysicsFixturePair,
} from '../../tooling/validation/headless-match.mjs';

const EXPECTED_INTERACTIONS = {
  'break-center': { contacts: { ball: 1, cushion: 3 }, removed: [] },
  'cushion-side-spin': { contacts: { ball: 1, cushion: 1 }, removed: [] },
  draw: { contacts: { ball: 19, cushion: 0 }, removed: [] },
  follow: { contacts: { ball: 22, cushion: 2 }, removed: [] },
  'middle-pocket': { contacts: { ball: 0, cushion: 2 }, removed: [0] },
};

async function createTable() {
  const runtime = await createRuntimeCatalog();
  const loader = runtime.createLoader();
  return {
    table: await createHeadlessTable(loader),
    VectorThree: loader('domain/math/vector-three'),
  };
}

test('headless table loads the original 22-ball layout and collision normals', async () => {
  const { table } = await createTable();
  assert.equal(table.world.balls.length, 22);
  assert.equal(table.world.environmentReady, true);
  assert.equal(table.world.stepSize, 0.0167);
  assert.equal(table.mesh.body.nPolygons, 66);
  assert.deepEqual(
    table.mesh.body.groups.map((group) => group.name),
    ['ground', 'side', 'tunnel'],
  );
  assert.deepEqual(table.mesh.textures, ['../textures/table/collision-atlas.png']);
  for (let index = 0; index < 22; index += 1) {
    const ball = table.world.balls[index];
    assert.equal(ball.index, index);
    assert.equal(ball.number, table.layout.ballSet[3 * index]);
    assert.equal(ball.position.x, table.layout.ballSet[3 * index + 1]);
    assert.equal(ball.position.y, table.spotY);
    assert.equal(ball.position.z, table.layout.ballSet[3 * index + 2]);
    assert.equal(ball.active, true);
  }
});

test('headless fixtures reproduce browser contacts, pots and 25 sampled frames', async () => {
  const { table, VectorThree } = await createTable();
  for (const fixture of PHYSICS_FIXTURES) {
    const result = runPhysicsFixture(table.world, table.initialSerial, fixture, VectorThree);
    assert.equal(result.frames.length, 25, fixture.name);
    assert.deepEqual(result.contacts, EXPECTED_INTERACTIONS[fixture.name].contacts, fixture.name);
    assert.deepEqual(result.removed, EXPECTED_INTERACTIONS[fixture.name].removed, fixture.name);
    for (const frame of result.frames) {
      assert.equal(frame.length, 22, fixture.name);
      for (const ball of frame) {
        for (const value of [
          ...ball.position,
          ...ball.velocity,
          ...ball.spin,
          ...ball.orientation,
        ]) {
          assert.equal(Number.isFinite(value), true, fixture.name);
        }
      }
    }
  }
});

test('two independent headless instances keep solver state isolated', async () => {
  const singleBreakTable = await createTable();
  const singleDrawTable = await createTable();
  const pairLeftTable = await createTable();
  const pairRightTable = await createTable();
  assert.notEqual(pairLeftTable.table.world.solver, pairRightTable.table.world.solver);
  assert.notEqual(
    pairLeftTable.table.world.predictorSolver,
    pairRightTable.table.world.predictorSolver,
  );
  assert.notEqual(pairLeftTable.table.world.constructor, pairRightTable.table.world.constructor);

  const singleBreak = runPhysicsFixture(
    singleBreakTable.table.world,
    singleBreakTable.table.initialSerial,
    PHYSICS_FIXTURES[0],
    singleBreakTable.VectorThree,
  );
  const singleDraw = runPhysicsFixture(
    singleDrawTable.table.world,
    singleDrawTable.table.initialSerial,
    PHYSICS_FIXTURES[2],
    singleDrawTable.VectorThree,
  );
  const pair = runPhysicsFixturePair(
    pairLeftTable.table.world,
    pairLeftTable.table.initialSerial,
    PHYSICS_FIXTURES[0],
    pairRightTable.table.world,
    pairRightTable.table.initialSerial,
    PHYSICS_FIXTURES[2],
    pairLeftTable.VectorThree,
  );
  assert.deepEqual(pair.left.frames, singleBreak.frames);
  assert.deepEqual(pair.right.frames, singleDraw.frames);
  assert.deepEqual(compareFrames(pair.left.frames, singleBreak.frames).mismatches, []);
  assert.deepEqual(compareFrames(pair.right.frames, singleDraw.frames).mismatches, []);
});
