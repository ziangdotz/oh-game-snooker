import { measureRoomSettlement } from '../tooling/measurement/room-settlement.mjs';

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== '--label' ||
  !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(args[1])
) {
  throw new Error('Usage: node scripts/measure-room-settlement.mjs --label LABEL');
}
await measureRoomSettlement(args[1]);
