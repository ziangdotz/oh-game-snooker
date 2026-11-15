import { measureLoading, measureVenueSwitching } from '../tooling/measurement/loading-profile.mjs';

const args = process.argv.slice(2);
const options = { runs: 5, mode: 'startup' };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.slice(2);
  if (!args[i].startsWith('--') || !['label', 'runs', 'mode'].includes(key) || !args[i + 1]) {
    throw new Error(
      'Usage: node scripts/measure-loading.mjs --label LABEL [--runs 1..20] [--mode startup|switching]',
    );
  }
  options[key] = key === 'runs' ? Number(args[i + 1]) : args[i + 1];
}
if (
  !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.label || '') ||
  !Number.isInteger(options.runs) ||
  options.runs < 1 ||
  options.runs > 20 ||
  !['startup', 'switching'].includes(options.mode)
) {
  throw new Error('Invalid loading measurement options');
}
await (options.mode === 'switching' ? measureVenueSwitching(options) : measureLoading(options));
