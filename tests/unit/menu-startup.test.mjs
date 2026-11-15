import test from 'node:test';
import assert from 'node:assert/strict';
import createInteriorMenuController from '../../src/application/controllers/interior-menu-controller.js';

function fixture({ ready = true, restore = false } = {}) {
  const calls = [];
  const matchSession = { returnToSetup: restore };
  const scene = {
    isReady: () => ready,
    metadata: { interiorDesign: { id: 'interior-design-original' } },
  };
  const Controller = createInteriorMenuController({
    MenuController: class {
      updateActing() {}
    },
    matchSession,
    transition: { complete: (id) => calls.push(['complete', id]) },
  });
  const controller = new Controller();
  controller._gView = { camera: { getScene: () => scene } };
  controller._homeMainMenu = {
    isActive: true,
    needsUpdate: false,
    deactivate() {
      this.isActive = false;
      calls.push(['deactivate']);
    },
  };
  controller._uiLayer = { isBlocked: false };
  controller._openMoreThings = (page) => calls.push(['open', page]);
  controller._resumeStoredRoom = () => calls.push(['resume']);
  return { controller, calls, matchSession, scene };
}

test('cold-start loading completes before the restored hotseat drawer takes focus', () => {
  const { controller, calls, matchSession } = fixture({ restore: true });
  controller.updateActing({ dt: 0 });
  assert.deepEqual(calls, [
    ['complete', 'interior-design-original'],
    ['deactivate'],
    ['open', 'setup'],
  ]);
  assert.equal(matchSession.returnToSetup, false);
  controller.updateActing({ dt: 0 });
  assert.equal(calls.length, 3);
});

test('unfinished scene preserves setup restoration until resources are ready', () => {
  const { controller, calls, matchSession, scene } = fixture({ ready: false, restore: true });
  controller.updateActing({ dt: 0 });
  assert.deepEqual(calls, []);
  assert.equal(matchSession.returnToSetup, true);
  scene.isReady = () => true;
  controller.updateActing({ dt: 0 });
  assert.equal(calls.at(-1)[0], 'open');
});

test('stored room recovery starts after loading completes', () => {
  const { controller, calls } = fixture();
  controller.updateActing({ dt: 0 });
  assert.deepEqual(calls, [['complete', 'interior-design-original'], ['resume']]);
});
