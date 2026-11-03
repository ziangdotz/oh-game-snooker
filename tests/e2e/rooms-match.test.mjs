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

const output = path.join(ROOT, 'artifacts/testing/rooms-match');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'Motion is applied as stable per-stroke snapshots; continuous frame interpolation is not implemented.',
    'Only centre-ball direction and power are submitted; side spin and jump shots are not covered.',
  ],
};

async function openHome(browser, target, endpoint, entry) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

async function waitForRemoteTable(page) {
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
}

async function tableState(page) {
  return page.evaluate(() => {
    const controller = window.__pcolTestGame._currentController;
    const cue = controller._simulator.getCueBallPosition();
    return {
      mode: controller._model._mode,
      seatIndex: controller._model.remoteSeatIndex,
      players: controller._model.players.map((player) => player.displayName),
      gState: controller._model.gState,
      version: controller._model._version,
      turn: controller._model.getContext('playerIndex'),
      nRounds: controller._model.getContext('nRounds'),
      inHand: controller._model.getContext('inHand'),
      ballOn: controller._model.getContext('ballOn'),
      points: controller._model.players.map((player) => player.pts),
      penalties: controller._model.players.map((player) => player.penalty),
      penalty: controller._model.players.map((player) => player.penalty),
      cue: [Number(cue.x.toFixed(4)), Number(cue.z.toFixed(4))],
      result: { ...controller._model._refResult },
      control: controller._activeSubControl?.name ?? null,
    };
  });
}

async function ballTable(page) {
  return page.evaluate(() =>
    window.__pcolTestGame._currentController._simulator
      .getBalls()
      .map((ball) => [
        ball.number,
        ball.active,
        Number(ball.position.x.toFixed(6)),
        Number(ball.position.z.toFixed(6)),
        Number(ball.v.x.toFixed(6)),
        Number(ball.v.z.toFixed(6)),
      ]),
  );
}

const CUE_START = { x: -1.04, z: -0.145 };
const SHOT = { power: 0.25, direction: { x: 1, z: 0 } };

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
            const roomId = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._moreDialog._room.roomId,
            );
            await openRooms(guest.page);
            await guest.page.locator('input[name="room-name"]').fill('Guest');
            await guest.page.locator('input[name="room-code"]').fill(roomId);
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
            await waitForRemoteTable(host.page);
            await waitForRemoteTable(guest.page);
            entry.roomCode = roomId;

            const opening = await Promise.all([tableState(host.page), tableState(guest.page)]);
            assert.equal(opening[0].mode, 'remote');
            assert.deepEqual(opening[0].players, ['Host', 'Guest']);
            assert.equal(opening[0].seatIndex, 0);
            assert.equal(opening[1].seatIndex, 1);
            assert.equal(opening[0].version, 0);
            assert.equal(opening[0].inHand, 2);
            assert.deepEqual(opening[0].players.length, 2, 'the online match always has two seats');
            entry.openingVersion = opening[0].version;
            // Both seats see the same table even before the first command.
            assert.deepEqual(await ballTable(host.page), await ballTable(guest.page));

            // The server, not the browser, must reject a shot before placement.
            const early = await host.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              const vars = new Float32Array(8);
              const cue = controller._simulator.getCueBallPosition();
              vars[0] = cue.x - 0.005;
              vars[1] = cue.y;
              vars[2] = cue.z;
              vars[3] = 1;
              vars[5] = 0;
              vars[6] = 3.5;
              vars[7] = 0.005;
              controller._simulator.stroke(vars);
              await new Promise((resolve) => setTimeout(resolve, 700));
              return {
                version: controller._model._version,
                nRounds: controller._model.getContext('nRounds'),
                gState: controller._model.gState,
              };
            });
            assert.equal(early.nRounds, 0, 'a shot with the cue in hand must not be judged');
            await host.page.waitForFunction(
              () => window.__pcolTestGame._currentController._model.gState === 4,
            );
            entry.rejectedShotBeforePlacement = true;

            const placed = await host.page.evaluate(
              async ({ cue }) => {
                const controller = window.__pcolTestGame._currentController;
                const message = await controller._model.reqRespotCueball({
                  x: cue.x,
                  y: cue.y,
                  z: cue.z,
                });
                return {
                  version: message.state.version,
                  cue: message.snapshot.balls[0].position.slice(0, 3),
                };
              },
              { cue: { x: CUE_START.x, y: 0.90625, z: CUE_START.z } },
            );
            assert.equal(placed.version, 1);
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => window.__pcolTestGame._currentController._model.getContext('inHand') <= 1,
              );
            }
            const afterPlace = await Promise.all([tableState(host.page), tableState(guest.page)]);
            assert.equal(afterPlace[0].version, 1);
            assert.equal(afterPlace[0].inHand, 1);
            assert.deepEqual(afterPlace[0].cue, [-1.04, -0.145]);
            assert.deepEqual(
              afterPlace[0].cue,
              afterPlace[1].cue,
              'placement replicates to both seats',
            );
            entry.placedVersion = afterPlace[0].version;

            const shot = await host.page.evaluate(
              async ({ shot }) => {
                const controller = window.__pcolTestGame._currentController;
                const cue = controller._simulator.getCueBallPosition();
                const vars = new Float32Array(8);
                vars[0] = cue.x - 0.005;
                vars[1] = cue.y;
                vars[2] = cue.z;
                vars[3] = shot.direction.x;
                vars[5] = shot.direction.z;
                vars[6] = (0.5 + 11 * shot.power) * (3.2 + 6 * shot.power);
                vars[7] = 0.005;
                const accepted = controller._model.reportPlayerStroke(
                  controller._model.remoteSeatIndex,
                );
                controller._simulator.stroke(vars);
                return { accepted, stateAfterStroke: controller._model.gState };
              },
              { shot: SHOT },
            );
            assert.equal(shot.accepted, true, 'the local seat may shoot on its turn');
            assert.equal(shot.stateAfterStroke, 8, 'the client waits for the server verdict');

            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => {
                  const controller = window.__pcolTestGame._currentController;
                  // The judged frame is applied once the motion replay settles.
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
            const judged = await Promise.all([tableState(host.page), tableState(guest.page)]);
            assert.equal(judged[0].nRounds, 1);
            assert.equal(judged[0].version, 2);
            assert.equal(judged[0].result.score, 0);
            assert.equal(judged[0].result.foulCode, 0);
            assert.equal(judged[0].turn, 1, 'the turn passes to the opponent');
            assert.deepEqual(judged[0].points, [0, 0]);
            assert.deepEqual(judged[0].penalties, [0, 0]);
            assert.deepEqual(judged[0], {
              ...judged[1],
              seatIndex: judged[0].seatIndex,
            });
            const hostBalls = await ballTable(host.page);
            const guestBalls = await ballTable(guest.page);
            assert.deepEqual(hostBalls, guestBalls, 'both seats render identical balls');
            entry.judgedVersion = judged[0].version;
            entry.nRounds = judged[0].nRounds;
            entry.score = judged[0].result.score;
            entry.foulCode = judged[0].result.foulCode;
            entry.turnAfter = judged[0].turn;
            entry.cueAfter = judged[0].cue;

            // After the turn passes, the seat that just shot may not act again.
            const blocked = await host.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              try {
                await controller._model.reqRespotCueball({ x: -1.0, y: 0.90625, z: -0.1 });
                return { rejected: false };
              } catch (error) {
                return { rejected: true, code: error.code };
              }
            });
            assert.equal(blocked.rejected, true, 'the former shooter cannot act off turn');
            entry.offTurnCommandRejected = blocked.code ?? 'blocked';

            // The cue is not in hand any more, so even the acting seat cannot
            // reposition it until the referee says otherwise.
            const notInHand = await guest.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              try {
                await controller._model.reqRespotCueball({ x: -1.0, y: 0.90625, z: -0.1 });
                return { rejected: false };
              } catch (error) {
                return { rejected: true, code: error.code };
              }
            });
            assert.equal(notInHand.rejected, true, 'the cue ball is not in hand');
            entry.notInHandCommandRejected = notInHand.code ?? 'blocked';

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
    assert.equal(report.passed, true, 'every remote match scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-match.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-match/rooms-match.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-match.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
