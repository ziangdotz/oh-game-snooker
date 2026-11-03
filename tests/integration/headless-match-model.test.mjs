import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureMatchSnapshot,
  createHeadlessMatch,
  playControlledRound,
  restoreHeadlessMatch,
} from '../../tooling/validation/headless-match-model.mjs';
import { createRuntimeCatalog } from '../../tooling/validation/headless-match.mjs';

async function setup() {
  const runtime = await createRuntimeCatalog();
  const loader = runtime.createLoader();
  return { loader, match: await createHeadlessMatch(loader) };
}

test('headless match uses the real two-player model, referee and 22-ball simulator', async () => {
  const { match } = await setup();
  assert.equal(match.simulator.getBalls().length, 22);
  assert.equal(match.model.nPlayers, 2);
  assert.equal(match.model.isHotseat, true);
  assert.equal(match.model.gState, match.GameState.READY);
  assert.equal(match.model._locRef.sysReservedBallOn, 65535);
  assert.equal(match.model.getContext('ballOn'), 2);
  assert.equal(match.model.getContext('playerIndex'), 0);
});

test('referee rounds and full serializable match snapshot restore exactly', async () => {
  const { loader, match } = await setup();
  const rounds = [
    playControlledRound(match, { firstNumber: 1, pottedNumbers: [1] }),
    playControlledRound(match, { firstNumber: 7, pottedNumbers: [7] }),
    playControlledRound(match, { firstNumber: 1, pottedNumbers: [1] }),
  ];
  assert.deepEqual(
    rounds.map((round) => round.score),
    [1, 7, 1],
  );
  assert.deepEqual(
    rounds.map((round) => round.snapshot.match.context.ballOn),
    [252, 2, 252],
  );
  assert.deepEqual(
    rounds.map((round) => round.snapshot.match.players[0].pts),
    [1, 8, 9],
  );
  assert.equal(rounds[2].snapshot.balls.filter((ball) => ball.active).length, 20);

  const snapshot = captureMatchSnapshot(match);
  const serializable = JSON.parse(JSON.stringify(snapshot));
  assert.equal(serializable.physics.serial.balls.length, 764);
  assert.equal(serializable.balls.length, 22);
  assert.equal(serializable.match.context.nRounds, 3);
  assert.equal(serializable.match.players[0].pts, 9);
  assert.equal(serializable.match.referee.refId, 'std-sno');
  assert.equal(serializable.match.referee.sceneId, 'tigerClubSno');

  const restored = await restoreHeadlessMatch(loader, serializable);
  assert.equal(
    JSON.stringify(captureMatchSnapshot(restored)),
    JSON.stringify(serializable),
    'restored snapshot must be byte-for-byte equal after JSON normalization',
  );

  const originalNext = playControlledRound(match, { firstNumber: 7, pottedNumbers: [7] });
  const restoredNext = playControlledRound(restored, { firstNumber: 7, pottedNumbers: [7] });
  assert.equal(restoredNext.score, originalNext.score);
  assert.equal(
    JSON.stringify(captureMatchSnapshot(restored)),
    JSON.stringify(captureMatchSnapshot(match)),
    'post-restore round must be deterministic',
  );
});

test('snapshot restore rejects a mismatched collision mesh serial', async () => {
  const { loader, match } = await setup();
  const snapshot = JSON.parse(JSON.stringify(captureMatchSnapshot(match)));
  snapshot.physics.serial.mbid = 'wrong-mesh';
  await assert.rejects(() => restoreHeadlessMatch(loader, snapshot), /mbid not match/);
});
