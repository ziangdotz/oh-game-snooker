import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { ROOT } from '../../tooling/lib/integrity.mjs';

const candidates = [
  process.env.PCOL_BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next locally installed browser.
  }
}

async function openRoomPage(browser, origin, wsUrl) {
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/healthz');
  await page.evaluate((url) => {
    window.__roomMessages = [];
    window.__roomErrors = [];
    window.__roomOpen = false;
    window.__roomSocket = new window.WebSocket(url);
    window.__roomSocket.addEventListener('open', () => {
      window.__roomOpen = true;
    });
    window.__roomSocket.addEventListener('error', () => {
      window.__roomErrors.push('websocket error');
    });
    window.__roomSocket.addEventListener('close', (event) => {
      window.__roomClosed = { code: event.code, reason: event.reason };
    });
    window.__roomSocket.addEventListener('message', (event) => {
      window.__roomMessages.push(JSON.parse(event.data));
    });
  }, wsUrl);
  await page.waitForFunction(() => window.__roomOpen === true);
  return { context, page, errors };
}

async function send(page, message) {
  await page.evaluate((payload) => {
    window.__roomSocket.send(JSON.stringify({ v: 1, ...payload }));
  }, message);
}

async function waitForMessage(page, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const messages = await page.evaluate(() => window.__roomMessages);
    const found = messages.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = await page.evaluate(() => ({
    messages: window.__roomMessages,
    closed: window.__roomClosed,
    errors: window.__roomErrors,
  }));
  throw new Error('Timed out waiting for browser room message: ' + JSON.stringify(diagnostic));
}

test(
  'two browser contexts create, join, ready, start and resume a room seat',
  { skip: !executablePath ? 'No local Chrome or Edge executable found' : false },
  async () => {
    const server = createRoomServer({ port: 0, host: '127.0.0.1' });
    await server.listen();
    const port = server.address().port;
    const origin = 'http://127.0.0.1:' + port;
    const wsUrl = 'ws://127.0.0.1:' + port + '/rooms';
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });
    const host = await openRoomPage(browser, origin, wsUrl);
    const guest = await openRoomPage(browser, origin, wsUrl);
    let resumed;
    let guestClosed = false;
    try {
      await send(host.page, {
        type: 'room.create',
        requestId: 'create-1',
        displayName: 'Host',
      });
      const created = await waitForMessage(
        host.page,
        (message) => message.type === 'room.created' && message.requestId === 'create-1',
      );
      assert.match(created.roomId, /^[A-Z0-9]{6}$/);
      assert.equal(created.state.seats.length, 1);
      assert.equal('token' in created.state.seats[0], false);

      await send(guest.page, {
        type: 'room.join',
        requestId: 'join-1',
        roomId: created.roomId,
        displayName: 'Guest',
      });
      const joined = await waitForMessage(
        guest.page,
        (message) => message.type === 'room.joined' && message.requestId === 'join-1',
      );
      assert.equal(joined.state.seats.length, 2);

      await send(host.page, {
        type: 'room.ready',
        requestId: 'ready-host',
        roomId: created.roomId,
        playerId: created.playerId,
        token: created.token,
        ready: true,
      });
      await send(guest.page, {
        type: 'room.ready',
        requestId: 'ready-guest',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
        ready: true,
      });
      const ready = await waitForMessage(
        host.page,
        (message) => message.type === 'room.state' && message.state.status === 'ready',
      );
      assert.equal(
        ready.state.seats.every((seat) => seat.ready),
        true,
      );
      assert.ok(ready.state.revision > created.state.revision);

      await send(host.page, {
        type: 'room.start',
        requestId: 'start-1',
        roomId: created.roomId,
        playerId: created.playerId,
        token: created.token,
      });
      const started = await waitForMessage(
        host.page,
        (message) => message.type === 'room.state' && message.state.status === 'playing',
      );
      assert.equal(started.state.match.protocolVersion, 1);
      assert.ok(started.state.revision > ready.state.revision);
      const matchId = started.state.match.matchId;
      const startSnapshot = await waitForMessage(
        host.page,
        (message) => message.type === 'match.snapshot' && message.event === 'start',
      );
      assert.equal(startSnapshot.state.version, 0);

      await send(host.page, {
        type: 'match.place',
        requestId: 'place-1',
        roomId: created.roomId,
        playerId: created.playerId,
        token: created.token,
        matchId,
        commandId: 'place-command-1',
        matchVersion: 0,
        turn: 0,
        position: { x: -1.04, z: -0.145 },
      });
      const placed = await waitForMessage(
        host.page,
        (message) => message.type === 'match.snapshot' && message.event === 'place',
      );
      assert.equal(placed.state.version, 1);
      await waitForMessage(
        guest.page,
        (message) => message.type === 'match.snapshot' && message.event === 'place',
      );

      await send(host.page, {
        type: 'match.shot',
        requestId: 'shot-1',
        roomId: created.roomId,
        playerId: created.playerId,
        token: created.token,
        matchId,
        commandId: 'shot-command-1',
        matchVersion: 1,
        turn: 0,
        shot: { direction: { x: 1, z: 0 }, power: 0.25 },
      });
      const shot = await waitForMessage(
        host.page,
        (message) => message.type === 'match.snapshot' && message.event === 'shot',
      );
      const guestShot = await waitForMessage(
        guest.page,
        (message) => message.type === 'match.snapshot' && message.event === 'shot',
      );
      assert.equal(shot.result.version, 2);
      assert.equal(shot.result.simulator.firstKissIndex > 0, true);
      assert.deepEqual(guestShot.snapshot, shot.snapshot);

      resumed = await openRoomPage(browser, origin, wsUrl);
      await send(resumed.page, {
        type: 'room.resume',
        requestId: 'resume-1',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
      });
      const resumedMessage = await waitForMessage(
        resumed.page,
        (message) => message.type === 'room.resumed' && message.requestId === 'resume-1',
      );
      assert.equal(resumedMessage.state.status, 'playing');
      assert.equal(
        resumedMessage.state.seats.find((seat) => seat.playerId === joined.playerId).connected,
        true,
      );
      const resumedSnapshot = await waitForMessage(
        resumed.page,
        (message) => message.type === 'match.snapshot' && message.event === 'resume',
      );
      assert.equal(resumedSnapshot.state.version, 2);
      assert.deepEqual(resumedSnapshot.snapshot, shot.snapshot);

      // The old tab is still open while the new tab resumes. Closing it must
      // not disconnect the newly bound browser session.
      await guest.context.close();
      guestClosed = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await send(resumed.page, {
        type: 'room.state',
        requestId: 'state-after-old-close',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
      });
      const afterOldClose = await waitForMessage(
        resumed.page,
        (message) => message.type === 'room.state' && message.requestId === 'state-after-old-close',
      );
      assert.equal(
        afterOldClose.state.seats.find((seat) => seat.playerId === joined.playerId).connected,
        true,
      );
      assert.equal(afterOldClose.state.status, 'playing');

      await send(resumed.page, {
        type: 'room.leave',
        requestId: 'leave-1',
        roomId: joined.roomId,
        playerId: joined.playerId,
        token: joined.token,
      });
      const left = await waitForMessage(
        resumed.page,
        (message) => message.type === 'room.left' && message.requestId === 'leave-1',
      );
      assert.equal(left.closed, true);
      assert.deepEqual(host.errors, []);
      assert.deepEqual(guest.errors, []);
      assert.deepEqual(resumed.errors, []);

      const report = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        browser: {
          name: path.basename(executablePath).toLowerCase().includes('edge') ? 'edge' : 'chrome',
          version: browser.version(),
        },
        contexts: 3,
        steps: [
          'create',
          'join',
          'ready',
          'start',
          'place-cue-ball',
          'shot',
          'resume-with-old-transport-open',
          'close-old-transport',
          'leave',
        ],
        match: {
          matchId,
          startVersion: startSnapshot.state.version,
          placedVersion: placed.state.version,
          shotVersion: shot.state.version,
          shotPower: 0.25,
          firstKissIndex: shot.result.simulator.firstKissIndex,
          nKissed: shot.result.simulator.nKissed,
          score: shot.result.score,
          foulCode: shot.result.foulCode,
          turnAfter: shot.result.nextTurn,
          snapshotsEqualBetweenBrowsers: true,
          resumedVersion: resumedSnapshot.state.version,
        },
        seatStayedConnectedAfterOldTransport: true,
        passed: true,
      };
      const reportPath = path.join(ROOT, 'reports/validation/room-lifecycle.json');
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log('report: ' + path.relative(ROOT, reportPath));
    } finally {
      await resumed?.context.close();
      await host.context.close();
      if (!guestClosed) {
        await guest.context.close();
      }
      await browser.close();
      await server.close();
    }
  },
);
