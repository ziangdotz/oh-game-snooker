import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../config/project.config.mjs';
import { captureBrowserPhysics } from '../tooling/testing/capture-browser-physics.mjs';

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

await captureBrowserPhysics(values);
