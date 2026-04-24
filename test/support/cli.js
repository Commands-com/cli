import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { initGitRepo } from './git.js';

const BIN = fileURLToPath(new URL('../../bin/commands-com.js', import.meta.url));

export function runCli(args, cwd, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      cwd,
      timeout: 30_000,
      env: { ...process.env, ...env },
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

export function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || stdout || error.message}`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export async function tempDir(prefix = 'commands-com-e2e-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
