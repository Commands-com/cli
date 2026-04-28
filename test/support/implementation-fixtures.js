import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../src/git.js';

export async function initGitRepo(cwd) {
  await runGit(['init'], cwd);
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test\n', 'utf8');
  await runGit(['add', 'README.md'], cwd);
  await runGit([
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test User',
    'commit',
    '-m',
    'init',
  ], cwd);
}

export function fileStore(root, runId = 'unit-run') {
  return {
    runId,
    async write(file, text) {
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

export async function writeExecutable(file, lines) {
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  await fs.chmod(file, 0o755);
}

export async function readTaskStatus(storeRoot, taskId, cycle = 1) {
  return JSON.parse(await fs.readFile(
    path.join(storeRoot, `cycle-${cycle}`, 'tasks', taskId, 'status.json'),
    'utf8',
  ));
}

export function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function implementationPlanText(tasks) {
  return [
    '```json',
    JSON.stringify({ tasks }),
    '```',
  ].join('\n');
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
