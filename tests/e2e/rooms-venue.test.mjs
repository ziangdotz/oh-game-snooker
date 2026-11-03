import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../config/project.config.mjs';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import {
  browserCandidates,
  launchTestBrowser,
  createRuntimeFixture,
  inspectRuntimeRoute,
  waitForHome,
} from '../helpers/runtime-fixture.mjs';

const output = path.join(ROOT, 'artifacts/testing/rooms-venue');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'Only the original and 003 halls are exercised: 001 and 002 share the same builder and differ by textures.',
    'The physical table is identical in every hall, so this checks the backdrop and the collision mesh identity, not ball behaviour differences.',
  ],
};

async function openHome(browser, target, endpoint, interior, entry) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => entry.errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(target.origin + '/')) {
      if (/^wss?:\/\/127\.0\.0\.1:\d+\//u.test(url)) {
        return route.continue();
      }
      entry.errors.push('External request: ' + url);
      return route.abort();
    }
    if (!(await inspectRuntimeRoute(route, target))) {
      await route.continue();
    }
  });
  await page.goto(
    target.origin + '/?interior=' + interior + '&rooms=' + encodeURIComponent(endpoint),
  );
  await waitForHome(page, interior);
  return { context, page };
}

const venueOf = (page) =>
  page.evaluate(() => {
    const scene = window.__pcolTestGame._gView.camera.getScene();
    return {
      interior: scene.metadata?.interiorDesign?.id ?? null,
      meshId: window.__pcolTestGame._currentController?._simulator?.world?.meshBody?.id ?? null,
      sceneId: window.__pcolTestGame._currentController?._simulator?._sceneId ?? null,
    };
  });

try {
  const fixture = await createRuntimeFixture();
  const service = createRoomServer({ port: 0, host: '127.0.0.1' });
  await service.listen();
  const endpoint = 'ws://127.0.0.1:' + service.address().port + '/rooms';
  try {
    for (const candidate of browserCandidates()) {
      const browser = await launchTestBrowser(candidate);
      try {
        for (const target of fixture.targets) {
          // The host opens the room in the third hall; the guest waits in the
          // original one, so the room venue has to win for both of them.
          const entry = {
            browser: candidate.name,
            target: target.name,
            endpoint,
            errors: [],
            hostVenue: 'interior-design-003',
            guestVenue: 'interior-design-original',
          };
          report.scenarios.push(entry);
          const host = await openHome(browser, target, endpoint, entry.hostVenue, entry);
          const guest = await openHome(browser, target, endpoint, entry.guestVenue, entry);
          try {
            entry.beforeSwitch = {
              host: await venueOf(host.page),
              guest: await venueOf(guest.page),
            };
            for (const page of [host.page, guest.page]) {
              await page.locator('.interior-more-menu-item').click();
              await page.waitForFunction(() => {
                const box = window.__pcolTestGame._currentController._moreDialog;
                return box?.isActive && !box.needsUpdate && !box.blocked;
              });
              await page.locator('button[data-more-action="rooms"]').click();
              await page.waitForFunction(() => {
                const box = window.__pcolTestGame._currentController._moreDialog;
                return box?.page === 'rooms' && !box.needsUpdate;
              });
            }
            await host.page.locator('input[name="room-name"]').fill('Host');
            await host.page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
            await host.page.waitForFunction(
              () => window.__pcolTestGame._currentController._moreDialog?._room,
            );
            const created = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._moreDialog._room,
            );
            entry.roomInterior = created.interior;
            assert.equal(
              created.interior,
              entry.hostVenue,
              'the room keeps the hall the host created it in',
            );
            await guest.page.locator('input[name="room-name"]').fill('Guest');
            await guest.page.locator('input[name="room-code"]').fill(created.roomId);
            await guest.page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
            await guest.page.waitForFunction(
              () =>
                window.__pcolTestGame._currentController._moreDialog?._room?.seats?.length === 2,
            );
            // The panel must show the room venue to the guest, not their own.
            entry.guestPanelVenue = await guest.page.evaluate(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.interior ?? null;
            });
            assert.equal(entry.guestPanelVenue, entry.hostVenue, 'the panel shows the room hall');
            for (const page of [host.page, guest.page]) {
              await page.getByRole('button', { name: 'READY', exact: true }).click();
            }
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () =>
                  window.__pcolTestGame._currentController._moreDialog?._room?.status === 'ready',
              );
            }
            await host.page.getByRole('button', { name: 'START MATCH', exact: true }).click();
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => {
                  const controller = window.__pcolTestGame._currentController;
                  return (
                    controller.name === 'game' &&
                    controller._model?.isRemote === true &&
                    controller._model.gState === 4
                  );
                },
                null,
                { timeout: 120000 },
              );
            }
            entry.after = { host: await venueOf(host.page), guest: await venueOf(guest.page) };

            // Both seats play in the room's hall on the same collision mesh.
            assert.equal(entry.after.host.interior, entry.hostVenue, 'host keeps the room hall');
            assert.equal(
              entry.after.guest.interior,
              entry.hostVenue,
              'the guest is moved into the room hall',
            );
            assert.equal(
              entry.after.guest.meshId,
              entry.after.host.meshId,
              'both seats load the same collision mesh',
            );
            assert.equal(
              entry.after.guest.sceneId,
              entry.after.host.sceneId,
              'both seats use the same physical scene',
            );
            assert.match(
              entry.after.host.meshId ?? '',
              /tiger-club-collision\.json$/,
              'the table comes from the canonical collision mesh',
            );
            assert.deepEqual(entry.errors, []);
            entry.passed = true;
          } finally {
            await host.context.close();
            await guest.context.close();
          }
        }
      } finally {
        await browser.close();
      }
    }
    report.passed = report.scenarios.every((scenario) => scenario.passed);
    assert.equal(report.passed, true, 'every venue scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-venue.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-venue/rooms-venue.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-venue.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
