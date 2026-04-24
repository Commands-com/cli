import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../src/git.js';

export function fileStore(root, runId = 'unit-merge-run') {
  const writes = [];
  return {
    runId,
    writes,
    async write(file, text) {
      writes.push(file);
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(text), 'utf8');
      return target;
    },
    async writeJson(file, value) {
      return this.write(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

export async function initGitRepo(cwd, {
  initialCommit = true,
  readmeText = '# Test\n',
} = {}) {
  await runGit(['init'], cwd);
  await runGit(['config', 'user.email', 'test@example.com'], cwd);
  await runGit(['config', 'user.name', 'Test User'], cwd);
  if (!initialCommit) {
    return;
  }
  await fs.writeFile(path.join(cwd, 'README.md'), readmeText, 'utf8');
  await runGit(['add', 'README.md'], cwd);
  await runGit(['commit', '--no-gpg-sign', '-m', 'init'], cwd);
}

export async function readTaskStatus(storeRoot, taskId, cycle = 1) {
  return JSON.parse(await fs.readFile(
    path.join(storeRoot, `cycle-${cycle}`, 'tasks', taskId, 'status.json'),
    'utf8',
  ));
}

export async function gitStateSnapshot(cwd) {
  const [status, cached, index] = await Promise.all([
    runGit(['status', '--short'], cwd),
    runGit(['diff', '--cached', '--name-only'], cwd),
    runGit(['ls-files', '--stage'], cwd),
  ]);
  assert.equal(status.ok, true, status.stderr);
  assert.equal(cached.ok, true, cached.stderr);
  assert.equal(index.ok, true, index.stderr);
  return {
    status: status.stdout,
    cached: cached.stdout,
    index: index.stdout,
  };
}
