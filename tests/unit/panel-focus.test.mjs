import test from 'node:test';
import assert from 'node:assert/strict';
import createMoreThingsDialog from '../../src/presentation/ui/more-things-dialog.js';

test('delayed autofocus respects a user-selected field on every multiplayer panel', (t) => {
  const previous = globalThis.document;
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  });
  const Dialog = createMoreThingsDialog({
    InteriorDesignDialog: class {
      update() {}
    },
  });
  for (const flag of ['_setupFocusPending', '_roomsFocusPending', '_roomFocusPending']) {
    const dialog = new Dialog('test');
    const first = { value: 'Alice' };
    const second = { value: 'alice' };
    const calls = [];
    globalThis.document = { activeElement: second };
    dialog._list = {
      contains: (node) => node === first || node === second,
      querySelector: () => first,
    };
    dialog._nameInputs = [first, second];
    dialog._roomNameInput = first;
    dialog._focusButton = (node) => {
      calls.push(node);
      globalThis.document.activeElement = node;
    };
    dialog.isActive = true;
    dialog._blocked = false;
    dialog[flag] = true;
    dialog.update(1 / 60);
    assert.equal(globalThis.document.activeElement, second);
    assert.deepEqual(calls, []);
    assert.equal(dialog[flag], false);
    assert.deepEqual([first.value, second.value], ['Alice', 'alice']);
    globalThis.document.activeElement = {};
    dialog[flag] = true;
    dialog._blocked = true;
    dialog.update(1 / 60);
    assert.equal(dialog[flag], true);
    dialog._blocked = false;
    dialog.update(1 / 60);
    assert.equal(globalThis.document.activeElement, first);
    assert.equal(calls.length, 1);
  }
});
