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

const output = path.join(ROOT, 'artifacts/testing/rooms-ui');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'Rooms connect to a loopback room service; this does not cover公网 deployment, TLS or latency.',
    'The match itself is not played through the visible cue controls yet.',
  ],
};

async function openHome(browser, target, entry) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  page.on('pageerror', (error) => entry.errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(target.origin + '/')) {
      // The room service is a separate loopback origin by design.
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
  await page.goto(target.origin + '/?interior=interior-design-original');
  await waitForHome(page, 'interior-design-original');
  return { context, page };
}

async function openRooms(page) {
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

async function waitForRoomPage(page) {
  await page.waitForFunction(() => {
    const box = window.__pcolTestGame._currentController._moreDialog;
    return box?.page === 'room' && !box.needsUpdate;
  });
}

async function roomState(page) {
  return page.evaluate(() => {
    const dialog = window.__pcolTestGame._currentController._moreDialog;
    return dialog.room;
  });
}

try {
  const fixture = await createRuntimeFixture();
  const service = createRoomServer({ port: 0, host: '127.0.0.1' });
  await service.listen();
  const roomPort = service.address().port;
  const endpoint = 'ws://127.0.0.1:' + roomPort + '/rooms';
  try {
    for (const candidate of browserCandidates()) {
      const browser = await launchTestBrowser(candidate);
      try {
        for (const target of fixture.targets) {
          const entry = {
            browser: candidate.name,
            target: target.name,
            endpoint,
            errors: [],
          };
          report.scenarios.push(entry);
          const host = await openHome(browser, target, entry);
          const guest = await openHome(browser, target, entry);
          try {
            // The ?rooms= override must reach the browser client before the lobby opens.
            await host.page.goto(
              target.origin +
                '/?interior=interior-design-original&rooms=' +
                encodeURIComponent(endpoint),
            );
            await waitForHome(host.page, 'interior-design-original');
            await guest.page.goto(
              target.origin +
                '/?interior=interior-design-original&rooms=' +
                encodeURIComponent(endpoint),
            );
            await waitForHome(guest.page, 'interior-design-original');

            await openRooms(host.page);
            assert.equal(
              await host.page.evaluate(
                () => window.__pcolTestGame._currentController._rooms.endpoint,
              ),
              endpoint,
            );
            assert.equal(
              await host.page.locator('#room-setup-form').isVisible(),
              true,
              'create/join form is visible',
            );
            await host.page.locator('input[name="room-name"]').fill('Host');
            await host.page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
            await waitForRoomPage(host.page);
            const created = await roomState(host.page);
            assert.match(created.roomId, /^[A-Z0-9]{6}$/);
            assert.equal(created.status, 'waiting');
            assert.equal(created.seats.length, 1);
            entry.roomCode = created.roomId;
            entry.createdRevision = created.revision;

            const code = await host.page.locator('.room-code-value').textContent();
            assert.equal(code.replace(/\s/gu, ''), created.roomId);
            assert.equal(await host.page.locator('.room-seat').count(), 2);
            assert.equal(
              await host.page.locator('.room-seat').nth(1).locator('.room-seat-name').textContent(),
              'WAITING…',
            );
            assert.equal(
              await host.page
                .getByRole('button', { name: 'START MATCH', exact: true })
                .isDisabled(),
              true,
            );

            await openRooms(guest.page);
            await guest.page.locator('input[name="room-name"]').fill('Guest');
            await guest.page
              .locator('input[name="room-code"]')
              .fill(created.roomId.slice(0, 3) + ' ' + created.roomId.slice(3));
            await guest.page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
            await waitForRoomPage(guest.page);
            const joined = await roomState(guest.page);
            assert.equal(joined.seats.length, 2);
            assert.ok(joined.revision > created.revision);

            await host.page.waitForFunction((revision) => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.revision >= revision;
            }, joined.revision);
            const hostView = await roomState(host.page);
            assert.deepEqual(
              hostView.seats.map((seat) => seat.displayName),
              ['Host', 'Guest'],
            );
            assert.equal(
              await host.page
                .getByRole('button', { name: 'START MATCH', exact: true })
                .isDisabled(),
              true,
              'host cannot start before both are ready',
            );
            assert.equal(
              await guest.page
                .getByRole('button', { name: 'WAITING FOR HOST', exact: true })
                .isDisabled(),
              true,
            );

            await host.page.getByRole('button', { name: 'READY', exact: true }).click();
            await host.page.waitForFunction(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.seats?.[0]?.ready === true;
            });
            await guest.page.waitForFunction(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.seats?.[0]?.ready === true;
            });
            assert.equal(
              await host.page
                .getByRole('button', { name: 'START MATCH', exact: true })
                .isDisabled(),
              true,
              'host still cannot start while the guest is not ready',
            );

            await guest.page.getByRole('button', { name: 'READY', exact: true }).click();
            await guest.page.waitForFunction(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.status === 'ready';
            });
            await host.page.waitForFunction(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              return dialog._room?.status === 'ready';
            });
            entry.readyRevision = (await roomState(host.page)).revision;

            const startButton = host.page.getByRole('button', {
              name: 'START MATCH',
              exact: true,
            });
            assert.equal(await startButton.isDisabled(), false, 'host can start when ready');
            // Starting a room now hands the seat to the table controller, so the
            // lobby is expected to disappear and the authoritative match to open.
            await startButton.click();
            for (const [label, roomPage] of [
              ['host', host.page],
              ['guest', guest.page],
            ]) {
              await roomPage.waitForFunction(
                () => {
                  const controller = window.__pcolTestGame._currentController;
                  return (
                    controller.name === 'game' &&
                    controller.state === 3 &&
                    controller._model?.isRemote === true &&
                    controller._model.gState === 4
                  );
                },
                null,
                { timeout: 90000 },
              );
              entry['openedTable_' + label] = await roomPage.evaluate(() => {
                const controller = window.__pcolTestGame._currentController;
                return {
                  mode: controller._model._mode,
                  players: controller._model.players.map((player) => player.displayName),
                  seatIndex: controller._model.remoteSeatIndex,
                  version: controller._model._version,
                };
              });
            }
            assert.equal(entry.openedTable_host.mode, 'remote');
            assert.deepEqual(entry.openedTable_host.players, ['Host', 'Guest']);
            assert.equal(entry.openedTable_host.seatIndex, 0);
            assert.equal(entry.openedTable_guest.seatIndex, 1);
            entry.matchId = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._model.remoteMatchId,
            );
            assert.match(entry.matchId, /^[0-9a-f-]{36}$/);

            // The seat credential is what a refresh would resume from.
            entry.storedSeat = await host.page.evaluate(() => {
              const raw = window.sessionStorage.getItem('oh-game-snooker:room-seat');
              return raw ? JSON.parse(raw).roomId : null;
            });
            assert.equal(entry.storedSeat, created.roomId);
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
    assert.equal(report.passed, true, 'every rooms UI scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-ui.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-ui/rooms-ui.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-ui.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
