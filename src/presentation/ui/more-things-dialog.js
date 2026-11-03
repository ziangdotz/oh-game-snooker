import createHotseatSettings from '../../shared/data/hotseat-settings.js';
import createRoomProtocol from '../../shared/net/room-protocol.js';

/** Local setup and the online rooms flow share the existing multiplayer drawer. */
export default function createMoreThingsDialog(dependencies) {
  const { validateHotseatNames } = createHotseatSettings();
  const protocol = createRoomProtocol();
  return class MoreThingsDialog extends dependencies.InteriorDesignDialog {
    constructor(id) {
      super(id);
      this._page = 'overview';
      this._room = null;
      this._seat = null;
      this._roomBusy = null;
      this._roomNotice = '';
      this._onBack = () => {
        if (this._busy || this._roomBusy) {
          return;
        }
        if (this._page === 'room') {
          this._requestLeave();
          return;
        }
        if (this._page === 'setup' || this._page === 'rooms') {
          if (this._page === 'setup') {
            this._saveDraft();
            this.emit('draft-change', this._draft, 'overview');
          }
          this._showOverview();
          return;
        }
        this._onClose();
      };
      this._onDraftInput = () => {
        if (this._error) {
          this._error.textContent = '';
        }
        this._nameInputs?.forEach((input) => input.removeAttribute('aria-invalid'));
        if (this._page === 'setup') {
          this._saveDraft();
        }
      };
      this._onSetupClick = (event) => {
        if (!this.isActive || this._blocked || this._busy) {
          return;
        }
        const button = event.target.closest('button[data-more-action]');
        if (!button) {
          return;
        }
        const action = button.dataset.moreAction;
        if (action === 'rooms') {
          this._showRooms();
          return;
        }
        if (action === 'hotseat-setup') {
          this._showSetup();
        }
      };
      this._onRoomsSubmit = (event) => {
        event.preventDefault();
        if (!this.isActive || this._blocked || this._roomBusy) {
          return;
        }
        const mode = event.submitter?.dataset.roomMode;
        if (!mode) {
          return;
        }
        this._clearRoomError();
        const name = protocol.normalizeDisplayName(this._roomNameInput.value);
        if (!name.ok) {
          this._showRoomError(name.error.message, this._roomNameInput);
          return;
        }
        if (mode === 'join') {
          const code = protocol.normalizeRoomCode(this._roomCodeInput.value);
          if (!code.ok) {
            this._showRoomError('Enter the six-character room code.', this._roomCodeInput);
            return;
          }
          this._setRoomBusy(mode === 'join' ? 'Joining room…' : 'Creating room…');
          this.emit('room-join', { displayName: name.value, roomId: code.value });
          return;
        }
        this._setRoomBusy('Creating room…');
        this.emit('room-create', {
          displayName: name.value,
          interior: this._draft?.venue || this._currentInteriorId,
        });
      };
      this._onRoomClick = (event) => {
        if (!this.isActive || this._blocked) {
          return;
        }
        const button = event.target.closest('button[data-room-action]');
        if (!button) {
          return;
        }
        switch (button.dataset.roomAction) {
          case 'ready':
            this.emit('room-ready', { ready: !this._mySeat()?.ready });
            break;
          case 'start':
            this.emit('room-start');
            break;
          case 'leave':
            this._requestLeave();
            break;
          case 'copy':
            this._copyCode();
            break;
          case 'retry':
            this._retryRoom();
            break;
          default:
            break;
        }
      };
      this._onSubmit = (event) => {
        if (event.target.id !== 'hotseat-setup-form') {
          return;
        }
        event.preventDefault();
        if (this._busy || this._blocked || !this.isActive) {
          return;
        }
        this._saveDraft();
        const result = validateHotseatNames(this._draft.names);
        this._error.textContent = result.error;
        if (result.error) {
          const input = this._nameInputs[result.invalidIndex ?? 1];
          input.setAttribute('aria-invalid', 'true');
          input.focus({ preventScroll: true });
          return;
        }
        this.emit('start-match', { names: result.names, venue: this._draft.venue });
      };
    }
    get page() {
      return this._page;
    }
    get room() {
      return this._room;
    }
    get identity() {
      return this._seat;
    }
    _createElement() {
      const element = super._createElement();
      element.classList.remove('interior-venue-drawer');
      element.classList.add('interior-more-things');
      const title = element.querySelector('h2');
      title.id = 'interior-more-things-title';
      title.textContent = 'PLAY TOGETHER';
      element.setAttribute('aria-labelledby', title.id);
      this._closeButton.setAttribute('aria-label', 'Close PLAY TOGETHER');
      this._list.setAttribute('aria-label', 'Play together');
      return element;
    }
    data({ designs, currentId, draft, page = 'overview' }) {
      this._designs = designs;
      this._currentInteriorId = currentId;
      this._draft = draft || { names: ['', ''], venue: currentId };
      if (!designs.some((design) => design.id === this._draft.venue)) {
        this._draft.venue = currentId;
      }
      this._showOverview();
      if (page === 'setup') {
        this._showSetup();
      }
      return this;
    }
    _setTitle(text) {
      this.element.querySelector('h2').textContent = text;
      this._list.setAttribute('aria-label', text);
    }
    _resetFooter() {
      this._startButton?.remove();
      this._startButton = null;
      this._backButton.textContent = 'BACK';
      this._backButton.disabled = false;
    }
    _showOverview() {
      this._busy = false;
      this._page = 'overview';
      this._roomBusy = null;
      this._setTitle('PLAY TOGETHER');
      this._resetFooter();
      this._list.replaceChildren();
      const options = document.createElement('div');
      options.className = 'interior-more-options';
      for (const [title, description, mode, status, action] of [
        [
          'TWO-PLAYER MATCH',
          'Share one computer and take turns.',
          'SAME COMPUTER',
          'SET UP A MATCH ↗',
          'hotseat-setup',
        ],
        [
          'ROOMS',
          'Create a private room or join a friend.',
          'PLAY ONLINE',
          'CREATE OR JOIN ↗',
          'rooms',
        ],
      ]) {
        const card = document.createElement('button');
        card.type = 'button';
        card.dataset.moreAction = action;
        if (action === 'hotseat-setup') {
          card.dataset.hotseatSetup = '';
        }
        card.className = 'interior-more-option';
        card.classList.toggle('is-featured', mode === 'SAME COMPUTER');
        const label = document.createElement('span');
        label.className = 'interior-more-eyebrow';
        label.textContent = mode;
        const heading = document.createElement('h3');
        heading.textContent = title;
        const copy = document.createElement('p');
        copy.textContent = description;
        const badge = document.createElement('span');
        badge.className = 'interior-more-status';
        badge.textContent = status;
        card.append(label, heading, copy, badge);
        options.append(card);
      }
      this._list.append(options);
      this._closeButton.disabled = false;
      this._backButton.disabled = false;
      if (this.isActive && !this._blocked) {
        this._focusButton(options.querySelector('button'));
      }
    }
    _showSetup() {
      this._page = 'setup';
      // A previous launch attempt may have left the shared drawer busy.
      this._busy = false;
      this._setTitle('TWO-PLAYER MATCH');
      this._resetFooter();
      this._list.replaceChildren();
      const form = document.createElement('form');
      form.id = 'hotseat-setup-form';
      form.className = 'hotseat-setup-form';
      const names = document.createElement('div');
      names.className = 'hotseat-players';
      this._nameInputs = [0, 1].map((index) => {
        const field = document.createElement('label');
        field.className = 'hotseat-name-field';
        const label = document.createElement('span');
        label.textContent = 'PLAYER ' + (index + 1);
        const input = document.createElement('input');
        input.type = 'text';
        input.name = 'player-' + (index + 1);
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = label.textContent;
        input.value = this._draft.names[index];
        input.setAttribute('aria-describedby', 'hotseat-error');
        field.append(label, input);
        names.append(field);
        return input;
      });
      const venues = document.createElement('fieldset');
      venues.className = 'hotseat-venues';
      const legend = document.createElement('legend');
      legend.textContent = 'SELECT VENUE';
      const grid = document.createElement('div');
      grid.className = 'hotseat-venue-grid';
      for (const design of this._designs) {
        const label = document.createElement('label');
        label.className = 'hotseat-venue';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'venue';
        input.value = design.id;
        input.checked = design.id === this._draft.venue;
        const image = document.createElement('img');
        image.src = design.preview;
        image.alt = '';
        image.width = 320;
        image.height = 180;
        const title = document.createElement('span');
        title.textContent = design.code + ' · ' + design.displayName;
        label.append(input, image, title);
        grid.append(label);
      }
      venues.append(legend, grid);
      this._error = document.createElement('p');
      this._error.id = 'hotseat-error';
      this._error.className = 'hotseat-error';
      this._error.setAttribute('role', 'status');
      form.append(names, this._error, venues);
      this._list.append(form);
      this._startButton = document.createElement('button');
      this._startButton.type = 'submit';
      this._startButton.className = 'default-button hotseat-start';
      this._startButton.textContent = 'START MATCH';
      this._startButton.setAttribute('form', form.id);
      this._backButton.parentElement.append(this._startButton);
      this._setupFocusPending = true;
      this.requireUpdate();
    }
    _showRooms() {
      this._page = 'rooms';
      this._busy = false;
      this._roomBusy = null;
      this._setTitle('ROOMS');
      this._resetFooter();
      this._list.replaceChildren();
      const form = document.createElement('form');
      form.id = 'room-setup-form';
      form.className = 'room-setup-form';
      const nameField = document.createElement('label');
      nameField.className = 'hotseat-name-field';
      const nameLabel = document.createElement('span');
      nameLabel.textContent = 'YOUR NAME';
      this._roomNameInput = document.createElement('input');
      this._roomNameInput.type = 'text';
      this._roomNameInput.name = 'room-name';
      this._roomNameInput.autocomplete = 'off';
      this._roomNameInput.spellcheck = false;
      this._roomNameInput.maxLength = 10;
      this._roomNameInput.placeholder = 'PLAYER 1';
      this._roomNameInput.value = this._roomName || this._draft?.names?.[0] || '';
      this._roomNameInput.setAttribute('aria-describedby', 'room-error');
      nameField.append(nameLabel, this._roomNameInput);

      const codeField = document.createElement('label');
      codeField.className = 'hotseat-name-field';
      const codeLabel = document.createElement('span');
      codeLabel.textContent = 'ROOM CODE';
      this._roomCodeInput = document.createElement('input');
      this._roomCodeInput.type = 'text';
      this._roomCodeInput.name = 'room-code';
      this._roomCodeInput.autocomplete = 'off';
      this._roomCodeInput.spellcheck = false;
      this._roomCodeInput.maxLength = 8;
      this._roomCodeInput.placeholder = 'ABC 234';
      this._roomCodeInput.setAttribute('aria-describedby', 'room-error');
      codeField.append(codeLabel, this._roomCodeInput);

      const seats = document.createElement('div');
      seats.className = 'room-lobby-fields';
      seats.append(nameField, codeField);

      this._error = document.createElement('p');
      this._error.id = 'room-error';
      this._error.className = 'hotseat-error';
      this._error.setAttribute('role', 'status');

      const actions = document.createElement('div');
      actions.className = 'room-lobby-actions';
      const createButton = document.createElement('button');
      createButton.type = 'submit';
      createButton.className = 'default-button room-lobby-create';
      createButton.dataset.roomMode = 'create';
      createButton.textContent = 'CREATE ROOM';
      const joinButton = document.createElement('button');
      joinButton.type = 'submit';
      joinButton.className = 'default-button room-lobby-join';
      joinButton.dataset.roomMode = 'join';
      joinButton.textContent = 'JOIN ROOM';
      actions.append(createButton, joinButton);

      const note = document.createElement('p');
      note.className = 'room-lobby-note';
      note.textContent =
        'Rooms connect to the local room service. Both players need the same service address.';

      form.append(seats, this._error, actions, note);
      this._list.append(form);
      this._roomsFocusPending = true;
      this.requireUpdate();
    }
    _showRoom() {
      this._page = 'room';
      this._setTitle('ROOM');
      this._resetFooter();
      this._list.replaceChildren();
      const room = this._room;
      if (!room) {
        this._showRooms();
        return;
      }
      const seat = this._mySeat();
      const isHost = Boolean(seat && room.hostId === seat.playerId);
      const other = room.seats.find((candidate) => candidate.playerId !== seat?.playerId);

      const header = document.createElement('div');
      header.className = 'room-code-block';
      const codeLabel = document.createElement('span');
      codeLabel.className = 'interior-more-eyebrow';
      codeLabel.textContent = 'ROOM CODE';
      const code = document.createElement('strong');
      code.className = 'room-code-value';
      code.textContent = protocol.formatRoomCode(room.roomId);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'default-button room-copy';
      copy.dataset.roomAction = 'copy';
      copy.textContent = this._copied ? 'COPIED' : 'COPY CODE';
      header.append(codeLabel, code, copy);

      const seats = document.createElement('ul');
      seats.className = 'room-seats';
      for (const [index, label] of [
        [0, 'HOST'],
        [1, 'GUEST'],
      ]) {
        const occupant = room.seats[index];
        const item = document.createElement('li');
        item.className = 'room-seat';
        item.dataset.state = occupant ? (occupant.connected ? 'online' : 'offline') : 'empty';
        const role = document.createElement('span');
        role.className = 'room-seat-role';
        role.textContent = label;
        const name = document.createElement('strong');
        name.className = 'room-seat-name';
        name.textContent = occupant ? occupant.displayName : 'WAITING…';
        const status = document.createElement('span');
        status.className = 'room-seat-status';
        status.textContent = !occupant
          ? 'OPEN SEAT'
          : (occupant.playerId === seat?.playerId ? 'YOU · ' : '') +
            (occupant.connected ? 'ONLINE' : 'OFFLINE') +
            (occupant.ready ? ' · READY' : '');
        item.append(role, name, status);
        seats.append(item);
      }

      const venue = document.createElement('div');
      venue.className = 'room-venue';
      const venueLabel = document.createElement('span');
      venueLabel.className = 'interior-more-eyebrow';
      venueLabel.textContent = 'VENUE';
      const venueName = document.createElement('strong');
      const design = this._designs.find((candidate) => candidate.id === room.interior);
      venueName.textContent = design
        ? design.code + ' · ' + design.displayName
        : room.interior || 'ORIGINAL';
      const venueNote = document.createElement('span');
      venueNote.className = 'room-venue-note';
      venueNote.textContent = isHost ? 'HOST SELECTS' : 'SELECTED BY HOST';
      venue.append(venueLabel, venueName, venueNote);

      const status = document.createElement('p');
      status.className = 'room-status';
      status.setAttribute('role', 'status');
      status.textContent = this._roomStatusText(room, seat, other);

      const notice = document.createElement('p');
      notice.className = 'hotseat-error';
      notice.setAttribute('role', 'status');
      notice.textContent = this._roomNotice;

      const actions = document.createElement('div');
      actions.className = 'room-actions';
      const readyButton = document.createElement('button');
      readyButton.type = 'button';
      readyButton.className = 'default-button';
      readyButton.dataset.roomAction = 'ready';
      readyButton.disabled = !seat || this._roomBusy !== null;
      readyButton.textContent = seat?.ready ? 'CANCEL READY' : 'READY';
      const startButton = document.createElement('button');
      startButton.type = 'button';
      startButton.className = 'default-button room-start';
      startButton.dataset.roomAction = 'start';
      startButton.disabled = !isHost || !this._canStart(room) || this._roomBusy !== null;
      startButton.textContent = isHost ? 'START MATCH' : 'WAITING FOR HOST';
      const leaveButton = document.createElement('button');
      leaveButton.type = 'button';
      leaveButton.className = 'default-button';
      leaveButton.dataset.roomAction = 'leave';
      leaveButton.textContent = isHost ? 'END ROOM' : 'LEAVE ROOM';
      actions.append(readyButton, startButton, leaveButton);

      this._list.append(header, seats, venue, status, notice, actions);
      this._roomFocusPending = true;
      this.requireUpdate();
    }
    _canStart(room) {
      return (
        room.seats.length === 2 &&
        room.seats.every((candidate) => candidate.ready && candidate.connected) &&
        room.status === 'ready'
      );
    }
    _roomStatusText(room, seat, other) {
      if (room.status === 'playing') {
        return 'Match in progress.';
      }
      if (room.seats.length < 2) {
        return 'Share the room code so a second player can join.';
      }
      if (other && !other.connected) {
        return 'The other player is disconnected. Their seat is held briefly.';
      }
      if (!seat?.ready) {
        return 'Set READY when your venue has finished loading.';
      }
      if (!room.seats.every((candidate) => candidate.ready)) {
        return room.hostId === seat?.playerId
          ? 'Waiting for the other player to be ready.'
          : 'Waiting for the other player to be ready.';
      }
      return room.hostId === seat?.playerId
        ? 'Both players are ready. Start the match when you are ready.'
        : 'Both players are ready. Waiting for the host to start.';
    }
    _mySeat() {
      if (!this._room || !this._seat) {
        return null;
      }
      return (
        this._room.seats.find((candidate) => candidate.playerId === this._seat.playerId) || null
      );
    }
    _clearRoomError() {
      if (this._error) {
        this._error.textContent = '';
      }
    }
    _showRoomError(message, input) {
      if (this._error) {
        this._error.textContent = message;
      }
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus({ preventScroll: true });
      }
    }
    _setRoomBusy(message) {
      this._roomBusy = message;
      for (const element of this.element.querySelectorAll('input, button')) {
        element.disabled = true;
      }
      if (this._error) {
        this._error.textContent = message;
      }
      if (this._page === 'room') {
        this._showRoom();
      }
    }
    _releaseRoomBusy() {
      this._roomBusy = null;
      for (const element of this.element.querySelectorAll('input, button')) {
        element.disabled = false;
      }
    }
    _requestLeave() {
      if (this._roomBusy) {
        return;
      }
      if (!this._leaveConfirmed) {
        this._leaveConfirmed = true;
        this._roomNotice = 'Leave this room? Choose END ROOM / LEAVE ROOM again to confirm.';
        this._showRoom();
        return;
      }
      this._leaveConfirmed = false;
      this._roomBusy = 'leaving';
      this.emit('room-leave');
    }
    async _copyCode() {
      const room = this._room;
      if (!room) {
        return;
      }
      try {
        await navigator.clipboard.writeText(room.roomId);
        this._copied = true;
      } catch {
        this._copied = false;
        this._roomNotice = 'Copy failed. Select the room code and copy it manually.';
      }
      if (this._page === 'room') {
        this._showRoom();
      }
    }
    _retryRoom() {
      this._roomNotice = '';
      this._showRooms();
    }
    setRoomBusy(message) {
      this._setRoomBusy(message);
    }
    setRoomError(message) {
      this._releaseRoomBusy();
      this._roomNotice = message;
      if (this._page === 'room' && this._room) {
        this._showRoom();
      } else if (this._page === 'rooms') {
        this._showRoomError(message, this._roomNameInput);
      }
    }
    setRoomNotice(message) {
      this._roomNotice = message;
      if (this._page === 'room' && this._room) {
        this._showRoom();
      }
    }
    /** Apply an authoritative room state; the seat identity decides host/guest actions. */
    setRoom(state, identity) {
      this._room = state;
      this._seat = identity || this._seat;
      this._roomBusy = null;
      this._releaseRoomBusy();
      if (this._page === 'room') {
        this._showRoom();
      }
    }
    enterRoom(state, identity) {
      this._room = state;
      this._seat = identity || this._seat;
      this._roomBusy = null;
      this._roomNotice = '';
      this._copied = false;
      this._showRoom();
    }
    clearRoom() {
      this._room = null;
      this._seat = null;
      this._roomBusy = null;
      this._roomNotice = '';
      this._showOverview();
    }
    _saveDraft() {
      if (this._page === 'setup') {
        this._draft.names = this._nameInputs.map((input) => input.value);
        this._draft.venue = this._list.querySelector('input[name="venue"]:checked').value;
        this.emit('draft-change', this._draft);
      }
      if (this._page === 'rooms') {
        this._roomName = this._roomNameInput.value;
      }
    }
    setBusy() {
      this._busy = true;
      for (const input of this.element.querySelectorAll('input, button')) {
        input.disabled = true;
      }
      this._error.textContent = 'Preparing your table…';
    }
    restoreSetup() {
      this._busy = false;
      for (const input of this.element.querySelectorAll('input, button')) {
        input.disabled = false;
      }
      this._error.textContent = 'Match not started. Your setup is saved; try again when ready.';
      this._focusButton(this._startButton);
    }
    _bindEvents() {
      super._bindEvents();
      this._backButton.removeEventListener('click', this._onClose);
      this._backButton.addEventListener('click', this._onBack);
      this._list.addEventListener('click', this._onSetupClick);
      this._list.addEventListener('click', this._onRoomClick);
      this._list.addEventListener('input', this._onDraftInput);
      this.element.addEventListener('submit', this._onSubmit);
      this.element.addEventListener('submit', this._onRoomsSubmit);
    }
    _unbindEvents() {
      this._saveDraft();
      this._backButton.removeEventListener('click', this._onBack);
      this._list.removeEventListener('click', this._onSetupClick);
      this._list.removeEventListener('click', this._onRoomClick);
      this._list.removeEventListener('input', this._onDraftInput);
      this.element.removeEventListener('submit', this._onSubmit);
      this.element.removeEventListener('submit', this._onRoomsSubmit);
      super._unbindEvents();
    }
    update(dt) {
      super.update(dt);
      if (this._setupFocusPending && this.isActive && !this._blocked) {
        this._setupFocusPending = false;
        this._focusButton(this._nameInputs[0]);
      }
      if (this._roomsFocusPending && this.isActive && !this._blocked) {
        this._roomsFocusPending = false;
        this._focusButton(this._roomNameInput);
      }
      if (this._roomFocusPending && this.isActive && !this._blocked) {
        this._roomFocusPending = false;
        this._focusButton(this._list.querySelector('[data-room-action]'));
      }
      return this.needsUpdate;
    }
    _handleKey(event) {
      if (event.key === 'Escape' && this.isActive && !this._blocked && this._page === 'room') {
        // An online seat is never abandoned by a stray Escape.
        event.preventDefault();
        this._onBack();
        return;
      }
      if (event.key === 'Tab' && this.isActive && !this._blocked && !this._busy) {
        const targets = [
          ...this.element.querySelectorAll('button:not(:disabled), input:not(:disabled)'),
        ].filter((target) => target.type !== 'radio' || target.checked);
        const index = targets.indexOf(document.activeElement);
        const next = (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        event.preventDefault();
        this._focusButton(targets[next]);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        return;
      }
      super._handleKey(event);
    }
  };
}
