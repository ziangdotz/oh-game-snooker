import { captureMatchSnapshot, createHeadlessMatch } from './headless-match-model.mjs';
import createStrokeRecorder from './stroke-recorder.mjs';

const CUE_TIP_RADIUS = 0.005;
const MAX_SETTLE_STEPS = 2000;
// An off-centre strike keeps the point near the ball surface, but a client may
// legitimately send a point slightly inside it. Only a point at the exact centre
// is meaningless (the contact normal would be undefined), and a point well
// outside the ball cannot be a strike at all.
const MIN_KISS_FRACTION = 0.05;
const MAX_KISS_FRACTION = 1.1;

export class MatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MatchError';
    this.code = code;
  }
}

function normalizeDirection(direction) {
  if (
    !direction ||
    typeof direction !== 'object' ||
    !Number.isFinite(direction.x) ||
    !Number.isFinite(direction.z)
  ) {
    throw new MatchError('invalid_shot', 'shot.direction must contain finite x and z');
  }
  const length = Math.hypot(direction.x, direction.z);
  if (length < 1e-9) {
    throw new MatchError('invalid_shot', 'shot.direction must not be zero');
  }
  return { x: direction.x / length, z: direction.z / length };
}

/**
 * Build the 8-float stroke ABI the physics kernel consumes:
 *   [kissX, kissY, kissZ, dirX, dirY, dirZ, speed, tipRadius]
 * The speed is always recomputed from `power` on the server so a client cannot
 * request an arbitrary impulse. When the client supplies its own strike point
 * and cue axis, those are used verbatim after a geometry check: that is what
 * carries side spin, follow and draw without trusting the client's impulse.
 */
function createStrokeVars(match, shot) {
  const direction = normalizeDirection(shot.direction);
  const power = shot.power;
  if (!Number.isFinite(power) || power < 0 || power > 1) {
    throw new MatchError('invalid_shot', 'shot.power must be between 0 and 1');
  }
  const cue = match.world.balls[0];
  const radius = match.layout.ballRadius;
  const tipRadius = CUE_TIP_RADIUS;
  const vars = new Float32Array(8);
  if (shot.kiss && shot.axis) {
    const offset = {
      x: shot.kiss.x - cue.position.x,
      y: shot.kiss.y - cue.position.y,
      z: shot.kiss.z - cue.position.z,
    };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    // The strike point must still sit on the playable face of the cue ball.
    if (distance < radius * MIN_KISS_FRACTION || distance > radius * MAX_KISS_FRACTION) {
      throw new MatchError('invalid_shot', 'shot.kiss is off the cue ball surface');
    }
    // The cue must push into the ball, not pull away from it.
    const inward = offset.x * shot.axis.x + offset.y * shot.axis.y + offset.z * shot.axis.z;
    if (inward > 0) {
      throw new MatchError('invalid_shot', 'shot.axis must point into the cue ball');
    }
    vars[0] = shot.kiss.x;
    vars[1] = shot.kiss.y;
    vars[2] = shot.kiss.z;
    vars[3] = shot.axis.x;
    vars[4] = shot.axis.y;
    vars[5] = shot.axis.z;
  } else {
    vars[0] = cue.position.x - direction.x * radius;
    vars[1] = cue.position.y;
    vars[2] = cue.position.z - direction.z * radius;
    vars[3] = direction.x;
    vars[4] = 0;
    vars[5] = direction.z;
  }
  vars[6] = (0.5 + 11 * power) * (3.2 + 6 * power);
  vars[7] = tipRadius;
  return vars;
}

/**
 * Authoritative match session. It owns a real WorldClient, Simulator and
 * HotseatGameModel; clients only submit cue parameters.
 */
export async function createMatchSession({ loadModule, names }) {
  const match = await createHeadlessMatch(loadModule, { names });
  const { model, simulator } = match;
  const commands = new Map();
  let version = 0;

  function state() {
    return {
      version,
      turn: model.getContext('playerIndex'),
      nRounds: model.getContext('nRounds'),
      ballOn: model.getContext('ballOn'),
      inHand: model.getContext('inHand'),
    };
  }

  function snapshot() {
    return captureMatchSnapshot(match);
  }

  function shoot({ playerIndex, commandId, matchVersion, turn, shot }) {
    if (commands.has(commandId)) {
      return commands.get(commandId);
    }
    if (!Number.isInteger(matchVersion) || matchVersion !== version) {
      throw new MatchError('stale_match', 'Match version is not current');
    }
    if (!Number.isInteger(turn) || turn !== model.getContext('playerIndex')) {
      throw new MatchError('wrong_turn', 'It is not this player’s turn');
    }
    if (playerIndex !== model.getContext('playerIndex')) {
      throw new MatchError('wrong_turn', 'Only the current player can shoot');
    }
    if (model.getContext('inHand') > 1) {
      throw new MatchError('ball_in_hand', 'Place the cue ball before shooting');
    }
    const strokeVars = createStrokeVars(match, shot);
    if (!model.reportPlayerStroke(playerIndex)) {
      throw new MatchError('not_ready', 'The match is not accepting a stroke');
    }
    const recorder = createStrokeRecorder();
    const world = match.world;
    recorder.start(world);
    simulator.stroke(strokeVars);
    let steps = 0;
    while (simulator.nAwakened !== 0) {
      if (++steps > MAX_SETTLE_STEPS) {
        throw new MatchError('simulation_timeout', 'The shot did not settle');
      }
      recorder.advance(world, 0.1);
      simulator.step(0.1);
    }
    const motion = recorder.stop(world);
    const roundsBefore = model.getContext('nRounds');
    model.reqRoundResult(simulator);
    if (model.getContext('nRounds') !== roundsBefore + 1) {
      throw new MatchError('referee_failed', 'The referee did not accept the round result');
    }
    version += 1;
    const result = {
      commandId,
      version,
      turnBefore: turn,
      nextTurn: model.getContext('playerIndex'),
      score: model._refResult.score,
      foulCode: model._refResult.foulCode,
      simulator: {
        nKissed: simulator.result.nKissed,
        firstKissIndex: simulator.result.firstKissIndex,
        pottedIndices: [...simulator.result.pottedIndices],
        outOfBoundsIndices: [...simulator.result.outOfBoundsIndices],
      },
      motion,
      state: state(),
      snapshot: snapshot(),
    };
    commands.set(commandId, result);
    return result;
  }

  function placeCueBall({ playerIndex, commandId, matchVersion, turn, position }) {
    if (commands.has(commandId)) {
      return commands.get(commandId);
    }
    if (!Number.isInteger(matchVersion) || matchVersion !== version) {
      throw new MatchError('stale_match', 'Match version is not current');
    }
    if (!Number.isInteger(turn) || turn !== model.getContext('playerIndex')) {
      throw new MatchError('wrong_turn', 'It is not this player’s turn');
    }
    if (playerIndex !== model.getContext('playerIndex')) {
      throw new MatchError('wrong_player', 'Only the current player can place the cue ball');
    }
    if (model.getContext('inHand') === 0) {
      throw new MatchError('not_in_hand', 'The cue ball is not in hand');
    }
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      throw new MatchError('invalid_position', 'Cue-ball position must contain finite x and z');
    }
    model.reqRespotCueball({ x: position.x, y: simulator.spotY, z: position.z }, simulator);
    if (model.getContext('inHand') > 1) {
      throw new MatchError('invalid_position', 'Cue-ball position is outside the allowed area');
    }
    version += 1;
    const result = {
      commandId,
      version,
      playerIndex,
      state: state(),
      snapshot: snapshot(),
    };
    commands.set(commandId, result);
    return result;
  }

  return {
    match,
    state,
    snapshot,
    shoot,
    placeCueBall,
    get version() {
      return version;
    },
  };
}
