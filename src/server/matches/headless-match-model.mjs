import createBaseGameModel from '../../application/models/base-game-model.js';
import createSnookerGameModel from '../../application/models/snooker-game-model.js';
import createHotseatGameModel from '../../application/models/hotseat-game-model.js';
import { loadCollisionMesh } from './runtime-loader.mjs';

const DEFAULT_NAMES = ['Headless One', 'Headless Two'];

function createSettings(layout, names) {
  return {
    getGameDefineData(key) {
      return layout[key];
    },
    getLocalUserInfo() {
      return {
        userId: 'headless-player-1',
        displayName: names[0],
        stickName: 'stickAlpha',
      };
    },
    getGameSettings() {
      return {
        camera: { fov: 0.88, minZ: 0.01 },
        personController: {
          eyeStandHeight: 1.7,
          eyeSquatHeight: 1,
          innerTrackRadius: 0.38,
        },
      };
    },
    restore() {
      return true;
    },
  };
}

/** Build the same simulator, two-player model and standard referee used by the game. */
export async function createHeadlessMatch(loadModule, { names = DEFAULT_NAMES } = {}) {
  if (!Array.isArray(names) || names.length !== 2) {
    throw new Error('Headless match requires exactly two player names');
  }
  const WorldClient = loadModule('domain/physics/world-client');
  const Simulator = loadModule('domain/simulation/simulator');
  const layout = loadModule('domain/scene/initial-layout').default;
  const gameRecords = loadModule('domain/game/game-records');
  const GameState = loadModule('domain/game/game-state');
  const Player = loadModule('domain/game/player');
  const EventEmitter = loadModule('shared/events/event-emitter');
  const refereeRegistry = loadModule('domain/rules/referee-registry');
  const mesh = await loadCollisionMesh(loadModule);
  const world = new WorldClient();
  const simulator = new Simulator('headless-match', world, {
    getCache() {
      return mesh.body;
    },
  });
  const settings = createSettings(layout, names);
  const BaseGameModel = createBaseGameModel({
    EventEmitter: { a: EventEmitter },
    localGameSettings: settings,
  });
  const SnookerGameModel = createSnookerGameModel({
    BaseGameModel,
    GameState: { a: GameState },
    Player: { a: Player },
    aiRegistry: { getSelectedAIInfo: () => null },
    gameRecords: { a: gameRecords },
    localGameSettings: settings,
    refereeRegistry: { a: refereeRegistry },
    nextStartingPlayer: 0,
  });
  const HotseatGameModel = createHotseatGameModel(SnookerGameModel, {
    session: { config: { names } },
    localGameSettings: settings,
    GameState: { a: GameState },
    Player: { a: Player },
    refereeRegistry: { a: refereeRegistry },
  });
  const model = new HotseatGameModel();
  const definition = await new Promise((resolve) => {
    model.asyncLaunch(resolve);
  });
  simulator.sync(definition);
  model.reqReset(simulator);
  return {
    world,
    simulator,
    model,
    mesh,
    layout,
    definition,
    settings,
    gameRecords,
    GameState,
    vectorThree: loadModule('domain/math/vector-three'),
    worldClass: loadModule('domain/physics/world'),
  };
}

function serializeBall(ball) {
  return {
    index: ball.index,
    number: ball.number,
    active: ball.active,
    position: [ball.position.x, ball.position.y, ball.position.z],
    velocity: [ball.v.x, ball.v.y, ball.v.z],
    spin: [ball.w.x, ball.w.y, ball.w.z],
    orientation: [ball.orientation.x, ball.orientation.y, ball.orientation.z, ball.orientation.w],
    spot: [ball.spot.x, ball.spot.y, ball.spot.z],
  };
}

export function captureMatchSnapshot(match) {
  const { model, simulator, world, worldClass } = match;
  const serial = worldClass.makeSerialData();
  world.serialize(serial);
  return {
    schemaVersion: 1,
    match: {
      state: model.gState,
      context: { ...model._gContext },
      result: { ...model._refResult },
      players: model.players.map((player) => ({
        id: player.id,
        displayName: player.displayName,
        type: player.type,
        pts: player.pts,
        brk: player.brk,
        maxbrk: player.maxbrk,
        penalty: player.penalty,
        shootingCount: player.shootingCount,
        scoreCount: player.scoreCount,
        accuracy: player.accuracy,
      })),
      referee: {
        refId: model._locRef ? match.settings.getGameDefineData('refId') : null,
        sceneId: model._locRef?._sceneId ?? null,
        reservedBallOn: model._locRef?.sysReservedBallOn ?? null,
      },
    },
    physics: {
      serial,
      evolution: world.evolution,
      mbid: world.meshBody.id ?? null,
      nAwakened: world.nAwakened,
      accumulator: world.accumulator ?? 0,
      stepSize: world.stepSize,
    },
    mesh: {
      sceneId: match.definition.sceneId,
      polygons: match.mesh.body.nPolygons,
      groups: match.mesh.body.groups.map((group) => group.name),
    },
    simulator: {
      state: simulator.state,
      nAwakened: simulator.nAwakened,
      result: {
        nKissed: simulator.result.nKissed,
        firstKissIndex: simulator.result.firstKissIndex,
        pottedIndices: [...simulator.result.pottedIndices],
        outOfBoundsIndices: [...simulator.result.outOfBoundsIndices],
      },
    },
    balls: world.balls.map(serializeBall),
  };
}

export async function restoreHeadlessMatch(loadModule, snapshot, options = {}) {
  const match = await createHeadlessMatch(loadModule, options);
  const { model, simulator, world } = match;
  world.deserialize(snapshot.physics.serial);
  world.accumulator = snapshot.physics.accumulator;
  model._gState = snapshot.match.state;
  model._gContext = { ...snapshot.match.context };
  model._refResult = { ...snapshot.match.result };
  for (const [index, state] of snapshot.match.players.entries()) {
    const player = model.players[index];
    player.pts = state.pts;
    player.penalty = state.penalty;
    player._brk = state.brk;
    player._maxBrk = state.maxbrk;
    player.shootingCount = state.shootingCount;
    player.scoreCount = state.scoreCount;
  }
  simulator._state = snapshot.simulator.state;
  simulator._nPhxAwakened = snapshot.simulator.nAwakened;
  simulator._result.nKissed = snapshot.simulator.result.nKissed;
  simulator._result.firstKissIndex = snapshot.simulator.result.firstKissIndex;
  simulator._result.pottedIndices = [...snapshot.simulator.result.pottedIndices];
  simulator._result.outOfBoundsIndices = [...snapshot.simulator.result.outOfBoundsIndices];
  return match;
}
