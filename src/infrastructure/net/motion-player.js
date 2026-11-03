/**
 * Replays one authoritative stroke's motion track on the local balls.
 * The track is a fixed-interval list of ball poses produced by the same physics
 * that judged the shot; the finish snapshot still settles the final state.
 */
export default function createMotionPlayer(local) {
  // A single frame never advances more than one track sample, so a throttled
  // background tab or a breakpoint cannot skip the replay.
  const MAX_STEP = 0.05;
  let track = null;
  let elapsed = 0;
  let frameIndex = 0;
  let startedAt = 0;

  function reset() {
    track = null;
    elapsed = 0;
    frameIndex = 0;
    startedAt = 0;
  }

  function play(motion) {
    if (!motion?.frames?.length) {
      return false;
    }
    track = motion;
    elapsed = 0;
    frameIndex = 0;
    startedAt = Date.now();
    return true;
  }

  function interpolate(a, b, ratio, ball) {
    if (!a || !b) {
      ball.active = false;
      return;
    }
    ball.active = true;
    ball.position.x = a[0] + (b[0] - a[0]) * ratio;
    ball.position.y = a[1] + (b[1] - a[1]) * ratio;
    ball.position.z = a[2] + (b[2] - a[2]) * ratio;
    // Shortest-path quaternion blend; the frames are near each other.
    const dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
    const sign = dot < 0 ? -1 : 1;
    const x = a[3] + (b[3] * sign - a[3]) * ratio;
    const y = a[4] + (b[4] * sign - a[4]) * ratio;
    const z = a[5] + (b[5] * sign - a[5]) * ratio;
    const w = a[6] + (b[6] * sign - a[6]) * ratio;
    const length = Math.hypot(x, y, z, w) || 1;
    ball.orientation.x = x / length;
    ball.orientation.y = y / length;
    ball.orientation.z = z / length;
    ball.orientation.w = w / length;
    ball.states.position.copy(ball.position);
    ball.states.orientation.copy(ball.orientation);
  }

  /**
   * Advance by `dt` seconds. Returns true while another frame is still due.
   * The caller renders after each true result.
   */
  function update(dt) {
    if (!track) {
      return false;
    }
    const frames = track.frames;
    // Wall-clock elapsed keeps the replay at real speed even when the render
    // clock stalls (background tab, headless run); dt only tops it up.
    elapsed = Math.max(
      elapsed + Math.min(Math.max(dt, 0), MAX_STEP),
      (Date.now() - startedAt) / 1000,
    );
    while (frameIndex + 1 < frames.length && frames[frameIndex + 1].t <= elapsed) {
      frameIndex += 1;
    }
    if (frameIndex + 1 >= frames.length) {
      reset();
      return false;
    }
    const from = frames[frameIndex];
    const to = frames[frameIndex + 1];
    const span = to.t - from.t || 1;
    const ratio = Math.min(1, Math.max(0, (elapsed - from.t) / span));
    for (let index = 0; index < local.balls.length; index += 1) {
      interpolate(from.balls[index], to.balls[index], ratio, local.balls[index]);
    }
    return true;
  }

  return {
    play,
    update,
    reset,
    get active() {
      return track !== null;
    },
    /** Playback progress in [0, 1] for diagnostics and acceptance sampling. */
    get progress() {
      if (!track) {
        return 1;
      }
      const end = track.frames.at(-1).t || 1;
      return Math.min(1, elapsed / end);
    },
    get frame() {
      return frameIndex;
    },
  };
}
