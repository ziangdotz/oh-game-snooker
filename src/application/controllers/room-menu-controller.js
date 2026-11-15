/** Room requests, seat recovery and transfer into an authoritative match. */
export default function createRoomMenuController(dependencies) {
  return class RoomMenuController extends dependencies.MenuController {
    _roomEndpoint() {
      const configured = window.__snookerRoomEndpoint;
      if (typeof configured === 'string' && /^wss?:\/\//u.test(configured)) {
        return configured;
      }
      // Optional ?rooms= override for a service on another port or machine.
      const match = /[?&]rooms=([^&]+)/u.exec(window.location.search);
      if (!match) {
        return undefined;
      }
      let value;
      try {
        value = decodeURIComponent(match[1]);
      } catch {
        return undefined;
      }
      return /^wss?:\/\//u.test(value) ? value : undefined;
    }
    _syncRoomDialog() {
      const dialog = this._moreDialog;
      if (!dialog || !this._rooms) {
        return;
      }
      if (dialog.page === 'room' || dialog.page === 'rooms') {
        const state = this._rooms.state;
        if (state && dialog.page === 'room') {
          dialog.setRoom(state, this._rooms.seat);
        }
      }
    }
    _showRoomError(error) {
      const dialog = this._moreDialog;
      if (!dialog || !['rooms', 'room'].includes(dialog.page)) {
        return;
      }
      dialog.setRoomError(error.message || 'The room request failed.');
    }
    async _createRoom({ displayName, interior }) {
      try {
        this._moreDialog.setRoomBusy('Creating room…');
        const message = await this._rooms.createRoom({ displayName, interior });
        this._moreDialog.enterRoom(message.state, {
          roomId: message.roomId,
          playerId: message.playerId,
          token: message.token,
        });
      } catch (error) {
        this._showRoomError(error);
      }
    }
    async _joinRoom({ displayName, roomId }) {
      try {
        this._moreDialog.setRoomBusy('Joining room…');
        const message = await this._rooms.joinRoom({ roomId, displayName });
        this._moreDialog.enterRoom(message.state, {
          roomId: message.roomId,
          playerId: message.playerId,
          token: message.token,
        });
      } catch (error) {
        this._showRoomError(error);
      }
    }
    async _setRoomReady(ready) {
      try {
        await this._rooms.setReady(ready);
      } catch (error) {
        this._showRoomError(error);
      }
    }
    async _startRoomMatch() {
      try {
        this._moreDialog.setRoomBusy('Starting match…');
        await this._rooms.startMatch();
      } catch (error) {
        this._showRoomError(error);
      }
    }
    _enterRoomMatch(state) {
      const match = state.match;
      if (!match) {
        return;
      }
      if (this._pendingRoomMatch === match.matchId) {
        return;
      }
      this._pendingRoomMatch = match.matchId;
      // Hand the seat and the live connection to the match controller so the
      // table becomes the active surface instead of the room panel.
      dependencies.matchSession.room = {
        seat: this._rooms.seat,
        seats: state.seats,
        matchId: match.matchId,
        endpoint: this._rooms.endpoint,
        protocol: dependencies.protocol,
        // The room owns the venue: both seats must render the same hall, so the
        // match never starts on two different backdrops.
        interior: state.interior,
      };
      dependencies.matchSession.rooms = this._rooms;
      dependencies.matchSession.config = null;
      this._alignRoomVenue(state.interior, () => {
        // The menu owns this drawer's animation. Transfer control only after
        // CLOSE, otherwise its inactive modal remains on the shared UI stack.
        if (this._moreDialog?.isActive || this._moreDialog?.needsUpdate) {
          this._roomLaunchReady = true;
          this._uiLayer.closeBox('moreThingsBox');
        } else {
          this.emit(dependencies.ApplicationEvents.CHANGE_CONTROLLER, 'game');
        }
      });
    }
    /**
     * Switch to the venue the room was created in before the table comes up.
     * A seat that is already standing in that hall proceeds immediately, so the
     * common case costs nothing.
     */
    _alignRoomVenue(venue, launch) {
      const scene = this._gView?.camera?.getScene?.();
      const current = scene?.metadata?.interiorDesign?.id;
      if (!venue || !current || current === venue) {
        launch();
        return;
      }
      const switcher = scene.interiorSwitcher;
      if (!switcher) {
        // Without a switcher the local hall stays; the match still proceeds on
        // the identical physical table, so play is unaffected.
        launch();
        return;
      }
      const selection = dependencies.selection.choose(dependencies.transition.href, current, venue);
      if (selection) {
        dependencies.transition.begin(selection, {
          quick: switcher.isCached(venue),
          run: () => switcher.switchTo(venue),
          cancel: () => switcher.cancel(),
          finish: () => {
            this._syncInteriorAfterSwitch();
            launch();
          },
        });
        return;
      }
      switcher.switchTo(venue);
      this._syncInteriorAfterSwitch();
      launch();
    }
    /** Keep the menu state in step with a venue the room forced. */
    _syncInteriorAfterSwitch() {
      const scene = this._gView?.camera?.getScene?.();
      const id = scene?.metadata?.interiorDesign?.id;
      if (!id) {
        return;
      }
      this._currentInterior = dependencies.registry.get(id);
      this._homeMainMenu?.setCurrentInterior(this._currentInterior);
      this._gView.requireRender(2);
    }
    async _leaveRoom({ quiet }) {
      const rooms = this._rooms;
      if (!rooms) {
        return;
      }
      try {
        if (rooms.seat) {
          await rooms.leave();
        }
      } catch (error) {
        if (!quiet) {
          this._showRoomError(error);
          return;
        }
      }
      this._pendingRoomMatch = null;
      dependencies.matchSession.room = null;
      dependencies.matchSession.rooms = null;
      this._moreDialog?.clearRoom();
    }
    /**
     * A stored seat means the page was reloaded mid-session. Reattach once and
     * let the authoritative room state decide what the player sees next.
     */
    _resumeStoredRoom() {
      if (this._roomResumeAttempted || !this._rooms?.hasStoredSeat) {
        return;
      }
      this._roomResumeAttempted = true;
      this._rooms
        .resume()
        .then((message) => {
          if (['playing', 'finished'].includes(message.state?.status) && message.state.match) {
            this._enterRoomMatch(message.state);
            return;
          }
          this._openMoreThings('overview');
          this._moreDialog.enterRoom(message.state, this._rooms.seat);
        })
        .catch((error) => {
          if (error.code === 'no_saved_seat') {
            return;
          }
          this._uiLayer.message(
            'ROOMS',
            'Your previous room is no longer available. Create or join a new room.',
            2,
            false,
          );
        });
    }
  };
}
