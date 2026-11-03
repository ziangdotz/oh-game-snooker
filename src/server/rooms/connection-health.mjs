/**
 * Connection health for the room service: heartbeat, per-socket rate limiting
 * and the timers that retire abandoned rooms. Kept separate from the message
 * handlers so the policies are inspectable and testable on their own.
 */

/** A socket that misses this many heartbeats in a row is considered dead. */
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_MISSED_HEARTBEATS = 2;
/** Inbound commands per second, with a small burst allowance. */
const RATE_LIMIT_PER_SECOND = 20;
const RATE_LIMIT_BURST = 40;
/** How long a seat may stay offline before its room is retired. */
const DISCONNECT_GRACE_MS = 120000;
/** Hard cap on simultaneous sockets, so one client cannot exhaust the process. */
const MAX_CONNECTIONS = 256;

export class RateLimiter {
  constructor({ rate = RATE_LIMIT_PER_SECOND, burst = RATE_LIMIT_BURST, now = Date.now } = {}) {
    this._rate = rate;
    this._burst = burst;
    this._now = now;
  }

  /** Fresh bucket for one socket. */
  createBucket() {
    return { tokens: this._burst, updatedAt: this._now() };
  }

  /** Consume one token; false means the caller must be throttled. */
  take(bucket) {
    const now = this._now();
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this._burst, bucket.tokens + elapsed * this._rate);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }
}

/**
 * Owns the interval timers. `onHeartbeat` is called for every live socket, the
 * caller answers by pinging and marking the socket; `onSweep` retires idle
 * rooms. Both are injected so the server stays in charge of its own state.
 */
export function createConnectionHealth({
  onHeartbeat,
  onSweep,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  sweepMs = 15000,
} = {}) {
  let heartbeatTimer = null;
  let sweepTimer = null;

  function start() {
    if (!heartbeatTimer && onHeartbeat) {
      heartbeatTimer = setInterval(onHeartbeat, heartbeatMs);
      heartbeatTimer.unref?.();
    }
    if (!sweepTimer && onSweep) {
      sweepTimer = setInterval(onSweep, sweepMs);
      sweepTimer.unref?.();
    }
  }

  function stop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return {
    start,
    stop,
    get heartbeatMs() {
      return heartbeatMs;
    },
    get running() {
      return heartbeatTimer !== null;
    },
  };
}

export const CONNECTION_LIMITS = Object.freeze({
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_HEARTBEATS,
  RATE_LIMIT_PER_SECOND,
  RATE_LIMIT_BURST,
  DISCONNECT_GRACE_MS,
  MAX_CONNECTIONS,
});
