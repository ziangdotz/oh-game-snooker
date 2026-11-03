/**
 * One simulator identity for both modes.
 * Local matches forward every call to the real Simulator. Online matches keep
 * the same world for geometry and rendering, but a stroke becomes a command:
 * local physics never advances and the server snapshot supplies the ball state.
 */
export default function createSimulatorRouter(local) {
  const router = Object.create(local);
  let mode = 'local';
  let onStroke = null;
  let pendingStroke = null;

  const forwarded = [
    'sync',
    'getBalls',
    'getBallAtIndex',
    'getCueBallPosition',
    'respotIndexDefault',
    'respotIndexXYZ',
    'resetBallPosition',
    'resetBallXYZ',
    'touchBalls',
    'predict',
    'getPredictionCtx',
    'clearResult',
    'reset',
    'save',
  ];
  for (const name of forwarded) {
    router[name] = (...args) => local[name](...args);
  }

  router.stroke = (vars) => {
    if (mode === 'local') {
      return local.stroke(vars);
    }
    pendingStroke = vars;
    if (onStroke) {
      onStroke(vars);
    }
    return undefined;
  };
  router.step = (dt) => (mode === 'local' ? local.step(dt) : 0);

  Object.defineProperties(router, {
    nAwakened: {
      get: () => (mode === 'local' ? local.nAwakened : 0),
      enumerable: true,
    },
    state: {
      get: () => local.state,
      enumerable: true,
    },
    evolution: {
      get: () => local.evolution,
      enumerable: true,
    },
    sceneId: { get: () => local.sceneId, enumerable: true },
    spotY: { get: () => local.spotY, enumerable: true },
    ballRadius: { get: () => local.ballRadius, enumerable: true },
    stepSize: { get: () => local.stepSize, enumerable: true },
    result: { get: () => local.result, enumerable: true },
    world: { get: () => local._world, enumerable: true },
    mode: { get: () => mode, enumerable: true },
  });

  router.enterRemote = (strokeHandler) => {
    mode = 'remote';
    onStroke = strokeHandler;
    pendingStroke = null;
  };
  router.enterLocal = () => {
    mode = 'local';
    onStroke = null;
    pendingStroke = null;
  };
  router.takePendingStroke = () => {
    const vars = pendingStroke;
    pendingStroke = null;
    return vars;
  };
  return router;
}
