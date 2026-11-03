import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { ROOT } from '../config/project.config.mjs';
import { inspectSourceEntry } from '../tooling/testing/runtime-inspection.mjs';
import { PHYSICS_FIXTURES } from '../tooling/validation/headless-match.mjs';

const { values } = parseArgs({
  options: {
    cdp: { type: 'string', default: process.env.PCOL_CDP || 'http://127.0.0.1:9778' },
    origin: { type: 'string', default: process.env.PCOL_ORIGIN || 'http://127.0.0.1:5180' },
    out: {
      type: 'string',
      default: path.join(ROOT, 'artifacts/testing/regression/chrome-physics-cold.json'),
    },
  },
});

const origin = new URL(values.origin);
const browser = await chromium.connectOverCDP(values.cdp);
const fixtures = [];

try {
  for (const fixture of PHYSICS_FIXTURES) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).origin === origin.origin) {
        errors.push(request.url() + ': ' + (request.failure()?.errorText || 'request failed'));
      }
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin.origin) {
        return route.abort('blockedbyclient');
      }
      if (url.pathname === '/application/launch-game.js') {
        const source = await readFile(path.join(ROOT, 'src/application/launch-game.js'), 'utf8');
        return route.fulfill({
          body: inspectSourceEntry(source, { application: true }),
          contentType: 'text/javascript',
        });
      }
      if (url.pathname === '/runtime/source-entry.js') {
        const source = await readFile(path.join(ROOT, 'src/runtime/source-entry.js'), 'utf8');
        return route.fulfill({
          body: inspectSourceEntry(source),
          contentType: 'text/javascript',
        });
      }
      return route.continue();
    });
    try {
      await page.goto(origin.href, { waitUntil: 'domcontentloaded' });
      await page.locator('.side-button').filter({ hasText: 'SINGLE PLAY' }).waitFor();
      await page.locator('.side-button').filter({ hasText: 'SINGLE PLAY' }).click();
      await page.locator('[data-sid="ai1"]').click();
      await page.locator('.score-container .head').first().waitFor();
      await page.waitForFunction(
        () =>
          globalThis.__pcolTestGame?._currentController?._simulator?._world?.environmentReady &&
          globalThis.__pcolTestGame?._gView?._scene?.isReady(),
      );
      const result = await page.evaluate((fixture) => {
        const g = globalThis.__pcolTestGame,
          liveWorld = g._currentController._simulator._world;
        const Vec3 = globalThis.__pcolTestRequire('domain/math/vector-three'),
          WorldClient = globalThis.__pcolTestRequire('domain/physics/world-client'),
          SnookerBall = globalThis.__pcolTestRequire('domain/simulation/snooker-ball'),
          layout = globalThis.__pcolTestRequire('domain/scene/initial-layout').default;
        g._engine.stopRenderLoop();
        const mesh = liveWorld.meshBody,
          world = new WorldClient();
        world.setMeshBody(mesh);
        const spotY = mesh.ground.centerPosition.y + layout.ballRadius;
        for (let index = 0; index < layout.ballSet.length / 3; index += 1) {
          const number = layout.ballSet[3 * index],
            x = layout.ballSet[3 * index + 1],
            z = layout.ballSet[3 * index + 2],
            ball = new SnookerBall(number, layout.ballRadius, layout.ballMass, x, spotY, z, index);
          ball.reset(x, spotY, z);
          world.addBall(ball);
        }
        world.reset();
        const contacts = { ball: 0, cushion: 0 },
          removed = [];
        world.onTouchPresolve((contact) => {
          if (contact.isSS) {
            contacts.ball += 1;
          } else if (!contact.bj.ground) {
            contacts.cushion += 1;
          }
          if (!contact.isSS && contact.bj.end) {
            const contactedBall = contact.bi;
            if (contactedBall.active) {
              world.inactivateBall(contactedBall);
              removed.push(contactedBall.number);
            }
          }
        });
        world.onOutOfBounds((ball) => {
          removed.push(ball.number);
        });
        const cue = world.balls[0];
        cue.reset(...fixture.start);
        world.reset();
        cue.applyImpulseAtPoint(
          new Vec3(...fixture.velocity.map((value) => value * cue.mass)),
          new Vec3(...fixture.arm),
          0,
        );
        const frames = [];
        for (let step = 0; step < 480; step += 1) {
          world.step(world.stepSize);
          if (step % 20 === 0 || step === 479) {
            frames.push(
              world.balls.map((ball) => ({
                active: ball.active,
                position: [ball.position.x, ball.position.y, ball.position.z],
                velocity: [ball.v.x, ball.v.y, ball.v.z],
                spin: [ball.w.x, ball.w.y, ball.w.z],
                orientation: [
                  ball.orientation.x,
                  ball.orientation.y,
                  ball.orientation.z,
                  ball.orientation.w,
                ],
              })),
            );
          }
        }
        return {
          name: fixture.name,
          contacts,
          removed,
          frames,
          ballCount: world.balls.length,
          stepSize: world.stepSize,
          webGLVersion: g._engine.webGLVersion,
        };
      }, fixture);
      if (errors.length > 0) {
        throw new Error(fixture.name + ' page errors: ' + errors.join('; '));
      }
      fixtures.push(result);
      console.log(
        fixture.name.padEnd(18) +
          ' contacts=' +
          JSON.stringify(result.contacts) +
          ' removed=' +
          JSON.stringify(result.removed),
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'src',
  fixtureIsolation: 'fresh-page',
  origin: origin.origin,
  browser: {
    version: browser.version(),
    viewport: { width: 1440, height: 900 },
  },
  stepSize: 0.0167,
  fixtures,
};
await mkdir(path.dirname(values.out), { recursive: true });
await writeFile(values.out, JSON.stringify(output, null, 2) + '\n');
console.log('reference: ' + path.relative(ROOT, values.out));
