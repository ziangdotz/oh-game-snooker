import { verifyHeadlessMatch } from '../tooling/validation/verify-headless-match.mjs';

if (!(await verifyHeadlessMatch({ allowLegacy: process.argv.includes('--allow-legacy') }))) {
  process.exitCode = 1;
}
