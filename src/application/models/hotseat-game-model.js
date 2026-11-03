/**
 * Two human identities share the original referee and round-result implementation.
 * In remote mode the same identities come from a room, and the referee result plus
 * all ball motion arrive in authoritative snapshots instead of local simulation.
 */
export default function createHotseatGameModel(SnookerGameModel, dependencies) {
  return class HotseatGameModel extends SnookerGameModel {
    get isHotseat() {
      return this._mode === 'hotseat';
    }
    get isRemote() {
      return this._mode === 'remote';
    }
    get remoteSeatIndex() {
      return this._seatIndex ?? 0;
    }
    get remoteMatchId() {
      return this._room?.matchId ?? null;
    }
    asyncLaunch(callback) {
      const config = dependencies.session.room
        ? dependencies.session.room
        : dependencies.session.config;
      if (dependencies.session.room) {
        this._launchRemote(dependencies.session.room, callback);
        return;
      }
      this._mode = config ? 'hotseat' : 'local';
      if (!config) {
        super.asyncLaunch(callback);
        return;
      }
      this.release();
      this._mode = 'hotseat';
      this._nextOpener = 0;
      this._changeState(dependencies.GameState.a.PENDING);
      const definition = this._definition();
      const info = dependencies.localGameSettings.getLocalUserInfo();
      for (const [index, displayName] of config.names.entries()) {
        this._players.push(
          new dependencies.Player.a(
            { ...info, userId: 'hotseat-player-' + (index + 1), displayName },
            dependencies.Player.a.PLAYER_TYPE_USER,
          ),
        );
      }
      definition.stickName = [info.stickName];
      this._locRef = dependencies.refereeRegistry.a.getInstance(
        dependencies.localGameSettings.getGameDefineData('refId'),
      );
      callback(definition);
    }
    _definition() {
      const settings = dependencies.localGameSettings;
      return Object.fromEntries(
        ['sceneId', 'ballSet', 'ballRadius', 'ballMass'].map((key) => [
          key,
          settings.getGameDefineData(key),
        ]),
      );
    }
    _launchRemote(room, callback) {
      this.release();
      this._mode = 'remote';
      this._room = room;
      this._seatIndex = room.seats.findIndex((seat) => seat.playerId === room.seat.playerId);
      if (this._seatIndex < 0) {
        throw new Error('The room does not contain the local seat');
      }
      this._changeState(dependencies.GameState.a.PENDING);
      const definition = this._definition();
      const info = dependencies.localGameSettings.getLocalUserInfo();
      for (const seat of room.seats) {
        this._players.push(
          new dependencies.Player.a(
            { ...info, userId: seat.playerId, displayName: seat.displayName },
            dependencies.Player.a.PLAYER_TYPE_USER,
          ),
        );
      }
      definition.stickName = [info.stickName];
      this._locRef = dependencies.refereeRegistry.a.getInstance(
        dependencies.localGameSettings.getGameDefineData('refId'),
      );
      callback(definition);
    }
    /** True only while the authoritative state says this seat may act. */
    canAct(index) {
      return (
        this.isRemote &&
        this._gState === dependencies.GameState.a.READY &&
        !this._replaying &&
        Number.isInteger(index) &&
        index >= 0 &&
        this._gContext.playerIndex === index
      );
    }
    /**
     * Apply one authoritative room snapshot. Ball positions, referee context,
     * statistics and match state all come from the service.
     */
    applySnapshot(message) {
      const { snapshot, state } = message;
      const world = this._room?.world;
      if (!this.isRemote || !snapshot || !world) {
        return false;
      }
      this._version = state?.version ?? this._version ?? 0;
      this._replaying = Boolean(message.result?.motion?.frames?.length);
      world.deserialize(snapshot.physics.serial);
      world.accumulator = snapshot.physics.accumulator ?? 0;
      // Rendered states trail the physics body, so every applied snapshot must
      // also refresh each ball state used by the renderer.
      for (const ball of world.balls) {
        ball.states.position.copy(ball.position);
        ball.states.orientation.copy(ball.orientation);
      }
      this._gContext = { ...snapshot.match.context };
      this._refResult = { ...snapshot.match.result };
      for (const [index, entry] of snapshot.match.players.entries()) {
        const player = this._players[index];
        if (!player) {
          continue;
        }
        player.pts = entry.pts;
        player.penalty = entry.penalty;
        player.brk = entry.brk;
        player.shootingCount = entry.shootingCount;
        player.scoreCount = entry.scoreCount;
      }
      const changedState = this._gState !== snapshot.match.state;
      if (changedState) {
        this._changeState(snapshot.match.state);
      }
      this.emit('response', {
        ...snapshot.match.result,
        version: this._version,
        // While replaying, the response must not let the controller sync the
        // settled poses; the motion player owns the rendered position then.
        motionReplay: this._replaying,
      });
      return true;
    }
    takePendingSnapshot() {
      const pending = this._pendingSnapshot;
      this._pendingSnapshot = null;
      return pending;
    }
    queueSnapshot(message) {
      this._pendingSnapshot = message;
    }
    reportPlayerStroke(playerIndex) {
      if (!this.isRemote) {
        return super.reportPlayerStroke(playerIndex);
      }
      if (!this.canAct(playerIndex)) {
        return false;
      }
      this._changeState(dependencies.GameState.a.SIMULATING);
      return true;
    }
    reqRoundResult() {
      if (!this.isRemote) {
        return super.reqRoundResult(...arguments);
      }
      // The service already judged this stroke; there is nothing local to resolve.
      return undefined;
    }
    reqRespotCueball(position) {
      if (!this.isRemote) {
        return super.reqRespotCueball(...arguments);
      }
      if (this._gState !== dependencies.GameState.a.READY) {
        return undefined;
      }
      if (this._replaying) {
        return Promise.reject(
          Object.assign(new Error('Wait for the shot to settle'), { code: 'not_ready' }),
        );
      }
      return this._room?.submitPlacement?.({
        matchId: this._room.matchId,
        matchVersion: this._version ?? 0,
        turn: this._gContext.playerIndex,
        position: { x: position.x, z: position.z },
      });
    }
    reqReset(simulator) {
      if (this.isRemote) {
        // Restarting an online frame is a two-player decision handled by the room.
        return undefined;
      }
      if (!this.isHotseat) {
        return super.reqReset(simulator);
      }
      const states = dependencies.GameState.a;
      if (this.gState & (states.ERROR | states.NO_GAME)) {
        return;
      }
      const pending = this.gState === states.PENDING;
      this._changeState(states.JUDGING);
      return this._onResetResponse(simulator, pending, this._nextOpener++ % 2, 0);
    }
    release() {
      this._mode = null;
      this._room = null;
      this._seatIndex = 0;
      this._pendingSnapshot = null;
      this._version = 0;
      super.release();
    }
  };
}
