import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRoomServer } from '../src/server/rooms/room-server.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT || '8787' },
    host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
    // TLS material turns the service into HTTPS/WSS; without it the socket is
    // plaintext and only suitable for loopback.
    key: { type: 'string' },
    cert: { type: 'string' },
    // Comma separated browser origins allowed to open a seat.
    origins: { type: 'string', default: '' },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('Invalid room service port: ' + values.port);
}
if (Boolean(values.key) !== Boolean(values.cert)) {
  throw new Error('Pass both --key and --cert, or neither');
}
const tls = values.key ? { key: readFileSync(values.key), cert: readFileSync(values.cert) } : null;
const origins = values.origins
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const server = createRoomServer({ port, host: values.host, tls, origins });
const address = await server.listen();
const scheme = tls ? 'wss' : 'ws';
console.log('Room service: ' + scheme + '://' + values.host + ':' + address.port + '/rooms');
if (tls) {
  console.log('TLS enabled; the page must use a wss:// endpoint for this service.');
}
if (origins.length > 0) {
  console.log('Allowed browser origins: ' + origins.join(', '));
} else if (tls) {
  console.warn('No --origins given: any browser origin may open a seat.');
}

let closing = false;
async function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
