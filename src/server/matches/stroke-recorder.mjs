/**
 * Capture a shot's motion as a compact frame track while the authoritative
 * physics settles, so clients can interpolate instead of teleporting.
 */
const FRAME_INTERVAL = 0.05;
const MAX_FRAMES = 240;

export default function createStrokeRecorder(limit = MAX_FRAMES) {
  let frames = null;
  let elapsed = 0;
  let next = 0;

  function reset() {
    frames = [];
    elapsed = 0;
    next = 0;
  }

  function capture(world) {
    const balls = [];
    for (const ball of world.balls) {
      if (!ball.active) {
        balls.push(null);
        continue;
      }
      balls.push([
        round(ball.position.x),
        round(ball.position.y),
        round(ball.position.z),
        round(ball.orientation.x),
        round(ball.orientation.y),
        round(ball.orientation.z),
        round(ball.orientation.w),
      ]);
    }
    frames.push({ t: round(elapsed), balls });
  }

  /**
   * Advance by `dt` and keep a frame only when the sampled interval elapsed.
   * Returns false once the track is full so callers can stop tracking.
   */
  function advance(world, dt) {
    elapsed += dt;
    if (frames.length === 0) {
      capture(world);
    }
    if (elapsed + 1e-9 < next) {
      return true;
    }
    if (frames.length > limit) {
      frames = null;
      return false;
    }
    capture(world);
    next += FRAME_INTERVAL;
    return frames !== null;
  }

  return {
    start(world) {
      reset();
      capture(world);
      next = FRAME_INTERVAL;
    },
    advance,
    stop(world) {
      if (!frames) {
        return null;
      }
      if (elapsed > (frames.at(-1)?.t ?? -1)) {
        capture(world);
      }
      const track = { interval: FRAME_INTERVAL, frames };
      frames = null;
      return track;
    },
    get active() {
      return frames !== null;
    },
    get frameCount() {
      return frames?.length ?? 0;
    },
  };
}

function round(value) {
  return Math.round(value * 1e5) / 1e5;
}
