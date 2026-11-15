import { runNode } from '../tooling/lib/run-node.mjs';

process.exitCode = await runNode(['tests/e2e/match-opening-scenes.test.mjs']);
