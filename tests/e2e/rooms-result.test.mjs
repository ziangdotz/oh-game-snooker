import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../config/project.config.mjs';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { createMatchSession } from '../../src/server/matches/match-session.mjs';
import { prepareFinalBlack } from '../helpers/room-match-fixture.mjs';
import {
  browserCandidates,
  launchTestBrowser,
  createRuntimeFixture,
  inspectRuntimeRoute,
  waitForHome,
} from '../helpers/runtime-fixture.mjs';

const output = path.join(ROOT, 'artifacts/testing/rooms-result');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'The final contacts are controlled on the server; the real referee, WebSocket result delivery, result panel and rematch buttons are exercised. This is not a fully played frame.',
    'Refresh recovery requires the same live service process and a valid seat within the disconnect grace window.',
  ],
};

async function openHome(browser, target, endpoint, entry) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => entry.errors.push(error.stack || error.message));
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
    target.origin + '/?interior=interior-design-original&rooms=' + encodeURIComponent(endpoint),
  );
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

async function waitForTable(page) {
  await page.waitForFunction(
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
  assert.equal(
    await page.evaluate(() =>
      window.__pcolTestGame._uiLayer._activeBoxStack.some((box) => box.id === 'moreThingsBox'),
    ),
    false,
    'the room drawer must release its modal before the table takes control',
  );
}

try {
  const fixture = await createRuntimeFixture();
  const frames = [];
  const service = createRoomServer({
    port: 0,
    host: '127.0.0.1',
    matchFactory: async (options) => {
      const frame = await createMatchSession(options);
      frames.push(frame);
      return frame;
    },
  });
  await service.listen();
  const endpoint = 'ws://127.0.0.1:' + service.address().port + '/rooms';
  try {
    for (const candidate of browserCandidates()) {
      const browser = await launchTestBrowser(candidate);
      try {
        for (const target of fixture.targets) {
          console.log('Result / recovery: ' + candidate.name + ' / ' + target.name);
          const entry = { browser: candidate.name, target: target.name, endpoint, errors: [] };
          report.scenarios.push(entry);
          const host = await openHome(browser, target, endpoint, entry);
          const guest = await openHome(browser, target, endpoint, entry);
          try {
            await openRooms(host.page);
            await host.page.locator('input[name="room-name"]').fill('Host');
            await host.page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
            await host.page.waitForFunction(
              () => window.__pcolTestGame._currentController._moreDialog?._room,
            );
            const created = await host.page.evaluate(() => {
              const dialog = window.__pcolTestGame._currentController._moreDialog;
              const raw = window.sessionStorage.getItem('oh-my-snooker:room-seat');
              return {
                roomId: dialog._room.roomId,
                seat: JSON.parse(raw),
              };
            });
            await openRooms(guest.page);
            await guest.page.locator('input[name="room-name"]').fill('Guest');
            await guest.page.locator('input[name="room-code"]').fill(created.roomId);
            await guest.page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
            await guest.page.waitForFunction(
              () =>
                window.__pcolTestGame._currentController._moreDialog?._room?.seats?.length === 2,
            );
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
            await waitForTable(host.page);
            await waitForTable(guest.page);
            entry.roomCode = created.roomId;
            const matchId = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._model.remoteMatchId,
            );
            entry.matchId = matchId;

            // Place and shoot once so the refreshed page has real state to restore.
            await host.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              await controller._model.reqRespotCueball({ x: -1.04, y: 0.90625, z: -0.145 });
            });
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => window.__pcolTestGame._currentController._model.getContext('inHand') <= 1,
              );
            }
            await host.page.evaluate(
              async ({ power }) => {
                const controller = window.__pcolTestGame._currentController;
                const cue = controller._simulator.getCueBallPosition();
                const vars = new Float32Array(8);
                vars[0] = cue.x - 0.005;
                vars[1] = cue.y;
                vars[2] = cue.z;
                vars[3] = 1;
                vars[5] = 0;
                vars[6] = (0.5 + 11 * power) * (3.2 + 6 * power);
                vars[7] = 0.005;
                controller._model.reportPlayerStroke(controller._model.remoteSeatIndex);
                controller._simulator.stroke(vars);
              },
              { power: 0.25 },
            );
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => {
                  const controller = window.__pcolTestGame._currentController;
                  // Wait for the motion replay to settle before recording state.
                  return (
                    controller._model.gState === 4 &&
                    controller._model.getContext('nRounds') >= 1 &&
                    !controller._motion?.active
                  );
                },
                null,
                { timeout: 60000 },
              );
            }
            const beforeReload = await host.page.evaluate(() => {
              const controller = window.__pcolTestGame._currentController;
              return {
                version: controller._model._version,
                nRounds: controller._model.getContext('nRounds'),
                turn: controller._model.getContext('playerIndex'),
                cue: [
                  Number(controller._simulator.getCueBallPosition().x.toFixed(4)),
                  Number(controller._simulator.getCueBallPosition().z.toFixed(4)),
                ],
              };
            });
            entry.beforeReload = beforeReload;

            // Reload: the saved seat must reattach to the same authoritative frame.
            await host.page.reload();
            await host.page.waitForFunction(
              () => window.__pcolTestGame?._currentController?.name === 'game',
              null,
              { timeout: 90000 },
            );
            await waitForTable(host.page);
            const afterReload = await host.page.evaluate(() => {
              const controller = window.__pcolTestGame._currentController;
              return {
                matchId: controller._model.remoteMatchId,
                version: controller._model._version,
                nRounds: controller._model.getContext('nRounds'),
                turn: controller._model.getContext('playerIndex'),
                seatIndex: controller._model.remoteSeatIndex,
                players: controller._model.players.map((player) => player.displayName),
                cue: [
                  Number(controller._simulator.getCueBallPosition().x.toFixed(4)),
                  Number(controller._simulator.getCueBallPosition().z.toFixed(4)),
                ],
              };
            });
            entry.afterReload = afterReload;
            assert.equal(
              afterReload.matchId,
              matchId,
              'the refreshed page reattaches to the frame',
            );
            assert.equal(afterReload.seatIndex, 0);
            assert.deepEqual(afterReload.players, ['Host', 'Guest']);
            assert.equal(afterReload.nRounds, beforeReload.nRounds);
            assert.equal(afterReload.turn, beforeReload.turn);
            assert.deepEqual(afterReload.cue, beforeReload.cue);
            assert.equal(afterReload.version, beforeReload.version);

            prepareFinalBlack(frames.at(-1));
            const actor = beforeReload.turn === 0 ? host.page : guest.page;
            await actor.evaluate(() =>
              window.__pcolTestGame._currentController._remote.submitStrokeCommand({
                shot: { direction: { x: 1, z: 0 }, power: 0.25 },
              }),
            );
            for (const page of [host.page, guest.page]) {
              await page.getByRole('button', { name: 'REMATCH', exact: true }).waitFor();
              await page.waitForFunction(() => {
                const dialog = window.__pcolTestGame._currentController._resultDialog;
                return dialog?.isActive && !dialog.needsUpdate && !dialog.blocked;
              });
              assert.equal(
                await page.evaluate(() => window.__pcolTestGame._currentController._finished),
                true,
              );
            }
            entry.finishedStatus = 'finished';
            entry.winnerIndex = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._result.winnerIndex,
            );
            await host.page.screenshot({
              path: path.join(output, candidate.name + '-' + target.name + '-result.png'),
            });
            // The result must also reopen when the finished seat is refreshed.
            await host.page.reload();
            await host.page
              .getByRole('button', { name: 'REMATCH', exact: true })
              .waitFor({ timeout: 90000 });
            entry.finishedReload = true;
            await host.page.getByRole('button', { name: 'REMATCH', exact: true }).click();
            await host.page.waitForFunction(
              () => window.__pcolTestGame._currentController._rematchCount === 1,
            );
            assert.equal(
              await guest.page.evaluate(
                () => window.__pcolTestGame._currentController._model.remoteMatchId,
              ),
              matchId,
            );
            entry.firstVote = 1;
            await guest.page.getByRole('button', { name: 'REMATCH', exact: true }).click();
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction((previous) => {
                const controller = window.__pcolTestGame._currentController;
                return (
                  !controller._finished &&
                  controller._model.remoteMatchId !== previous &&
                  controller._model._version === 0
                );
              }, matchId);
              await waitForTable(page);
            }
            entry.newMatchId = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._model.remoteMatchId,
            );
            entry.rematchCreated = entry.newMatchId !== matchId;
            // A new frame must accept commands, not merely update its title.
            await host.page.evaluate(() =>
              window.__pcolTestGame._currentController._model.reqRespotCueball({
                x: -1.04,
                z: -0.145,
              }),
            );
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => window.__pcolTestGame._currentController._model._version === 1,
              );
            }
            entry.rematchPlacement = true;
            await guest.page.evaluate(() =>
              window.__pcolTestGame._currentController._leaveRoomAfterResult(),
            );
            await host.page.waitForFunction(
              () => window.__pcolTestGame._currentController.name === 'home',
            );
            assert.equal(
              await host.page.evaluate(() =>
                window.sessionStorage.getItem('oh-my-snooker:room-seat'),
              ),
              null,
            );
            entry.opponentLeave = true;
            for (const page of [host.page, guest.page]) {
              await waitForHome(page, 'interior-design-original');
              await page.waitForFunction(() => !window.__pcolTestGame._uiLayer.isBlocked);
              await openRooms(page);
            }
            await host.page.locator('input[name="room-name"]').fill('HostNew');
            await host.page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
            await host.page.waitForFunction((previous) => {
              const room = window.__pcolTestGame._currentController._moreDialog?._room;
              return room && room.roomId !== previous;
            }, created.roomId);
            const nextRoomId = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._moreDialog._room.roomId,
            );
            await guest.page.locator('input[name="room-name"]').fill('GuestNew');
            await guest.page.locator('input[name="room-code"]').fill(nextRoomId);
            await guest.page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
            await guest.page.getByRole('button', { name: 'READY', exact: true }).waitFor();
            for (const page of [host.page, guest.page]) {
              await page.getByRole('button', { name: 'READY', exact: true }).click();
            }
            await host.page.getByRole('button', { name: 'START MATCH', exact: true }).click();
            for (const page of [host.page, guest.page]) {
              await waitForTable(page);
            }
            entry.reenterRoom = true;
            assert.deepEqual(entry.errors, []);
            entry.passed = true;
          } catch (error) {
            entry.failure = error.message;
            entry.diagnostics = await host.page
              .evaluate(() => {
                const controller = window.__pcolTestGame?._currentController;
                return {
                  name: controller?.name,
                  finished: controller?._finished,
                  rematchCount: controller?._rematchCount,
                  matchId: controller?._model?.remoteMatchId,
                  version: controller?._model?._version,
                  state: controller?._model?.gState,
                };
              })
              .catch(() => null);
            await host.page
              .screenshot({
                path: path.join(output, candidate.name + '-' + target.name + '-failure.png'),
              })
              .catch(() => null);
            throw error;
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
    assert.equal(report.passed, true, 'every result / rematch / recovery scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-result/rooms-result.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-result.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
