import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../config/project.config.mjs';
import {
  PHYSICS_FIXTURES,
  compareFrames,
  createHeadlessTable,
  createRuntimeCatalog,
  loadBrowserReference,
  runPhysicsFixture,
  runPhysicsFixturePair,
} from '../tooling/validation/headless-match.mjs';
import {
  createHeadlessMatch,
  captureMatchSnapshot,
  restoreHeadlessMatch,
  playControlledRound,
} from '../tooling/validation/headless-match-model.mjs';

const REPORT = path.join(ROOT, 'reports/validation/headless-match.json');
const SNAPSHOT_REPORT = path.join(ROOT, 'reports/validation/headless-match-snapshot.json');
const COLD_REFERENCE = path.join(ROOT, 'artifacts/testing/regression/chrome-physics-cold.json');
const LEGACY_REFERENCE = path.join(ROOT, 'artifacts/testing/regression/chrome-physics.json');
const allowLegacy = process.argv.includes('--allow-legacy');
let referenceFile = COLD_REFERENCE;
try {
  await access(COLD_REFERENCE);
} catch {
  if (!allowLegacy) {
    console.error(
      'Cold browser reference is required: ' +
        path.relative(ROOT, COLD_REFERENCE) +
        '\nRun scripts/capture-browser-physics.mjs against a fresh browser, or pass --allow-legacy for a non-strict diagnostic run.',
    );
    process.exit(1);
  }
  referenceFile = LEGACY_REFERENCE;
}
const referenceBytes = await readFile(referenceFile);
const referenceSha256 = createHash('sha256').update(referenceBytes).digest('hex');
const reference = await loadBrowserReference(referenceFile);
const coldStart = referenceFile === COLD_REFERENCE;
const positionVelocityTolerance = coldStart ? 0 : 1e-9;
const spinOrientationTolerance = coldStart ? 0 : 1e-3;
const runtime = await createRuntimeCatalog();
const loader = runtime.createLoader();
const VectorThree = loader('domain/math/vector-three');
let sequentialTable;
const fixtureReports = [];
for (const fixture of PHYSICS_FIXTURES) {
  const expected = reference.reference.fixtures.find((entry) => entry.name === fixture.name);
  if (!expected) {
    throw new Error('Browser reference is missing fixture: ' + fixture.name);
  }
  if (coldStart) {
    sequentialTable = await createHeadlessTable(runtime.createLoader());
  } else {
    sequentialTable ??= await createHeadlessTable(loader);
  }
  const actual = runPhysicsFixture(
    sequentialTable.world,
    sequentialTable.initialSerial,
    fixture,
    VectorThree,
  );
  const comparison = compareFrames(actual.frames, expected.frames, {
    positionVelocityTolerance,
    spinOrientationTolerance,
  });
  const contactsMatch = JSON.stringify(actual.contacts) === JSON.stringify(expected.contacts);
  const removedMatch = JSON.stringify(actual.removed) === JSON.stringify(expected.removed);
  const passed = comparison.passed && contactsMatch && removedMatch;
  fixtureReports.push({
    name: fixture.name,
    passed,
    strictPassed: passed,
    frames: actual.frames.length,
    ballCount: actual.ballCount,
    maxAbsDiff: comparison.maxAbsDiff,
    maxPositionVelocityDiff: comparison.maxPositionVelocityDiff,
    maxSpinOrientationDiff: comparison.maxSpinOrientationDiff,
    mismatches: comparison.mismatches,
    contacts: actual.contacts,
    expectedContacts: expected.contacts,
    removed: actual.removed,
    expectedRemoved: expected.removed,
    contactsMatch,
    removedMatch,
  });
}
sequentialTable ??= await createHeadlessTable(loader);

const singleBreakTable = await createHeadlessTable(runtime.createLoader());
const singleDrawTable = await createHeadlessTable(runtime.createLoader());
const singleBreak = runPhysicsFixture(
  singleBreakTable.world,
  singleBreakTable.initialSerial,
  PHYSICS_FIXTURES[0],
  VectorThree,
);
const singleDraw = runPhysicsFixture(
  singleDrawTable.world,
  singleDrawTable.initialSerial,
  PHYSICS_FIXTURES[2],
  VectorThree,
);

const pairLeftTable = await createHeadlessTable(runtime.createLoader());
const pairRightTable = await createHeadlessTable(runtime.createLoader());
const pair = runPhysicsFixturePair(
  pairLeftTable.world,
  pairLeftTable.initialSerial,
  PHYSICS_FIXTURES[0],
  pairRightTable.world,
  pairRightTable.initialSerial,
  PHYSICS_FIXTURES[2],
  VectorThree,
);
const pairLeftComparison = compareFrames(pair.left.frames, singleBreak.frames, {
  positionVelocityTolerance: 0,
  spinOrientationTolerance: 0,
});
const pairRightComparison = compareFrames(pair.right.frames, singleDraw.frames, {
  positionVelocityTolerance: 0,
  spinOrientationTolerance: 0,
});
const isolation = {
  passed:
    pairLeftComparison.passed &&
    pairRightComparison.passed &&
    pairLeftTable.world.solver !== pairRightTable.world.solver &&
    pairLeftTable.world.predictorSolver !== pairRightTable.world.predictorSolver &&
    pairLeftTable.world.constructor !== pairRightTable.world.constructor,
  leftVsSingleMaxAbsDiff: pairLeftComparison.maxAbsDiff,
  rightVsSingleMaxAbsDiff: pairRightComparison.maxAbsDiff,
  leftMismatches: pairLeftComparison.mismatches,
  rightMismatches: pairRightComparison.mismatches,
  solverInstancesDistinct: pairLeftTable.world.solver !== pairRightTable.world.solver,
  predictorSolverInstancesDistinct:
    pairLeftTable.world.predictorSolver !== pairRightTable.world.predictorSolver,
  worldClassesDistinct: pairLeftTable.world.constructor !== pairRightTable.world.constructor,
};

const match = await createHeadlessMatch(loader);
const initialSnapshot = captureMatchSnapshot(match);
const rounds = [];
const controlledRounds = [
  { firstNumber: 1, pottedNumbers: [1] },
  { firstNumber: 7, pottedNumbers: [7] },
  { firstNumber: 1, pottedNumbers: [1] },
];
for (const roundInput of controlledRounds) {
  const round = playControlledRound(match, roundInput);
  rounds.push(round);
}
const finalSnapshot = captureMatchSnapshot(match);
const restored = await restoreHeadlessMatch(loader, finalSnapshot);
const restoredSnapshot = captureMatchSnapshot(restored);
const restoredMatch = JSON.stringify(restoredSnapshot) === JSON.stringify(finalSnapshot);
const postRestoreRound = playControlledRound(restored, { firstNumber: 7, pottedNumbers: [7] });
const originalPostRound = playControlledRound(match, { firstNumber: 7, pottedNumbers: [7] });
const postRestoreMatch =
  JSON.stringify(captureMatchSnapshot(restored)) === JSON.stringify(captureMatchSnapshot(match));
const matchReport = {
  passed: initMatchPassed(initialSnapshot, rounds, finalSnapshot, restoredMatch, postRestoreMatch),
  players: initialSnapshot.match.players.map((player) => player.displayName),
  rounds: rounds.map((round) => ({
    name: round.name,
    accepted: round.accepted,
    score: round.score,
    foulCode: round.foulCode,
    context: round.snapshot.match.context,
    ballOn: round.snapshot.match.context.ballOn,
    playerIndex: round.snapshot.match.context.playerIndex,
    activeBalls: round.snapshot.balls.filter((ball) => ball.active).length,
  })),
  finalSnapshot: {
    context: finalSnapshot.match.context,
    players: finalSnapshot.match.players,
    referees: finalSnapshot.match.referee,
    activeBalls: finalSnapshot.balls.filter((ball) => ball.active).length,
  },
  restoredMatch,
  postRestoreMatch,
  postRestoreScore: postRestoreRound.score,
  originalPostRoundScore: originalPostRound.score,
};

function initMatchPassed(initial, roundResults, final, restoredOk, postRestoreOk) {
  const expected = [
    { score: 1, ballOn: 252, playerIndex: 0, pts: [1, 0] },
    { score: 7, ballOn: 2, playerIndex: 0, pts: [8, 0] },
    { score: 1, ballOn: 252, playerIndex: 0, pts: [9, 0] },
  ];
  if (!restoredOk || !postRestoreOk) {
    return false;
  }
  if (initial.match.context.nRounds !== 0) {
    return false;
  }
  return roundResults.every((round, index) => {
    const target = expected[index];
    return (
      round.accepted === true &&
      round.score === target.score &&
      round.snapshot.match.context.ballOn === target.ballOn &&
      round.snapshot.match.context.playerIndex === target.playerIndex &&
      round.snapshot.match.players[0].pts === target.pts[0] &&
      round.snapshot.match.players[1].pts === target.pts[1]
    );
  });
}

const allFixturesPassed = fixtureReports.every((entry) => entry.passed);
const strictPassed = coldStart && fixtureReports.every((entry) => entry.strictPassed);
const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  reference: {
    file: path.relative(ROOT, reference.file).split(path.sep).join('/'),
    sha256: referenceSha256,
    coldStart,
    modifiedAt: reference.modifiedAt,
    stepSize: reference.reference.stepSize,
    fixtureIsolation: reference.reference.fixtureIsolation || 'sequential-page',
    note: coldStart
      ? 'Each fixture is captured from a fresh browser page and a newly constructed WorldClient.'
      : 'Legacy Chrome trace uses one sequential browser world; strict comparison is disabled.',
  },
  tolerance: {
    positionVelocity: positionVelocityTolerance,
    spinOrientation: spinOrientationTolerance,
  },
  table: {
    sceneId: sequentialTable.layout.sceneId,
    ballCount: sequentialTable.world.balls.length,
    ballRadius: sequentialTable.layout.ballRadius,
    ballMass: sequentialTable.layout.ballMass,
    spotY: sequentialTable.spotY,
    groups: sequentialTable.mesh.body.groups.map((group) => group.name),
    polygons: sequentialTable.mesh.body.nPolygons,
    textures: sequentialTable.mesh.textures,
    stepSize: sequentialTable.world.stepSize,
  },
  fixtures: fixtureReports,
  isolation,
  match: matchReport,
  snapshot: {
    file: path.relative(ROOT, SNAPSHOT_REPORT).split(path.sep).join('/'),
    note: 'Full serializable match snapshot after red-black-red; used for restore equality.',
  },
  strictPassed: strictPassed && isolation.passed && matchReport.passed,
  passed: allFixturesPassed && isolation.passed && matchReport.passed,
};

await mkdir(path.dirname(REPORT), { recursive: true });
await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
await writeFile(SNAPSHOT_REPORT, JSON.stringify(finalSnapshot, null, 2) + '\n');

for (const entry of fixtureReports) {
  console.log(
    [
      entry.name.padEnd(18),
      entry.passed ? 'PASS' : 'FAIL',
      entry.strictPassed ? 'STRICT' : 'tol',
      'frames=' + entry.frames,
      'posVel=' + entry.maxPositionVelocityDiff,
      'spinOri=' + entry.maxSpinOrientationDiff,
      'contacts=' + JSON.stringify(entry.contacts),
    ].join(' '),
  );
}
console.log(
  'isolation ' +
    (isolation.passed ? 'PASS' : 'FAIL') +
    ' leftDiff=' +
    isolation.leftVsSingleMaxAbsDiff +
    ' rightDiff=' +
    isolation.rightVsSingleMaxAbsDiff,
);
console.log(
  'match ' +
    (matchReport.passed ? 'PASS' : 'FAIL') +
    ' rounds=' +
    matchReport.rounds.length +
    ' restored=' +
    matchReport.restoredMatch +
    ' postRestore=' +
    matchReport.postRestoreMatch,
);
console.log('report: ' + path.relative(ROOT, REPORT));
console.log(
  report.passed
    ? 'Headless physics and match state match the browser reference.'
    : 'Headless validation diverges.',
);
if (!report.passed) {
  process.exitCode = 1;
}
