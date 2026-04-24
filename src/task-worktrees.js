import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasLocalStatePathSegment, localWorktreesPath } from './config.js';
import { filterCliStatus, runGit } from './git.js';
import { runProcess } from './process-runner.js';
import { slug } from './run-id.js';

const TASK_WORKTREE_SLUG_MAX = 48;
const DIFF_EXCLUDED_CLI_STATE = Object.freeze([':(exclude).commands-com/**', ':(glob,exclude)**/.commands-com/**']);

function hasSafeRelativeScope(relative) {
  return Boolean(relative && relative !== '.' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeGitPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function normalizeAssignedScope(filePath) {
  const raw = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const normalized = normalizeGitPath(raw);
  if (!normalized) return '';
  return raw.endsWith('/') ? `${normalized}/` : normalized;
}

function normalizeRepoRelativePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized || normalized === '.') return '';
  return normalized;
}

export function repoRelativePathForContext(context = {}) {
  const gitRoot = context?.gitRoot || context?.repoRoot;
  if (!gitRoot || !context?.repoRoot) return '';
  const relative = path.relative(gitRoot, context.repoRoot);
  return hasSafeRelativeScope(relative) ? normalizeGitPath(relative) : '';
}

function scopedTaskCwd(context, worktreePath) {
  const relative = repoRelativePathForContext(context);
  return relative ? path.join(worktreePath, relative) : worktreePath;
}

function normalizePathRelativeToRepoRoot(filePath, repoRelativePath) {
  const normalized = normalizeGitPath(filePath);
  if (!repoRelativePath || !normalized) return normalized;
  if (normalized === repoRelativePath) return '.';
  if (normalized.startsWith(`${repoRelativePath}/`)) {
    return normalized.slice(repoRelativePath.length + 1);
  }
  return path.posix.relative(repoRelativePath, normalized) || '.';
}

function normalizeCapturedFiles(text, repoRelativePath) {
  return String(text || '')
    .split('\n')
    .map((file) => normalizePathRelativeToRepoRoot(file.trim(), repoRelativePath))
    .filter(Boolean);
}

function normalizeStatusPath(statusPath, repoRelativePath) {
  const renamed = String(statusPath || '').split(' -> ');
  if (renamed.length === 2) {
    return renamed
      .map((file) => normalizePathRelativeToRepoRoot(file, repoRelativePath))
      .join(' -> ');
  }
  return normalizePathRelativeToRepoRoot(statusPath, repoRelativePath);
}

function normalizeCapturedStatus(text, repoRelativePath) {
  if (!repoRelativePath) return text;
  return String(text || '')
    .split('\n')
    .map((line) => {
      if (!line.trim() || line.length < 4) return line;
      return `${line.slice(0, 3)}${normalizeStatusPath(line.slice(3), repoRelativePath)}`;
    })
    .join('\n');
}

function diffArgs(args, baseRef, excludeCliState = false) {
  return [...args, baseRef, '--', '.', ...(excludeCliState ? DIFF_EXCLUDED_CLI_STATE : [])];
}

async function captureCwdForScope(cwd, repoRelativePath) {
  if (!repoRelativePath) return { ok: true, cwd };
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd, { timeoutMs: 30_000 });
  if (!root.ok) {
    return {
      ok: false,
      error: (root.stderr || root.stdout).trim() || 'could not resolve scoped git root',
    };
  }
  return { ok: true, cwd: root.stdout.trim() || cwd };
}

function taskPathSegment(taskId, attempt) {
  const task = slug(taskId || 'task', TASK_WORKTREE_SLUG_MAX);
  return `${task}-attempt-${Math.max(1, attempt)}`;
}

export function taskWorktreesAvailable(context) {
  return Boolean(context?.isGit && context?.gitRoot && context?.repoRoot);
}

function requireGitRefSha(result, ref, description) {
  const sha = String(result?.stdout || '').trim();
  if (!result?.ok || !sha) {
    throw new Error(`could not resolve ${description} '${ref}'`);
  }
  return sha;
}

// git serializes worktree creation via `worktrees/.lock`; concurrent `git worktree add` against the same repo can fail with `File exists`, so we sequence the add step through a process-local mutex.
let worktreeAddChain = Promise.resolve();
function withWorktreeAddLock(fn) {
  const next = worktreeAddChain.then(fn, fn);
  worktreeAddChain = next.catch(() => {});
  return next;
}

export async function createTaskWorktree({
  integrationCwd,
  context,
  taskRoot,
  runId,
  cycle,
  taskId,
  attempt = 1,
  baseRef = 'HEAD',
}) {
  const base = await runGit(['rev-parse', '--verify', baseRef], integrationCwd);
  const baseSha = requireGitRefSha(base, baseRef, 'task worktree base');

  const worktreePath = localWorktreesPath(
    taskRoot || context.gitRoot || context.repoRoot,
    slug(runId || 'run', TASK_WORKTREE_SLUG_MAX),
    `cycle-${Math.max(1, Number(cycle) || 1)}`,
    `${taskPathSegment(taskId, attempt)}-${randomBytes(3).toString('hex')}`,
  );
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const result = await withWorktreeAddLock(() => runGit(['worktree', 'add', '--detach', worktreePath, baseSha], integrationCwd, {
    timeoutMs: 60_000,
  }));
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${(result.stderr || result.stdout).trim()}`);
  }

  return {
    path: worktreePath,
    attempt,
    baseRef,
    baseSha,
    cwd: scopedTaskCwd(context, worktreePath),
    managerCwd: integrationCwd,
  };
}

export async function removeTaskWorktree(worktree) {
  if (!worktree?.path || !worktree?.managerCwd) {
    return { ok: false, error: 'missing_task_worktree_metadata' };
  }
  const result = await runGit(['worktree', 'remove', '--force', worktree.path], worktree.managerCwd, {
    timeoutMs: 60_000,
  });
  return {
    ok: result.ok,
    error: result.ok ? '' : (result.stderr || result.stdout).trim() || 'task_worktree_remove_failed',
  };
}

export async function prepareTaskWorktreeBaseline(worktree, patch = '') {
  const text = String(patch || '');
  if (text.trim()) {
    const applied = await applyGitPatch(worktree.path || worktree.cwd, text, { threeWay: false });
    if (!applied.ok) {
      throw new Error(`task worktree base patch failed: ${(applied.stderr || applied.stdout).trim()}`);
    }
  }

  await runGit(['add', '-A', '--', '.'], worktree.cwd, { timeoutMs: 30_000 });
  const staged = await runGit(['diff', '--cached', '--quiet', '--', '.'], worktree.cwd, { timeoutMs: 30_000 });
  if (staged.ok) {
    return { baselineRef: 'HEAD', baselineSha: worktree.baseSha, committed: false };
  }
  if (staged.code !== 1) {
    throw new Error(`task worktree baseline diff failed: ${(staged.stderr || staged.stdout).trim()}`);
  }

  const committed = await runGit([
    '-c',
    'user.email=commands-com@example.invalid',
    '-c',
    'user.name=Commands.com',
    'commit',
    '--no-gpg-sign',
    '-m',
    'commands-com task baseline',
  ], worktree.cwd, { timeoutMs: 60_000 });
  if (!committed.ok) {
    throw new Error(`task worktree baseline commit failed: ${(committed.stderr || committed.stdout).trim()}`);
  }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], worktree.cwd);
  return {
    baselineRef: 'HEAD',
    baselineSha: head.ok ? head.stdout.trim() : '',
    committed: true,
  };
}

export async function captureGitPatch(cwd, {
  baseRef = 'HEAD',
  includeUntracked = false,
  maxBuffer,
  excludeCliState = false,
  repoRelativePath = '',
} = {}) {
  const normalizedRepoRelativePath = normalizeRepoRelativePath(repoRelativePath);
  const captureCwd = await captureCwdForScope(cwd, normalizedRepoRelativePath);
  if (!captureCwd.ok) {
    return emptyPatchCapture(captureCwd.error);
  }
  const isolatedIndex = includeUntracked
    ? await prepareIntentToAddIndex(captureCwd.cwd, { baseRef })
    : { ok: true, env: {}, cleanup: async () => {} };
  if (!isolatedIndex.ok) {
    return emptyPatchCapture(isolatedIndex.error);
  }

  try {
    const diffOptions = (timeoutMs) => ({
      timeoutMs,
      env: isolatedIndex.env,
      ...(maxBuffer ? { maxBuffer } : {}),
    });
    const [patch, diffStat, names, status] = await Promise.all([
      runGit(diffArgs(['diff', '--binary'], baseRef, excludeCliState), captureCwd.cwd, diffOptions(60_000)),
      runGit(diffArgs(['diff', '--stat'], baseRef, excludeCliState), captureCwd.cwd, diffOptions(30_000)),
      runGit(diffArgs(['diff', '--name-only'], baseRef, excludeCliState), captureCwd.cwd, diffOptions(30_000)),
      runGit(['status', '--short', '--', '.'], captureCwd.cwd, { timeoutMs: 30_000 }),
    ]);

    return {
      ok: Boolean(patch.ok && diffStat.ok && names.ok && status.ok),
      patch: patch.stdout,
      diffStat: diffStat.stdout.trim(),
      files: normalizeCapturedFiles(names.stdout, normalizedRepoRelativePath),
      status: normalizeCapturedStatus(filterCliStatus(status.stdout), normalizedRepoRelativePath).trim(),
      error: [patch, diffStat, names, status]
        .filter((result) => !result.ok)
        .map((result) => (result.stderr || result.stdout).trim())
        .filter(Boolean)
        .join('\n'),
    };
  } finally {
    await isolatedIndex.cleanup();
  }
}

async function prepareIntentToAddIndex(cwd, { baseRef }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-git-index-'));
  const tempIndex = path.join(tempDir, 'index');
  const env = { GIT_INDEX_FILE: tempIndex };

  async function cleanup() {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const copied = await copyCurrentIndex(cwd, tempIndex, { baseRef, env });
  if (!copied.ok) {
    await cleanup();
    return { ok: false, error: copied.error };
  }

  const added = await runGit(['add', '-N', '--', '.'], cwd, {
    timeoutMs: 30_000,
    env,
  });
  if (!added.ok) {
    await cleanup();
    return {
      ok: false,
      error: (added.stderr || added.stdout).trim() || 'git intent-to-add failed',
    };
  }

  return { ok: true, env, cleanup };
}

async function copyCurrentIndex(cwd, tempIndex, { baseRef, env }) {
  const currentIndex = await runGit(['rev-parse', '--git-path', 'index'], cwd, { timeoutMs: 30_000 });
  if (!currentIndex.ok) {
    return {
      ok: false,
      error: (currentIndex.stderr || currentIndex.stdout).trim() || 'could not locate git index',
    };
  }

  const indexPath = path.resolve(cwd, currentIndex.stdout.trim());
  try {
    await fs.copyFile(indexPath, tempIndex);
    return { ok: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, error: error.message };
    }
  }

  const readTree = await runGit(['read-tree', baseRef], cwd, {
    timeoutMs: 30_000,
    env,
  });
  return readTree.ok
    ? { ok: true }
    : {
      ok: false,
      error: (readTree.stderr || readTree.stdout).trim() || 'could not initialize temporary git index',
    };
}

function emptyPatchCapture(error) {
  return {
    ok: false,
    patch: '',
    diffStat: '',
    files: [],
    status: '',
    error,
  };
}

export async function applyGitPatch(cwd, patch, {
  threeWay = true,
  timeoutMs = 60_000,
} = {}) {
  const text = String(patch || '');
  if (!text.trim()) {
    return { ok: true, skipped: true, stdout: '', stderr: '', exitCode: 0 };
  }
  const args = ['apply', '--whitespace=nowarn'];
  if (threeWay) args.push('--3way');
  args.push('-');
  const result = await runProcess({
    command: 'git',
    args,
    cwd,
    stdin: text,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeoutMs,
  });
  return {
    ok: result.ok,
    skipped: false,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export function validatePatchFiles({ label = 'patch', files, assignedFiles } = {}) {
  const changedFiles = Array.isArray(files)
    ? files.map((file) => normalizeGitPath(file)).filter(Boolean)
    : [];
  const errors = [];
  const outsideScopeFiles = new Set();
  for (const file of changedFiles) {
    if (isOutsideTaskScope(file)) {
      errors.push(`${label} changed file outside assigned scope: ${file}`);
      outsideScopeFiles.add(file);
      continue;
    }
    if (hasLocalStatePathSegment(file)) {
      errors.push(`${label} changed CLI-owned artifact path: ${file}`);
    }
  }

  const assigned = Array.isArray(assignedFiles)
    ? assignedFiles.map((file) => normalizeAssignedScope(file)).filter(Boolean)
    : [];
  if (assigned.length) {
    for (const file of changedFiles) {
      if (outsideScopeFiles.has(file)) continue;
      if (!assigned.some((scope) => assignedScopeAllowsFile(scope, file))) {
        errors.push(`${label} changed unassigned file: ${file}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateTaskPatch({ task, files }) {
  return validatePatchFiles({ label: `task ${task?.id || 'unknown'}`, files, assignedFiles: task?.files });
}

function assignedScopeAllowsFile(scope, file) {
  return scope.endsWith('/') ? file.startsWith(scope) : file === scope;
}

function isOutsideTaskScope(file) {
  return file === '..'
    || file.startsWith('../')
    || file.includes('/../')
    || path.posix.isAbsolute(file)
    || /^[A-Za-z]:\//.test(file);
}
