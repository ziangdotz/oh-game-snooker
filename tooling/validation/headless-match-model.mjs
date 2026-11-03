import { captureMatchSnapshot } from '../../src/server/matches/headless-match-model.mjs';

export {
  createHeadlessMatch,
  restoreHeadlessMatch,
} from '../../src/server/matches/headless-match-model.mjs';
export { captureMatchSnapshot };

export function playControlledRound(match, { firstNumber, pottedNumbers, name }) {
  const { model, simulator, world } = match;
  const playerIndex = model.getContext('playerIndex');
  const accepted = model.reportPlayerStroke(playerIndex);
  if (!accepted) {
    throw new Error('Stroke rejected for player ' + playerIndex);
  }
  simulator.clearResult();
  const first = simulator.getBalls().find((ball) => ball.number === firstNumber && ball.active);
  if (!first) {
    throw new Error('No active first-contact ball: ' + firstNumber);
  }
  simulator.result.firstKissIndex = first.index;
  simulator.result.nKissed = firstNumber === 0 ? 0 : 1;
  for (const number of pottedNumbers) {
    const ball = simulator
      .getBalls()
      .find((candidate) => candidate.number === number && candidate.active);
    if (!ball) {
      throw new Error('No active potted ball: ' + number);
    }
    world.inactivateBall(ball);
    simulator.result.pottedIndices.push(ball.index);
  }
  model.reqRoundResult(simulator);
  return {
    name: name || firstNumber + ':' + pottedNumbers.join(','),
    accepted,
    score: model._refResult.score,
    foulCode: model._refResult.foulCode,
    snapshot: captureMatchSnapshot(match),
  };
}
