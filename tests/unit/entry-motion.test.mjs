import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import composeAnimation from '../../src/application/composition/compose-animation.js';
import limitEntryMotion from '../../src/presentation/animation/entry-motion.js';
import createInteriorSideMenu from '../../src/presentation/ui/interior-side-menu.js';

const animation = composeAnimation({ EventEmitter: { a: EventEmitter } });
const browser = (reduced) => ({ matchMedia: () => ({ matches: reduced }) });

test('entry budgets preserve camera interpolation endpoints and reset speed each entry', () => {
  for (const [duration, budget, reduced] of [
    [3.5, 0.6, false],
    [1.2, 0.45, false],
    [0.1, 0.6, false],
    [3.5, 0.6, true],
  ]) {
    let pose;
    const tween = new animation.PropertyTween((value) => {
      pose = { ...value };
    });
    tween
      .reset({ x: 2, y: 3 }, { x: 8, y: 6 }, animation.Easing.Power1.easeInOut, duration, 0.1)
      .play();
    limitEntryMotion(tween, budget, browser(reduced));
    let elapsed = 0;
    while (!tween.isComplete() && elapsed < 5) {
      tween.update(1 / 120);
      elapsed += 1 / 120;
    }
    assert.deepEqual(pose, { x: 8, y: 6 });
    assert.equal(tween.duration, duration);
    assert.ok(elapsed <= (reduced ? 0.016 : budget) + 1 / 120);
    tween.reset({ x: 0 }, { x: 1 }, animation.Easing.defaultEase, 0.05);
    limitEntryMotion(tween, 0.6, browser(false));
    assert.equal(tween.timeScale, 1);
  }
});

test('dialog return completes every menu item without replaying entrance stagger', (t) => {
  const previous = globalThis.window;
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous;
    }
  });
  for (const reduced of [false, true]) {
    globalThis.window = browser(reduced);
    const Menu = createInteriorSideMenu({
      ...animation,
      SideMenu: class {
        _onActivate() {}
        activate() {
          if (!this.isActive) {
            this.isActive = true;
            this._onActivate();
            this._tween.play();
          }
          return this;
        }
      },
    });
    const menu = new Menu();
    menu.element = { style: {}, inert: true };
    menu._styleOpts = { on: 'block', off: 'none' };
    menu._bns = Array.from({ length: 5 }, () => ({ display: 0 }));
    menu._tween = menu._createTween();
    menu.activateFromDialog();
    assert.equal(menu._motionDuration, reduced ? 0.016 : 0.16);
    while (!menu._tween.isComplete()) {
      menu._tween.update(1 / 120);
    }
    assert.ok(menu._bns.every((item) => item.display === 1));
    assert.ok(menu._motionStates.every((state) => state.y === 0));
    assert.equal(menu._returnFromDialog, false);
  }
});
