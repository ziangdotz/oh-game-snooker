/**
 * Remote (room) match wiring: the same camera and aiming flow as a local match,
 * but a stroke or cue placement becomes a room command, and ball positions,
 * scores and the turn come back from authoritative snapshots.
 */
import createMotionPlayer from '../../infrastructure/net/motion-player.js';

export default function createRemoteMatchController(MatchController, dependencies) {
  return class RemoteMatchController extends MatchController {
    constructor(application) {
      super(application);
      this._remote = null;
      this._remoteOff = [];
      this._readyEmitted = false;
    }
    get isRemote() {
      return Boolean(this._remote);
    }
    launch(options) {
      this._readyEmitted = false;
      this._finished = false;
      this._rematchCount = 0;
      this._result = null;
      this._motion = null;
      super.launch(options);
    }
    _onItemsReady() {
      const remote = dependencies.session.room;
      if (!remote) {
        super._onItemsReady();
        return;
      }
      if (
        this._gView.state !== dependencies.ViewState.READY ||
        this._simulator.state !== dependencies.SimulationState.a.SYNCHRONIZED
      ) {
        return;
      }
      remote.world = this._simulator.world;
      this._connectRemote();
      // Online matches never run the local reset, so build the physics
      // environment here; deserializing a snapshot requires it.
      const world = this._simulator.world;
      if (world && !world._environmentReady) {
        this._simulator.reset(false, true);
      }
      // The base readiness path ends in a local `reqReset`, which an online
      // frame must never run; mirror its setup and release PENDING directly.
      this._enterAnimation ||= new dependencies.PropertyTween((t) => {
        const camera = this._gView.camera;
        camera.position.x = t.x;
        camera.position.y = t.y;
        camera.position.z = t.z;
        camera.lockedTarget.x = t.lookAtX;
        camera.lockedTarget.y = t.lookAtY;
        camera.lockedTarget.z = t.lookAtZ;
        this._gView.requireRender();
      });
      this._createPlayerControllers();
      const movie = this._movieClip;
      movie.getTrack('cam').setSource(this._gView.camera).setActor(this._gView.camera);
      movie.syncBallTracks(this._simulator, this._gView.ballMeshes);
      this._gView.removeAllListeners(dependencies.ViewEvents.READY);
      this._simulator.removeAllListeners(dependencies.SimulationEvents.a.SYNCHRONIZED);
      this._model
        .on('response', (response) => {
          this._onModelResponse(response);
          this._emitReadyOnce();
        })
        .on('gstate_change', (state) => {
          this._onModelGStateChanged(state);
        });
      this._emitReadyOnce();
      const bridge = this._remote;
      bridge
        .requestSnapshot()
        .then(() => {
          if (this._remote !== bridge) {
            return;
          }
          const state = dependencies.session.rooms.state;
          if (state?.status === 'finished' && state.match?.result) {
            this._onRemoteFinished({ result: state.match.result });
          }
        })
        .catch((error) => {
          if (this._remote === bridge) {
            this._onRemoteError(error);
          }
        });
    }
    /** Emit the controller READY event at most once, whatever releases it. */
    _emitReadyOnce() {
      if (this._readyEmitted) {
        return false;
      }
      this._readyEmitted = true;
      this.emit(dependencies.ControllerEvents.READY);
      return true;
    }
    _connectRemote() {
      const room = dependencies.session.room;
      const rooms = dependencies.session.rooms;
      if (!room || !rooms || this._remote) {
        return false;
      }
      if (!room.world) {
        room.world = this._simulator.world;
      }
      const bridge = dependencies.createRemoteBridge({
        room,
        rooms,
        simulator: this._simulator,
        model: this._model,
      });
      // The model holds the room descriptor, so the commands live there too.
      room.submitShot = (command) => bridge.submitStrokeCommand(command);
      room.submitPlacement = (command) => bridge.submitPlacement(command);
      room.requestSnapshot = () => bridge.requestSnapshot();
      this._remote = bridge;
      this._motion = createMotionPlayer(this._simulator.world);
      // A rejected command must not escape as an unhandled rejection: restore
      // readiness and report the service's reason to the player.
      this._simulator.enterRemote((vars) => {
        bridge.submitStroke(vars).catch((error) => this._onRemoteError(error));
      });
      this._remoteOff.push(
        rooms.on('snapshot', (message) => bridge.apply(message)),
        rooms.on('finished', (message) => this._onRemoteFinished(message)),
        rooms.on('rematch', (message) => this._onRemoteRematch(message)),
        rooms.on('closed', () => {
          this.emit(dependencies.ApplicationEvents.CHANGE_CONTROLLER, 'home');
          this._uiLayer?.message('ROOM', 'The room closed because your opponent left.', 2);
        }),
        rooms.on('error', (error) => this._onRemoteError(error)),
        bridge.on('motion', (motion) => this._motion?.play(motion)),
        bridge.on('replay-end', () => this._motion?.reset()),
        // If the replay misses its deadline the bridge applies the settled pose
        // itself; drop the local track so the table is not stuck replaying.
        bridge.on('replay-timeout', () => this._motion?.reset()),
      );
      return true;
    }
    _createPlayerControllers() {
      if (!this.isRemote) {
        super._createPlayerControllers();
        return;
      }
      const seatIndex = this._model.remoteSeatIndex;
      this._fpc.reset(
        this._gView,
        this._simulator,
        this._model,
        seatIndex,
        this._model.players[seatIndex].getInfoData('stickName'),
      );
      this._playerCtls.push(this._fpc);
    }
    _syncRemoteBalls() {
      const world = this._simulator.world;
      if (world && world.evolution !== this._gView.ballSyncEvolution) {
        this._gView.syncBalls(this._simulator.getBalls(), world.evolution);
      }
    }
    /**
     * The base handler syncs the settled ball poses from the authoritative
     * snapshot. During a replay the motion player owns the rendered pose, so
     * only the HUD and control phase may update here.
     */
    _onModelResponse(response) {
      if (this.isRemote && (response?.motionReplay || this._motion?.active)) {
        const model = this._model;
        const playerIndex = model.getContext('playerIndex');
        const ballOn = model.getContext('ballOn');
        const scoreBar = this._uiLayer.getRegisteredUI('scoreBar');
        scoreBar?.syncResults(model.players, playerIndex, ballOn);
        for (const name in this._subControl) {
          this._subControl[name].onModelResponse(model);
        }
        if (this._activeSubControl?.name !== 'gaming') {
          this._activateSubControl('gaming');
        }
        this._syncGameStatus();
        return;
      }
      super._onModelResponse(response);
    }
    _onRemoteError(error) {
      if (!['not_your_turn', 'stale_match', 'wrong_turn'].includes(error?.code)) {
        this._uiLayer?.message('ROOM', error?.message ?? 'Room command failed.', 3);
      }
      if (this._model.gState === dependencies.GameState.a.SIMULATING) {
        this._model._changeState(dependencies.GameState.a.READY);
        this._syncGameStatus();
      }
    }
    _syncGameStatus() {
      super._syncGameStatus();
      const scoreboard = this._uiLayer?.getRegisteredUI('scoreBar');
      if (!this.isRemote || !scoreboard) {
        return;
      }
      if (this._finished) {
        scoreboard.setStatus(this._rematchCount > 0 ? 'REMATCH REQUESTED' : 'FRAME COMPLETE');
      } else if (this._model.gState === dependencies.GameState.a.SIMULATING) {
        scoreboard.setStatus('WAITING FOR SERVER');
      } else if (this._model.getContext('playerIndex') !== this._model.remoteSeatIndex) {
        scoreboard.setStatus('OPPONENT TURN');
      }
    }
    /** The frame is over: show the authoritative result and offer a rematch. */
    _onRemoteFinished(message) {
      if (this._finished) {
        return;
      }
      this._finished = true;
      this._remote?.flush();
      for (const name of ['controlsNaviBox', 'controlsGuideBox', 'pauseBox', 'confirm']) {
        if (this._uiLayer.hasRegisteredBox(name)) {
          this._uiLayer.closeBox(name);
        }
      }
      this._result = message.result ?? null;
      this._rematchCount = 0;
      const result = this._result ?? {
        draw: false,
        winnerIndex: null,
        players: this._model.players.map((player) => ({
          displayName: player.displayName,
          pts: player.pts,
          penalty: player.penalty,
          maxbrk: player.maxbrk,
          accuracy: player.accuracy,
        })),
      };
      this._syncGameStatus();
      this._showRemoteResult(result);
    }
    /**
     * Online frames never open the local result dialog: the authoritative
     * `finished` event decides the headline, the statistics and the rematch.
     */
    _showResult() {
      if (this.isRemote) {
        return;
      }
      super._showResult();
    }
    _showRemoteResult(result) {
      const scores = result.players.map(
        (player, index) => player.pts - result.players[1 - index].penalty,
      );
      const winner = result.draw
        ? 'DRAW'
        : result.players[result.winnerIndex ?? (scores[0] > scores[1] ? 0 : 1)].displayName;
      const headline = result.draw ? 'DRAW' : winner.toUpperCase() + ' WINS';
      const dialog = this._uiLayer.popBox('duoResultBox', {
        time: this._gameTime,
        players: result.players.map((player) => ({ ...player, type: 0 })),
      });
      // The online result is never a single-player retry: both seats must agree.
      dialog._retryBn.textContent = 'REMATCH';
      dialog._closeBn.textContent = 'LEAVE ROOM';
      dialog.head(headline);
      dialog._head.className = 'box-head bright-copy';
      dialog.on('retry', () => this._requestRematch());
      dialog.on(dependencies.dialogEvents.USER_CLOSE, () => this._leaveRoomAfterResult());
      this._resultDialog = dialog;
    }
    _requestRematch() {
      if (!this._remote || !this._finished) {
        return;
      }
      this._remote
        .requestRematch()
        .then(() => {
          this._rematchCount = 1;
          this._syncGameStatus();
          this._resultDialog?.setStatus?.('WAITING FOR OPPONENT');
        })
        .catch((error) => this._onRemoteError(error));
    }
    /** A new authoritative frame replaced the finished one; reset the local table. */
    _onRemoteRematch(message) {
      this._finished = false;
      this._rematchCount = 0;
      this._result = null;
      this._uiLayer?.closeBox('duoResultBox');
      this._resultDialog = null;
      const room = dependencies.session.room;
      if (room && message.matchId) {
        room.matchId = message.matchId;
      }
      if (this._remote) {
        this._remote.resetFrame(message.matchId);
      }
      if (message.snapshot) {
        this._remote?.apply(message);
      }
      this._syncGameStatus();
    }
    _leaveRoomAfterResult() {
      this.emit(dependencies.ApplicationEvents.CHANGE_CONTROLLER, 'home');
    }
    /**
     * Online matches enter the table without the local camera fly-in: the
     * authoritative snapshot is already the authoritative view, and the
     * entering phase must not depend on local player-controller state.
     */
    enter() {
      if (!this.isRemote) {
        super.enter();
        return;
      }
      for (const name in this._subControl) {
        this._subControl[name].bind(
          this._gView,
          this._model,
          this._simulator,
          this._fpc,
          this._playerCtls,
          this._subControlEvtBus,
        );
      }
      // The local path places every player controller before the first frame;
      // an online seat still needs its over-the-ball camera stance.
      const settings = this._model.getControllerSetting();
      const active = this._model.getContext('playerIndex');
      for (const controller of this._playerCtls) {
        controller.syncEnter(settings, controller.gPlayerIndex === active ? Math.PI : 0);
        controller.activate();
      }
      this._enterAnimation?.end?.();
      this._gView.requireRender();
      if (this._simulator.evolution !== this._gView.ballSyncEvolution) {
        this._gView.syncBalls(this._simulator.getBalls(), this._simulator.evolution);
      }
      this._state = dependencies.ControllerState.ENTERING;
      // The base controller activates a sub-control during action(); an online
      // frame must have one bound before the acting loop calls update().
      this._holdingSubControlName = this._model.getContext('inHand') > 1 ? 'inHand' : 'gaming';
      this.emit(dependencies.ControllerEvents.ENTERED);
    }
    /**
     * Animate a running authoritative motion track. This only replays the
     * approved stroke; ball authority still belongs to the served snapshots.
     */
    updateActing(timer) {
      // Online matches replay the served motion track before the table resumes.
      // The finished pose is applied by the bridge once the replay completes.
      if (this.isRemote && this._motion?.active) {
        const running = this._motion.update(timer.dt);
        // The world evolution does not change during a replay, so the shared
        // de-duplication would skip the sync; push the interpolated poses.
        this._gView.syncBalls(this._simulator.getBalls(), this._replayEvolution());
        this._gView.requireRender();
        if (!running) {
          this._motion.reset();
          this._remote?.flush();
        }
      }
      super.updateActing(timer);
    }
    /** A per-frame evolution stamp keeps replay syncs distinct from the world's. */
    _replayEvolution() {
      this._replayFrame = (this._replayFrame ?? 0) + 1;
      return -this._replayFrame;
    }
    exit() {
      if (this.isRemote) {
        for (const name of [
          'controlsNaviBox',
          'controlsGuideBox',
          'pauseBox',
          'confirm',
          'duoResultBox',
        ]) {
          if (this._uiLayer.hasRegisteredBox(name)) {
            this._uiLayer.closeBox(name);
          }
        }
        this._uiLayer.clearGameNotices();
      }
      this._remote?.dispose();
      this._remote?.leaveRoom();
      dependencies.session.room = null;
      dependencies.session.rooms = null;
      for (const off of this._remoteOff) {
        off();
      }
      this._remoteOff.length = 0;
      this._remote = null;
      this._simulator?.enterLocal?.();
      super.exit();
    }
  };
}
