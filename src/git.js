import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasLocalStatePathSegment, localWorktreesPath } from './config.js';
import { slug, timestamp } from './run-id.js';
import { WORKSPACE_MODES } from './workflow-constants.js';

const PORCELAIN_LINE_RE = /^[ MADRCUT?!][ MADRCUT?!] /;

// Shorter cap than run-store to leave headroom in git ref and filesystem path
// lengths: branch is `commands-com/<kind>/<label>-<suffix>` plus worktree path.
const WORKTREE_SLUG_MAX = 42;
const GIT_EXEC_MAX_BUFFER = 50 * 1024 * 1024;

function buildWorktreePlan(repoRoot, kind, label, now = timestamp(), suffix = randomBytes(3).toString('hex')) {
  const safeKind = slug(kind || 'run', WORKTREE_SLUG_MAX);
  const safeLabel = slug(label || safeKind, WORKTREE_SLUG_MAX);
  const id = `${now}-${safeKind}-${safeLabel}-${suffix}`;
  return {
    id,
    branch: `commands-com/${safeKind}/${safeLabel}-${suffix}`,
    path: localWorktreesPath(repoRoot, id),
  };
}

/**
 * @typedef {Object} GitCommandResult
 * @property {boolean} ok Whether git exited successfully.
 * @property {number|string} code Numeric git exit code or child-process error code. Successful commands return 0.
 * @property {string} reason Empty for success; otherwise `exit`, `spawn`, `timeout`, `max-buffer`, `signal`, or `error`.
 * @property {string} errorCode Verbatim child-process error code when available.
 * @property {string} stdout Captured stdout.
 * @property {string} stderr Captured stderr.
 */

/**
 * Repository context captured by `collectRepoContext`. The first three string
 * fields are always present; the rest may be empty when git fails or the
 * directory is not a git repository.
 *
 * @typedef {Object} RepoContext
 * @property {boolean} isGit Whether `cwd` is inside a git working tree.
 * @property {string} repoRoot Real path of the requested working directory.
 * @property {string} gitRoot Real path of the detected git toplevel; empty when not a git repo.
 * @property {string} branch Current branch name (empty for detached HEAD).
 * @property {string} head Short HEAD sha.
 * @property {string} status Filtered porcelain status text.
 * @property {string} diffStat `git diff --stat` output.
 * @property {string} diff `git diff` output, or the failure marker when capture failed.
 * @property {string} diffError Failure marker emitted when changed-only diff capture failed.
 */

/**
 * Diff/status snapshot for an isolated worktree, returned by
 * `getWorktreeDiffStatus`.
 *
 * @typedef {Object} WorktreeDiffStatus
 * @property {boolean} ok Whether both git invocations succeeded.
 * @property {boolean} hasChanges Whether the worktree has any pending diff or status entries.
 * @property {string} diffStat `git diff --stat` output.
 * @property {string} status `git status --short` output.
 */

/**
 * Worktree plan record produced by `buildWorktreePlan` and embedded in the
 * `IsolatedWorktree` returned to callers.
 *
 * @typedef {Object} IsolatedWorktreePlan
 * @property {string} id Stable worktree identifier (also used as a directory name).
 * @property {string} branch Branch name created for the isolated worktree.
 * @property {string} path Absolute filesystem path of the new worktree.
 */

/**
 * Isolated worktree returned by `createIsolatedWorktree`. Extends the plan
 * with the resolved base ref/sha and the original repo's pre-checkout state.
 *
 * @typedef {IsolatedWorktreePlan & {
 *   baseRef: string,
 *   baseSha: string,
 *   originalRepoRoot: string,
 *   originalStatus: string,
 * }} IsolatedWorktree
 */

/**
 * Workspace shape consumed by `pruneIsolatedWorktree`. Matches the
 * `CycleWorkspace` mutation surface at the boundary.
 *
 * @typedef {Object} PruneWorktreeWorkspace
 * @property {string} mode Workspace mode; only `worktree` is pruned.
 * @property {string} [originalRepoRoot] Original repo root used for the prune command.
 * @property {string} [path] Worktree path.
 * @property {string} [cwd] Worktree cwd fallback.
 * @property {string} [branch] Worktree branch deleted after prune.
 */

/**
 * Result returned by `pruneIsolatedWorktree`.
 *
 * @typedef {Object} PruneWorktreeResult
 * @property {boolean} ok Whether the prune succeeded (including skipped no-op cases).
 * @property {boolean} [skipped] Whether the prune was a no-op for a non-worktree workspace.
 * @property {string} [reason] Skip reason, when applicable.
 * @property {string} [error] Failure detail when `ok` is false.
 */

/**
 * Run a git command and resolve with a stable result object instead of throwing.
 *
 * @param {string[]} args Git arguments.
 * @param {string} cwd Working directory.
 * @param {{ timeoutMs?: number, maxBuffer?: number, env?: Record<string, string> }} [options]
 * @returns {Promise<GitCommandResult>}
 */
export function runGit(args, cwd, { timeoutMs = 10_000, maxBuffer = GIT_EXEC_MAX_BUFFER, env } = {}) {
  return new Promise((resolve) => {
    const outputBuffer = normalizeGitMaxBuffer(maxBuffer);
    const commandEnv = env && typeof env === 'object'
      ? { ...process.env, ...env }
      : undefined;
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: outputBuffer,
      env: commandEnv,
    }, (error, stdout = '', stderr = '') => {
      const classification = classifyGitError(error);
      resolve({
        ok: !error,
        code: error ? gitErrorCode(error, classification) : 0,
        reason: classification.reason,
        errorCode: classification.errorCode,
        stdout: String(stdout || ''),
        stderr: gitStderr(error, stderr, args, {
          maxBuffer: outputBuffer,
          timeoutMs,
          classification,
        }),
      });
    });
  });
}

function normalizeGitMaxBuffer(maxBuffer) {
  const value = Number(maxBuffer);
  return Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : GIT_EXEC_MAX_BUFFER;
}

function classifyGitError(error) {
  if (!error) return { reason: '', errorCode: '' };

  const errorCode = typeof error.code === 'string' ? error.code : '';
  if (errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { reason: 'max-buffer', errorCode };
  }
  if (errorCode === 'ETIMEDOUT' || error.killed === true) {
    return { reason: 'timeout', errorCode };
  }
  if (isSpawnError(error, errorCode)) {
    return { reason: 'spawn', errorCode };
  }
  if (typeof error.code === 'number') {
    return { reason: 'exit', errorCode };
  }
  if (typeof error.signal === 'string' && error.signal) {
    return { reason: 'signal', errorCode };
  }
  return { reason: 'error', errorCode };
}

function isSpawnError(error, errorCode) {
  const syscall = String(error?.syscall || '');
  return syscall.startsWith('spawn')
    || (Boolean(error?.path) && ['EACCES', 'ENOENT', 'EPERM'].includes(errorCode));
}

function gitErrorCode(error, classification) {
  if (classification.reason === 'timeout') return 124;
  if (typeof error?.code === 'number' || typeof error?.code === 'string') return error.code;
  if (typeof error?.signal === 'string' && error.signal) return error.signal;
  return 1;
}

function gitStderr(error, stderr, args, {
  maxBuffer,
  timeoutMs,
  classification,
}) {
  const text = String(stderr || '');
  if (!error) return text;
  if (classification.reason === 'timeout' && !text.trim()) {
    return `git command timed out after ${formatDurationMs(timeoutMs)} while running "git ${args.join(' ')}".`;
  }
  if (classification.reason === 'spawn' && !text.trim()) {
    return error.message || `git spawn failed while running "git ${args.join(' ')}".`;
  }
  if (classification.reason !== 'max-buffer') return text;

  const message = `git output exceeded the ${formatByteSize(maxBuffer)} capture limit while running "git ${args.join(' ')}"; narrow the requested git output and retry.`;
  return text.trim() ? `${message}\n${text}` : message;
}

function formatDurationMs(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? `${Math.trunc(duration)}ms` : 'the configured timeout';
}

function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 'configured';
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`;
  if (value % 1024 === 0) return `${value / 1024} KiB`;
  return `${value} bytes`;
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function getRepoRoot(cwd) {
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return root.ok ? root.stdout.trim() : '';
}

// Parse `git status --porcelain=v1 -z` output. Records are NUL-terminated and
// paths are emitted unquoted; for rename (R) and copy (C) entries Git emits the
// new path first and the original path as the next NUL record. CLI-owned local
// state is dropped so it does not appear dirty to the dirty-tree check or leak
// into prompt context. Returns a newline-joined string for downstream display.
/**
 * @param {string} status
 * @returns {string}
 */
export function filterCliStatus(status) {
  const records = String(status || '').split('\0');
  const kept = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (!PORCELAIN_LINE_RE.test(record)) {
      kept.push(record);
      continue;
    }
    const code = record[0];
    const newPath = record.slice(3);
    const isRenameOrCopy = code === 'R' || code === 'C';
    let originalPath = '';
    if (isRenameOrCopy && i + 1 < records.length) {
      originalPath = records[i + 1] || '';
      i += 1;
    }
    if (
      hasLocalStatePathSegment(newPath)
      || (isRenameOrCopy && hasLocalStatePathSegment(originalPath))
    ) {
      continue;
    }
    kept.push(isRenameOrCopy
      ? `${record.slice(0, 3)}${originalPath} -> ${newPath}`
      : record);
  }
  return kept.join('\n');
}

/**
 * @param {string} cwd
 * @param {{ changed?: boolean, diffMaxBuffer?: number }} [options]
 * @returns {Promise<RepoContext>}
 */
export async function collectRepoContext(cwd, { changed = false, diffMaxBuffer } = {}) {
  const scopeRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const detectedRootRaw = await getRepoRoot(cwd);
  const detectedRoot = detectedRootRaw
    ? await fs.realpath(detectedRootRaw).catch(() => path.resolve(detectedRootRaw))
    : '';
  const isGit = Boolean(detectedRoot);
  const status = await runGit(['status', '--porcelain=v1', '-z', '--', '.'], scopeRoot);
  const branch = await runGit(['branch', '--show-current'], scopeRoot);
  const head = await runGit(['rev-parse', '--short', 'HEAD'], scopeRoot);
  const stat = await runGit(changed ? ['diff', '--stat', 'HEAD', '--', '.'] : ['diff', '--stat', '--', '.'], scopeRoot);
  const diff = changed
    ? await runGit(['diff', 'HEAD', '--', '.'], scopeRoot, {
      timeoutMs: 30_000,
      ...(diffMaxBuffer ? { maxBuffer: diffMaxBuffer } : {}),
    })
    : { ok: true, stdout: '', stderr: '' };
  const diffError = changed && isGit && !diff.ok
    ? gitContextFailureMessage(diff)
    : '';

  return {
    isGit,
    repoRoot: scopeRoot,
    gitRoot: detectedRoot || '',
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    status: filterCliStatus(status.stdout).trim(),
    diffStat: stat.stdout.trim(),
    diff: diffError || diff.stdout.trim(),
    diffError,
  };
}

/** @param {{ stderr?: string, stdout?: string }} result */
function gitContextFailureMessage(result) {
  const detail = conciseErrorDetail(result?.stderr || result?.stdout || 'git diff failed');
  return `[commands-com: git diff capture failed: ${detail}]`;
}

function conciseErrorDetail(value, maxLength = 1000) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'git diff failed';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * @param {string} worktreePath
 * @param {string} [baseRef]
 * @returns {Promise<WorktreeDiffStatus>}
 */
export async function getWorktreeDiffStatus(worktreePath, baseRef = 'HEAD') {
  const stat = await runGit(['diff', '--stat', baseRef, '--', '.'], worktreePath);
  const status = await runGit(['status', '--short'], worktreePath);
  return {
    ok: Boolean(stat.ok && status.ok),
    hasChanges: Boolean(stat.stdout.trim() || status.stdout.trim()),
    diffStat: stat.stdout.trim(),
    status: status.stdout.trim(),
  };
}

/**
 * @param {PruneWorktreeWorkspace} workspace
 * @returns {Promise<PruneWorktreeResult>}
 */
export async function pruneIsolatedWorktree(workspace) {
  if (!workspace || workspace.mode !== WORKSPACE_MODES.WORKTREE) {
    return { ok: true, skipped: true, reason: 'not_worktree' };
  }
  const repoRoot = workspace.originalRepoRoot;
  const worktreePath = workspace.path || workspace.cwd;
  if (!repoRoot || !worktreePath) {
    return { ok: false, error: 'missing_worktree_metadata' };
  }
  const remove = await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot, { timeoutMs: 60_000 });
  if (!remove.ok) {
    return { ok: false, error: (remove.stderr || remove.stdout).trim() || 'worktree_remove_failed' };
  }
  if (workspace.branch) {
    await runGit(['branch', '-D', workspace.branch], repoRoot, { timeoutMs: 30_000 });
  }
  return { ok: true };
}

/**
 * @param {string} cwd
 * @param {{ kind?: string, label?: string, baseRef?: string }} [options]
 * @returns {Promise<IsolatedWorktree>}
 */
export async function createIsolatedWorktree(cwd, { kind = 'review', label = 'run', baseRef = 'HEAD' } = {}) {
  const repoRoot = await getRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error('--worktree requires a git repository');
  }

  const plan = buildWorktreePlan(repoRoot, kind, label);
  const originalStatus = await runGit(['status', '--short'], repoRoot);
  const base = await runGit(['rev-parse', '--verify', baseRef], repoRoot);
  if (!base.ok) {
    throw new Error(`could not resolve base ref '${baseRef}'`);
  }

  await fs.mkdir(path.dirname(plan.path), { recursive: true });
  const result = await runGit(['worktree', 'add', '-b', plan.branch, plan.path, baseRef], repoRoot, {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${(result.stderr || result.stdout).trim()}`);
  }

  return {
    ...plan,
    baseRef,
    baseSha: base.stdout.trim(),
    originalRepoRoot: repoRoot,
    originalStatus: originalStatus.stdout.trim(),
  };
}
