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

const output = path.join(ROOT, 'artifacts/testing/rooms-motion');
await mkdir(output, { recursive: true });
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  passed: false,
  limitations: [
    'Positions are sampled from the rendered ball poses during replay, not from decoded video.',
    'Interpolation is linear between 50 ms samples; the settled snapshot remains authoritative.',
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
        const c = window.__pcolTestGame._currentController;
        return c.name === 'game' && c._model?.isRemote === true && c._model.gState === 4;
      },
      null,
      { timeout: 90000 },
    );
  }
  return roomId;
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

            // Sample the rendered cue position on both tabs while the shot replays.
            await guest.page.evaluate(() => {
              window.__motionSamples = [];
              // Sample the rendered mesh pose: the mesh, not the physics body,
              // is what proves the client interpolated the replay.
              const mesh = window.__pcolTestGame._gView._ballMeshes[0];
              const record = () => {
                window.__motionSamples.push(Number(mesh.position.x.toFixed(4)));
                if (window.__motionSamples.length < 400) {
                  window.__motionTimer = window.setTimeout(record, 16);
                }
              };
              record();
            });
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
              { power: 0.4 },
            );

            for (const page of [host.page, guest.page]) {
              await page.waitForFunction(
                () => {
                  const controller = window.__pcolTestGame._currentController;
                  return (
                    controller._model.gState === 4 && controller._model.getContext('nRounds') >= 1
                  );
                },
                null,
                { timeout: 120000 },
              );
            }
            // Give the replay a moment to finish and the final pose to settle.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const samples = await guest.page.evaluate(() => {
              window.clearTimeout(window.__motionTimer);
              return window.__motionSamples;
            });
            const distinct = [...new Set(samples)];
            const moving = distinct.filter((value) => value !== distinct[0]);
            entry.sampledValues = samples.slice(0, 24);
            entry.sampleCount = samples.length;
            entry.distinctPositions = distinct.length;
            entry.movingSamples = moving.length;
            entry.firstPosition = distinct[0];
            entry.lastPosition = distinct.at(-1);

            // A teleport would show at most two positions; interpolation shows a sweep.
            entry.replayDuration = null;
            assert.ok(
              distinct.length >= 8,
              'the rendered cue ball must sweep through intermediate positions',
            );
            assert.ok(
              moving.length >= 6,
              'intermediate positions must differ from the strike frame',
            );
            const finalPosition = await guest.page.evaluate(() =>
              Number(
                window.__pcolTestGame._currentController._simulator
                  .getBalls()[0]
                  .position.x.toFixed(4),
              ),
            );
            entry.finalPosition = finalPosition;
            assert.ok(
              Math.abs(finalPosition - distinct.at(-1)) < 0.05,
              'the replay must end at the authoritative settled position',
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
    assert.equal(report.passed, true, 'every motion replay scenario must pass');
  } finally {
    await service.close();
    await fixture.close();
  }
  await writeFile(path.join(output, 'rooms-motion.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('report: artifacts/testing/rooms-motion/rooms-motion.json');
} catch (error) {
  await writeFile(path.join(output, 'rooms-motion.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
}
