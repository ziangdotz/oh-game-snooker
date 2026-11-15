import { spawn } from 'node:child_process';
import { ROOT } from '../../config/project.config.mjs';

/** Run a project command with the current Node, preserving its exit status. */
export function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error('Node command stopped: ' + signal));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
