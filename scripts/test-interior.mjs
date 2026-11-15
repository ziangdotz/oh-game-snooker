import { runNode } from '../tooling/lib/run-node.mjs';
import { verifyBuild } from '../tooling/build/verify-build.mjs';

// Existing verified builds are inputs; suites run sequentially and own their servers.
await verifyBuild('development');
await verifyBuild('production');
for (const suite of [
  'interior-loading-continuity',
  'interior-ui',
  'interior-transition',
  'interior-selection',
  'interior-switching',
  'startup-recovery',
]) {
  const code = await runNode(['tests/e2e/' + suite + '.test.mjs']);
  if (code !== 0) {
    process.exitCode = code || 1;
    break;
  }
}
