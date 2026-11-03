import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createRoomServer } from '../../src/server/rooms/room-server.mjs';

/**
 * WSS smoke test. It generates a throwaway self-signed certificate and drives a
 * full lobby over TLS, which is the transport a public deployment needs. It does
 * not prove a public hostname, a real certificate chain or cross-device play.
 */
function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeCertificate() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rooms-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const configPath = path.join(dir, 'openssl.cnf');
  writeFileSync(configPath, '[req]\ndistinguished_name=dn\n[dn]\n');
  execFileSync(
    'openssl',
    [
      'req',
      '-config',
      configPath,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  );
  return {
    tls: { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Minimal HTTPS GET that tolerates the throwaway self-signed certificate. */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
  });
}

function connect(url, options) {
  const socket = new WebSocket(url, options);
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  const next = () =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error('message timeout')), 15000);
      waiters.push((message) => {
        globalThis.clearTimeout(timer);
        resolve(message);
      });
    });
  const find = async (type) => {
    for (let index = 0; index < 40; index += 1) {
      const message = await next();
      if (message.type === type) {
        return message;
      }
    }
    throw new Error('never received ' + type);
  };
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    opened,
    next,
    find,
    send: (message) =>
      socket.send(JSON.stringify({ v: 1, requestId: 't-' + Math.random(), ...message })),
    close: () => socket.close(),
  };
}

const TLS_AVAILABLE = hasOpenssl();

test('a full room lifecycle works over WSS with TLS material', async (t) => {
  if (!TLS_AVAILABLE) {
    t.skip('openssl is not available, so no throwaway certificate can be made');
    return;
  }
  const certificate = makeCertificate();
  t.after(() => certificate.dispose());
  const server = createRoomServer({
    port: 0,
    host: '127.0.0.1',
    tls: certificate.tls,
    origins: ['https://play.example.test'],
  });
  await server.listen();
  t.after(() => server.close());
  assert.equal(server.secure, true, 'the service reports that it serves TLS');

  const port = server.address().port;
  const url = 'wss://127.0.0.1:' + port + '/rooms';
  const socketOptions = { rejectUnauthorized: false, origin: 'https://play.example.test' };

  const host = connect(url, socketOptions);
  await host.opened;
  t.after(() => host.close());
  await host.find('room.hello');
  host.send({
    type: 'room.create',
    displayName: 'Host',
    interior: 'interior-design-original',
  });
  const created = await host.find('room.created');
  const seat = { roomId: created.roomId, playerId: created.playerId, token: created.token };

  const guest = connect(url, socketOptions);
  await guest.opened;
  t.after(() => guest.close());
  await guest.find('room.hello');
  guest.send({ type: 'room.join', roomId: created.roomId, displayName: 'Guest' });
  const joined = await guest.find('room.joined');
  const guestSeat = { roomId: joined.roomId, playerId: joined.playerId, token: joined.token };
  assert.equal(joined.state.seats.length, 2);

  host.send({ type: 'room.ready', ...seat, ready: true });
  guest.send({ type: 'room.ready', ...guestSeat, ready: true });
  for (let index = 0; index < 60; index += 1) {
    if (server.service.state(seat).state.status === 'ready') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(server.service.state(seat).state.status, 'ready');

  host.send({ type: 'room.start', ...seat });
  const started = await host.find('match.snapshot');
  assert.ok(started.snapshot, 'the authoritative snapshot arrives over WSS');
  assert.equal(server.service.state(seat).state.status, 'playing');

  // The health endpoint must answer over HTTPS too, for deploy probes.
  const health = await httpsGetJson('https://127.0.0.1:' + port + '/healthz');
  assert.equal(health.ok, true, 'the deploy probe answers over HTTPS');
  assert.equal(health.rooms, 1);
  assert.equal(health.matches, 1);

  // A browser origin outside the allow list is still refused over TLS.
  const intruder = connect(url, {
    rejectUnauthorized: false,
    origin: 'https://evil.example.test',
  });
  const refused = await intruder.opened.then(
    () => 'open',
    (error) => error.message,
  );
  assert.notEqual(refused, 'open', 'a foreign origin is refused over WSS');
  intruder.socket.terminate();
});

test('a plain ws client cannot use a TLS room service', async (t) => {
  if (!TLS_AVAILABLE) {
    t.skip('openssl is not available, so no throwaway certificate can be made');
    return;
  }
  const certificate = makeCertificate();
  t.after(() => certificate.dispose());
  const server = createRoomServer({ port: 0, host: '127.0.0.1', tls: certificate.tls });
  await server.listen();
  t.after(() => server.close());
  const plain = new WebSocket('ws://127.0.0.1:' + server.address().port + '/rooms');
  const answer = await new Promise((resolve) => {
    plain.once('open', () => resolve('open'));
    plain.once('error', (error) => resolve(error.message));
  });
  assert.notEqual(answer, 'open', 'a plaintext socket cannot reach a TLS service');
  plain.terminate();
});
