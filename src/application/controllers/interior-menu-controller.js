import limitEntryMotion from '../../presentation/animation/entry-motion.js';
import createRoomMenuController from './room-menu-controller.js';

/** Room selection is available only while the home controller is acting. */
export default function createInteriorMenuController(dependencies) {
  const RoomMenuController = createRoomMenuController(dependencies);
  return class InteriorMenuController extends RoomMenuController {
    constructor(application) {
      super(application);
      this._rooms = null;

      this._roomOff = [];
      this._onBoxClosed = () => {
        if (this._state === 3 && this._homeMainMenu) {
          this._homeMainMenu.activateFromDialog();
        }
      };
    }
    _registerUI() {
      super._registerUI();
      if (!this._uiLayer.hasRegisteredBox('interiorBox')) {
        this._uiLayer.registerBox(new dependencies.InteriorDesignDialog('interiorBox'));
      }
      if (!this._uiLayer.hasRegisteredBox('moreThingsBox')) {
        this._uiLayer.registerBox(new dependencies.MoreThingsDialog('moreThingsBox'));
      }
    }
    _bindUI() {
      super._bindUI();
      this._interiorDialog = null;
      this._moreDialog = null;
      this._aboutDialog = null;
      this._restoreInteriorFocus = false;
      this._restoreMoreFocus = false;
      this._restoreAboutFocus = false;
      this._rooms ??= dependencies.createRoomSession(window, {
        eventEmitter: dependencies.eventEmitter,
        endpoint: this._roomEndpoint(),
      });
      this._pendingRoomMatch = null;
      this._roomLaunchReady = false;
      this._roomResumeAttempted = false;
      this._roomOff.push(
        this._rooms.on('state', (state) => {
          if (state.status === 'playing') {
            this._enterRoomMatch(state);
            return;
          }
          this._syncRoomDialog();
        }),
      );
      this._roomOff.push(this._rooms.on('error', (error) => this._showRoomError(error)));
      this._roomOff.push(
        this._rooms.on('close', () => {
          if (this._moreDialog?.page === 'room') {
            this._moreDialog.setRoomNotice('The room connection closed. Retrying…');
          }
        }),
      );
      this._onAboutClosed = () => {
        this._homeMainMenu.activateFromDialog();
        this._restoreAboutFocus = true;
      };
      this._onMoreClosed = () => {
        dependencies.matchSession.saveDraft(dependencies.matchSession.draft, 'overview');
        if (this._pendingHotseat) {
          dependencies.matchSession.config = this._pendingHotseat;
          this._pendingHotseat = null;
          this.emit(dependencies.ApplicationEvents.CHANGE_CONTROLLER, 'game');
          return;
        }

        // Closing the drawer while a room match is starting must not release the
        // seat that the match controller is about to use.
        if (this._pendingRoomMatch) {
          if (this._roomLaunchReady) {
            this._roomLaunchReady = false;
            this.emit(dependencies.ApplicationEvents.CHANGE_CONTROLLER, 'game');
          }
          return;
        }
        if (this._rooms?.state) {
          this._leaveRoom({ quiet: true });
        }
        this._homeMainMenu.activateFromDialog();
        this._restoreMoreFocus = true;
      };
      this._onHotseatDraft = (draft, page) => dependencies.matchSession.saveDraft(draft, page);
      this._onHotseatStart = (config) => {
        if (this._moreDialog._busy || this._pendingHotseat) {
          return;
        }
        this._moreDialog.setBusy();
        const scene = this._gView.camera.getScene();
        const launch = () => {
          this._pendingHotseat = config;
          this._uiLayer.closeBox('moreThingsBox');
        };
        const selection = dependencies.selection.choose(
          dependencies.transition.href,
          scene.metadata.interiorDesign.id,
          config.venue,
        );
        if (!selection) {
          launch();
          return;
        }
        const switcher = scene.interiorSwitcher;
        if (!switcher) {
          this._moreDialog.restoreSetup();
          return;
        }
        dependencies.transition.begin(selection, {
          quick: switcher.isCached(config.venue),
          run: () => switcher.switchTo(config.venue),
          cancel: () => switcher.cancel(),
          finish: () => {
            this._syncInteriorAfterSwitch();
            if (scene.metadata.interiorDesign.id === config.venue) {
              launch();
            } else {
              this._moreDialog.restoreSetup();
            }
            this._gView.requireRender(2);
          },
        });
      };
      this._onRoomCreate = (request) => this._createRoom(request);
      this._onRoomJoin = (request) => this._joinRoom(request);
      this._onRoomReady = ({ ready }) => this._setRoomReady(ready);
      this._onRoomStart = () => this._startRoomMatch();
      this._onRoomLeave = () => this._leaveRoom({});
      this._onInteriorClosed = () => {
        this._homeMainMenu.activateFromDialog();
        this._homeMainMenu.element.inert = false;
        this._restoreInteriorFocus = true;
      };
      this._onInteriorSelected = (id) => {
        const selection = dependencies.selection.choose(
          dependencies.transition.href,
          this._currentInterior?.id,
          id,
        );
        if (!selection) {
          this._uiLayer.closeBox('interiorBox');
          return;
        }
        this._interiorDialog.setBusy(id);
        const scene = this._gView.camera.getScene();
        const switcher = scene.interiorSwitcher;
        dependencies.transition.begin(
          selection,
          switcher
            ? {
                quick: switcher.isCached(id),
                run: () => switcher.switchTo(id),
                cancel: () => switcher.cancel(),
                finish: () => {
                  this._currentInterior = dependencies.registry.get(
                    scene.metadata.interiorDesign.id,
                  );
                  this._homeMainMenu.setCurrentInterior(this._currentInterior);
                  this._homeMainMenu.activateFromDialog();
                  // Animate both surfaces together, but keep menu input locked
                  // until the drawer has finished leaving the dialog stack.
                  this._homeMainMenu.element.inert = true;
                  this._uiLayer.closeBox('interiorBox');
                  this._gView.requireRender(2);
                },
              }
            : null,
        );
      };
    }
    _unbindUI() {
      for (const off of this._roomOff) {
        off();
      }
      this._roomOff.length = 0;
      this._aboutDialog = null;
      this._onAboutClosed = null;
      this._interiorDialog = null;
      this._moreDialog = null;
      this._onMoreClosed = null;
      this._onHotseatStart = null;
      this._onHotseatDraft = null;
      this._onRoomCreate = null;
      this._onRoomJoin = null;
      this._onRoomReady = null;
      this._onRoomStart = null;
      this._onRoomLeave = null;
      // The room connection belongs to the running match once play has started;
      // only a genuinely idle menu session is disconnected here.
      if (!this._pendingRoomMatch) {
        this._rooms?.disconnect();
        this._rooms = null;
      }
      this._onInteriorClosed = null;
      this._onInteriorSelected = null;
      super._unbindUI();
    }
    enter() {
      super.enter();
      limitEntryMotion(this._enterAnimation, 0.6);
    }
    action() {
      const profile = this._gView.camera.getScene().metadata?.interiorDesign;
      this._currentInterior = dependencies.registry.get(profile?.id);
      this._homeMainMenu.setCurrentInterior(this._currentInterior);
      super.action();
    }
    _confirmMenuClick() {
      if (this._moreDialog?.isActive) {
        return;
      }
      if (this._homeMainMenu.clickedIndex === 2) {
        this._aboutDialog = this._uiLayer.popBox('aboutBox');
        this._aboutDialog.on(dependencies.dialogEvents.CLOSE, this._onAboutClosed);
        return;
      }
      if (this._homeMainMenu.clickedIndex === 4) {
        this._openMoreThings();
        return;
      }
      if (this._homeMainMenu.clickedIndex !== 3) {
        dependencies.matchSession.config = null;
        super._confirmMenuClick();
        return;
      }
      this._interiorDialog = this._uiLayer.popBox('interiorBox', {
        designs: dependencies.registry.list(),
        currentId: this._currentInterior?.id,
      });
      this._interiorDialog
        .on(dependencies.dialogEvents.CLOSE, this._onInteriorClosed)
        .on(dependencies.dialogEvents.ITEM_CLICK, this._onInteriorSelected);
    }
    _openMoreThings(page = 'overview') {
      dependencies.matchSession.draft ||= {
        names: ['', ''],
        venue: this._currentInterior.id,
      };
      this._moreDialog = this._uiLayer.popBox('moreThingsBox', {
        designs: dependencies.registry.list(),
        currentId: this._currentInterior.id,
        draft: dependencies.matchSession.draft,
        page,
      });

      this._moreDialog
        .on(dependencies.dialogEvents.CLOSE, this._onMoreClosed)
        .on('start-match', this._onHotseatStart)
        .on('draft-change', this._onHotseatDraft)
        .on('room-create', this._onRoomCreate)
        .on('room-join', this._onRoomJoin)
        .on('room-ready', this._onRoomReady)
        .on('room-start', this._onRoomStart)
        .on('room-leave', this._onRoomLeave);
    }
    updateActing(timer) {
      if (this._aboutDialog?.needsUpdate) {
        this._aboutDialog.update(timer.dt);
      }
      if (this._interiorDialog?.needsUpdate) {
        this._interiorDialog.update(timer.dt);
      }
      if (this._moreDialog?.needsUpdate) {
        this._moreDialog.update(timer.dt);
      }
      super.updateActing(timer);
      if (this._homeMainMenu.isActive && !this._homeMainMenu.needsUpdate) {
        const scene = this._gView.camera.getScene();
        if (!scene.isReady()) {
          return;
        }
        // Finish cold-start loading before a restored dialog deactivates home.
        dependencies.transition.complete(scene.metadata?.interiorDesign?.id);
        if (dependencies.matchSession.returnToSetup) {
          dependencies.matchSession.returnToSetup = false;
          this._homeMainMenu.deactivate();
          this._openMoreThings('setup');
          return;
        }
        this._resumeStoredRoom();
        if (this._restoreInteriorFocus && !this._uiLayer.isBlocked) {
          this._restoreInteriorFocus = false;
          this._homeMainMenu.focusInterior();
        }
        if (this._restoreMoreFocus && !this._uiLayer.isBlocked) {
          this._restoreMoreFocus = false;
          this._homeMainMenu.focusMoreThings();
        }
        if (this._restoreAboutFocus && !this._uiLayer.isBlocked) {
          this._restoreAboutFocus = false;
          this._homeMainMenu.focusAbout();
        }
      }
    }
  };
}
