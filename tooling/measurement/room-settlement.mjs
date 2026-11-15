import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { ROOT } from '../../config/project.config.mjs';
import { sha256 } from '../lib/integrity.mjs';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';
import { createMatchSession } from '../../src/server/matches/match-session.mjs';
import createRoomClient from '../../src/infrastructure/net/room-client.js';

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { samples: sorted.length, median: q(0.5), p95: q(0.95), max: sorted.at(-1) };
}

/** Real loopback WebSocket commands; timings are outside production code. */
export async function measureRoomSettlement(label) {
  const samples = [];
  let active;
  const server = createRoomServer({
    port: 0,
    matchFactory: async (options) => {
      const started = performance.now();
      const session = await createMatchSession(options);
      active.creationMs = performance.now() - started;
      const shoot = session.shoot;
      session.shoot = (command) => {
        const start = performance.now();
        const cpu = process.cpuUsage();
        active.timer = new Promise((resolve) => {
          setTimeout(() => resolve(performance.now() - start), 0);
        });
        try {
          return shoot(command);
        } finally {
          active.settlementMs = performance.now() - start;
          const usage = process.cpuUsage(cpu);
          active.cpuMs = (usage.user + usage.system) / 1000;
        }
      };
      return session;
    },
  });
  const report = {
    date: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0].model },
    buildManifestSHA256: sha256(
      await readFile(path.join(ROOT, 'build/development/build-manifest.json')),
    ),
    method:
      'Five fresh matches per power, real RoomClient and WebSocket service. CPU/wall time wraps unchanged shoot(); timer delay is a same-process event-loop stall proxy. Full command RTT includes server serialization and client parsing.',
    limitations: [
      'Loopback, same process clients; not internet RTT or cross-device input latency.',
      'One active shot at a time; not a concurrent capacity test.',
      'Timer delay includes dispatch overhead and is not an independent-process probe.',
    ],
    samples,
    passed: false,
  };
  await server.listen();
  try {
    for (let run = 1; run <= 5; run++) {
      for (const power of [0.1, 0.25, 0.65]) {
        active = { run, power };
        const options = {
          endpoint: 'ws://127.0.0.1:' + server.address().port + '/rooms',
          WebSocket,
          reconnectDelays: [],
          requestTimeout: 30000,
        };
        const host = createRoomClient(globalThis, options);
        const guest = createRoomClient(globalThis, options);
        try {
          await Promise.all([host.open(), guest.open()]);
          await host.send({ type: 'room.create', displayName: 'Host' });
          await guest.send({
            type: 'room.join',
            roomId: host.identity.roomId,
            displayName: 'Guest',
          });
          await Promise.all([
            host.send({ type: 'room.ready', ready: true }),
            guest.send({ type: 'room.ready', ready: true }),
          ]);
          const start = performance.now();
          await host.send({ type: 'room.start' });
          active.startRttMs = performance.now() - start;
          const matchId = host.state.match.matchId;
          await host.send({
            type: 'match.place',
            matchId,
            commandId: 'place',
            matchVersion: 0,
            turn: 0,
            position: { x: -1.04, z: -0.145 },
          });
          const before = performance.now();
          const result = await host.send({
            type: 'match.shot',
            matchId,
            commandId: 'shot',
            matchVersion: 1,
            turn: 0,
            shot: { direction: { x: 1, z: 0 }, power },
          });
          active.shotRttMs = performance.now() - before;
          active.timerDelayMs = await active.timer;
          delete active.timer;
          active.replyBytes = Buffer.byteLength(JSON.stringify(result));
          active.motionFrames = result.result.motion?.frames?.length ?? null;
          assert.equal(result.state.nRounds, 1);
          samples.push(active);
          console.log('Room shot', run, power, active.settlementMs.toFixed(2), 'ms');
          await host.leave();
        } finally {
          host.close();
          guest.close();
        }
      }
    }
    report.summary = Object.fromEntries(
      [
        'creationMs',
        'startRttMs',
        'settlementMs',
        'cpuMs',
        'timerDelayMs',
        'shotRttMs',
        'replyBytes',
      ].map((key) => [key, stats(samples.map((s) => s[key]))]),
    );
    report.passed = true;
  } finally {
    await server.close();
    const directory = path.join(ROOT, 'reports/measurement');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'room-settlement-' + label + '-summary.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}
