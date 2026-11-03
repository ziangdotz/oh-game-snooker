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

const output = path.join(ROOT, 'artifacts/testing/rooms-cue');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'The strike point is supplied through the same 8-float stroke ABI the cue controller fills, not by dragging the on-screen cue.',
    'Only one spun stroke per frame is exercised; the second seat does not answer with its own spun stroke.',
  ],
};

async function openHome(browser, target, endpoint, entry) {
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
    target.origin + '/?interior=interior-design-original&rooms=' + encodeURIComponent(endpoint),
  );
  await waitForHome(page, 'interior-design-original');
  return { context, page };
}

async function startRoom(host, guest) {
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
  const roomId = await host.page.evaluate(
    () => window.__pcolTestGame._currentController._moreDialog._room.roomId,
  );
  await guest.page.locator('input[name="room-name"]').fill('Guest');
  await guest.page.locator('input[name="room-code"]').fill(roomId);
  await guest.page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
  await guest.page.waitForFunction(
    () => window.__pcolTestGame._currentController._moreDialog?._room?.seats?.length === 2,
  );
  for (const page of [host.page, guest.page]) {
    await page.getByRole('button', { name: 'READY', exact: true }).click();
  }
  for (const page of [host.page, guest.page]) {
    await page.waitForFunction(
      () => window.__pcolTestGame._currentController._moreDialog?._room?.status === 'ready',
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
      { timeout: 90000 },
    );
  }
  return roomId;
}

async function waitSettled(page) {
  await page.waitForFunction(
    () => {
      const controller = window.__pcolTestGame._currentController;
      return (
        controller._model.gState === 4 &&
        controller._model.getContext('nRounds') >= 1 &&
        !controller._motion?.active
      );
    },
    null,
    { timeout: 120000 },
  );
}

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
            entry.roomCode = await startRoom(host, guest);
            await host.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              await controller._model.reqRespotCueball({ x: -1.04, y: 0.90625, z: -0.145 });
            });
            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => window.__pcolTestGame._currentController._model.getContext('inHand') <= 1,
              );
            }

            // A backspin strike point: below the equator, cue driving along +x.
            // The strike point and axis travel through the real stroke ABI, so
            // this is the cue controller's own payload shape, not a test-only
            // convenience channel.
            const draw = await host.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              const cue = controller._simulator.getCueBallPosition();
              const radius = controller._simulator.ballRadius;
              const power = 0.25;
              const vars = new Float32Array(8);
              vars[0] = cue.x - radius * 0.98;
              vars[1] = cue.y - radius * 0.35;
              vars[2] = cue.z;
              vars[3] = 1;
              vars[4] = 0;
              vars[5] = 0;
              vars[6] = (0.5 + 11 * power) * (3.2 + 6 * power);
              vars[7] = 0.005;
              controller._model.reportPlayerStroke(controller._model.remoteSeatIndex);
              controller._simulator.stroke(vars);
              return { radius };
            });
            entry.cueRadius = draw.radius;
            await waitSettled(host.page);
            await waitSettled(guest.page);

            const read = (page) =>
              page.evaluate(() => {
                const controller = window.__pcolTestGame._currentController;
                const balls = controller._simulator.getBalls();
                return {
                  version: controller._model._version,
                  nRounds: controller._model.getContext('nRounds'),
                  cue: [
                    Number(balls[0].position.x.toFixed(4)),
                    Number(balls[0].position.z.toFixed(4)),
                  ],
                  table: balls.map((ball) => [
                    Number(ball.position.x.toFixed(4)),
                    Number(ball.position.z.toFixed(4)),
                  ]),
                };
              });
            const hostSeen = await read(host.page);
            const guestSeen = await read(guest.page);
            entry.hostSeen = hostSeen;
            entry.guestSeen = guestSeen;

            assert.equal(hostSeen.nRounds, 1, 'the spun stroke is judged exactly once');
            assert.equal(hostSeen.version, 2, 'the spun stroke advanced the frame once');
            assert.deepEqual(guestSeen.table, hostSeen.table, 'both seats agree on every ball');
            // Backspin must pull the cue ball back behind the object ball; a flat
            // centre hit on this layout leaves it well past it.
            assert.ok(
              hostSeen.cue[0] < 0.9,
              'backspin draws the cue ball back instead of running through',
            );
            entry.drawDistance = hostSeen.cue[0];

            // The service still owns the impulse: a strike point that is not on
            // the cue ball is refused, and no frame is consumed.
            const offBall = await guest.page.evaluate(async () => {
              const controller = window.__pcolTestGame._currentController;
              const room = controller._model._room;
              const cue = controller._simulator.getCueBallPosition();
              try {
                await room.submitShot({
                  direction: { x: 1, z: 0 },
                  power: 0.25,
                  kiss: { x: cue.x + 3, y: cue.y, z: cue.z },
                  axis: { x: 1, y: 0, z: 0 },
                });
                return { rejected: false };
              } catch (error) {
                return { rejected: true, code: error.code };
              }
            });
            entry.offBallRejected = offBall;
            assert.equal(offBall.rejected, true, 'a strike point off the ball is refused');
            assert.equal(
              offBall.code,
              'invalid_shot',
              'the service names the rejected geometry explicitly',
            );
            const versionAfter = await host.page.evaluate(
              () => window.__pcolTestGame._currentController._model._version,
            );
            entry.versionStable = versionAfter === hostSeen.version;
            assert.equal(versionAfter, hostSeen.version, 'a refused strike consumes no frame');
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
    assert.equal(report.passed, true, 'every full-cue scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-cue.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-cue/rooms-cue.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-cue.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
