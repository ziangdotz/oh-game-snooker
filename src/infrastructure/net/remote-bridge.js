/**
 * Bridge between the browser match and the authoritative room service.
 * It converts local cue input into room commands and applies server snapshots;
 * it never computes a score, a foul or a turn change on its own.
 */
export default function createRemoteBridge({ room, rooms, simulator, model }) {
  const protocol = room.protocol;
  // Extra time allowed past the track's own duration before the replay is
  // abandoned in favour of the settled authoritative pose.
  const REPLAY_MARGIN_MS = 1500;
  const listeners = new Map();
  let appliedVersion = -1;
  let pendingFinal = null;
  let replayDeadline = null;
  let commandSequence = 0;

  function notify(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
      handler(payload);
    }
  }

  function nextCommandId(prefix) {
    commandSequence += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + commandSequence;
  }

  function normalizeDirection(vars) {
    const length = Math.hypot(vars[3], vars[5]);
    if (!Number.isFinite(length) || length < 1e-9) {
      return null;
    }
    return { x: vars[3] / length, z: vars[5] / length };
  }

  /**
   * Convert the local 8-float stroke ABI into the service's shot command.
   * The strike point and cue axis are forwarded so side spin, follow and draw
   * reach the authoritative physics; the service still derives the impulse
   * from the power curve and rejects geometry that is off the cue ball.
   */
  function toShot(vars) {
    const direction = normalizeDirection(vars);
    if (!direction) {
      return null;
    }
    const axisLength = Math.hypot(vars[3], vars[4], vars[5]);
    const shot = {
      direction,
      power: protocol.powerFromSpeed(vars[6]),
    };
    // A degenerate axis carries no usable cue information; fall back to a
    // centre hit so the shot still reaches the table.
    if (Number.isFinite(axisLength) && axisLength > 1e-6) {
      shot.kiss = { x: vars[0], y: vars[1], z: vars[2] };
      shot.axis = {
        x: vars[3] / axisLength,
        y: vars[4] / axisLength,
        z: vars[5] / axisLength,
      };
    }
    return shot;
  }

  function commandContext() {
    return {
      matchId: room.matchId,
      matchVersion: model._version ?? 0,
      turn: model.getContext('playerIndex'),
    };
  }

  function submitStrokeCommand(command) {
    return rooms.shoot({ ...commandContext(), commandId: nextCommandId('shot'), ...command });
  }

  function submitStroke(vars) {
    const shot = toShot(vars);
    if (!shot) {
      return Promise.reject(
        Object.assign(new Error('Aim the cue before shooting'), { code: 'invalid_shot' }),
      );
    }
    return submitStrokeCommand({ shot });
  }

  function submitPlacement(command) {
    const position = command?.position ?? command;
    return rooms.placeCueBall({
      ...commandContext(),
      commandId: nextCommandId('place'),
      position: { x: position.x, z: position.z },
    });
  }

  /**
   * Apply the newest snapshot once; older versions never overwrite newer ones.
   * A stroke snapshot also carries its motion track, which drives the rendered
   * pose afterwards until the replay catches up with the settled frame.
   */
  function apply(message) {
    if (!message?.snapshot) {
      return false;
    }
    if (message.matchId && message.matchId !== room.matchId) {
      return false;
    }
    const incoming = message.state?.version ?? 0;
    const motion = message.result?.motion ?? null;
    if (incoming < appliedVersion || (incoming === appliedVersion && motion?.frames?.length)) {
      return false;
    }
    appliedVersion = incoming;
    if (motion?.frames?.length) {
      // The settled snapshot is authoritative; the replay only owns rendering.
      model.applySnapshot(message);
      pendingFinal = message;
      notify('motion', motion);
      // A hidden tab, a breakpoint or a stalled render clock must never leave
      // the table stuck mid-replay: force the settled pose after the track's
      // own duration plus a small margin.
      armReplayDeadline(motion);
      return true;
    }
    resetReplay();
    return model.applySnapshot(message);
  }

  /**
   * Called when the local replay reaches the end, or when its deadline expires.
   * The replay overwrote the rendered poses frame by frame, so re-apply the
   * settled snapshot.
   */
  function flush() {
    clearReplayDeadline();
    const message = pendingFinal;
    if (!message) {
      return false;
    }
    pendingFinal = null;
    notify('replay-end');
    return model.applySnapshot({ ...message, result: { ...message.result, motion: null } });
  }

  /** Guarantee the replay hands back control even if no frame is rendered. */
  function armReplayDeadline(motion) {
    clearReplayDeadline();
    const duration = (motion.frames.at(-1)?.t ?? 0) * 1000;
    replayDeadline = setTimeout(() => {
      replayDeadline = null;
      if (pendingFinal) {
        notify('replay-timeout', { duration });
        flush();
      }
    }, duration + REPLAY_MARGIN_MS);
  }

  function clearReplayDeadline() {
    if (replayDeadline !== null) {
      clearTimeout(replayDeadline);
      replayDeadline = null;
    }
  }

  function resetReplay() {
    clearReplayDeadline();
    pendingFinal = null;
    notify('replay-end');
  }

  /** Ask the service for the current authoritative snapshot (initial load, resume). */
  function requestSnapshot() {
    return rooms.requestSnapshot(room.matchId).then((message) => {
      const motion = message.result?.motion ?? null;
      if (motion?.frames?.length) {
        // Reconnecting mid-stroke: skip the replay and show the settled frame.
        model.applySnapshot({ ...message, result: { ...message.result, motion: null } });
      } else {
        apply(message);
      }
      return message;
    });
  }

  function requestRematch() {
    return rooms.requestRematch(room.matchId);
  }

  /** A new frame replaced the finished one: drop the applied version and resync. */
  function resetFrame(matchId) {
    if (matchId) {
      room.matchId = matchId;
    }
    appliedVersion = -1;
    resetReplay();
  }

  function leaveRoom() {
    return rooms.leave().catch(() => null);
  }

  return {
    apply,
    flush,
    toShot,
    submitStroke,
    submitStrokeCommand,
    submitPlacement,
    requestSnapshot,
    requestRematch,
    resetFrame,
    dispose: resetReplay,
    leaveRoom,
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    get appliedVersion() {
      return appliedVersion;
    },
    get simulator() {
      return simulator;
    },
    room,
  };
}
