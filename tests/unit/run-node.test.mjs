import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from '../../config/project.config.mjs';
import { runNode } from '../../tooling/lib/run-node.mjs';

test('project commands preserve a nonzero child status', async () => {
  assert.equal(await runNode(['-e', 'process.exit(23)']), 23);
});

test('project commands execute in the project root', async () => {
  const script =
    'process.exit(process.cwd() === ' + JSON.stringify(ROOT.replace(/[\\/]$/, '')) + ' ? 0 : 1)';
  assert.equal(await runNode(['-e', script]), 0);
});
