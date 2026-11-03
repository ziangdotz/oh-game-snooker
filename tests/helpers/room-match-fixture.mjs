import { playControlledRound } from '../../tooling/validation/headless-match-model.mjs';

/** Controlled contacts exercise the real referee and the server's terminal-shot path. */
export function prepareFinalBlack(session) {
  const { match } = session;
  const reds = match.world.balls.filter((ball) => ball.active && ball.number === 1);
  playControlledRound(match, { firstNumber: 1, pottedNumbers: reds.map(() => 1) });
  playControlledRound(match, { firstNumber: 7, pottedNumbers: [7] });
  for (let number = 2; number <= 6; number += 1) {
    playControlledRound(match, { firstNumber: number, pottedNumbers: [number] });
  }
  const { simulator, world } = match;
  const stroke = simulator.stroke;
  simulator.stroke = () => {
    simulator.stroke = stroke;
    simulator.clearResult();
    const black = world.balls.find((ball) => ball.active && ball.number === 7);
    simulator.result.firstKissIndex = black.index;
    simulator.result.nKissed = 1;
    world.inactivateBall(black);
    simulator.result.pottedIndices.push(black.index);
  };
}
