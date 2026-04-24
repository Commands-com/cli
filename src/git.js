import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasLocalStatePathSegment, localWorktreesPath } from './config.js';
import { slug, timestamp } from './run-id.js';
import { WORKSPACE_MODES } from './workflow-constants.js';

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

export async function getRepoRoot(cwd) {
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return root.ok ? root.stdout.trim() : '';
}

function splitStatusPathParts(statusPath) {
  const source = String(statusPath || '');
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && source.startsWith(' -> ', i)) {
      parts.push(source.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }

  parts.push(source.slice(start));
  return parts;
}

function unquoteGitPath(statusPathPart) {
  const trimmed = String(statusPathPart || '').trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;

  // Git porcelain uses C-style path quoting, including octal UTF-8 bytes.
  return decodeGitQuotedPath(trimmed.slice(1, -1));
}

const GIT_C_QUOTE_ESCAPES = Object.freeze({
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
});

function decodeGitQuotedPath(value) {
  const source = String(value ?? '');
  const chunks = [];
  let octalBytes = [];

  function flushOctalBytes() {
    if (!octalBytes.length) return;
    chunks.push(Buffer.from(octalBytes).toString('utf8'));
    octalBytes = [];
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '\\') {
      flushOctalBytes();
      chunks.push(ch);
      continue;
    }

    const escape = source[i + 1];
    if (escape === undefined) {
      flushOctalBytes();
      chunks.push(ch);
      continue;
    }

    if (/^[0-7]$/.test(escape)) {
      let digits = escape;
      let end = i + 2;
      while (end < source.length && digits.length < 3 && /^[0-7]$/.test(source[end])) {
        digits += source[end];
        end += 1;
      }
      octalBytes.push(Number.parseInt(digits, 8));
      i = end - 1;
      continue;
    }

    flushOctalBytes();
    if (Object.hasOwn(GIT_C_QUOTE_ESCAPES, escape)) {
      chunks.push(GIT_C_QUOTE_ESCAPES[escape]);
    } else {
      chunks.push(`\\${escape}`);
    }
    i += 1;
  }

  flushOctalBytes();
  return chunks.join('');
}

function parseGitStatusPathParts(statusPath) {
  return splitStatusPathParts(statusPath).map((part) => unquoteGitPath(part));
}

function isCliStatePath(statusPath) {
  return parseGitStatusPathParts(statusPath)
    .some((part) => hasLocalStatePathSegment(part));
}

function statusPathFromPorcelainLine(line) {
  const source = String(line || '');
  if (!source.trim()) return '';
  // Only parse `git status --short` / porcelain v1 lines: `XY path`.
  // Scored copy/rename lines such as `R100 old -> new` are produced by other
  // git commands and are intentionally outside this helper's contract.
  if (/^[ MADRCUT?!][ MADRCUT?!] /.test(source)) return source.slice(3);
  return '';
}

// CLI-owned local state should not appear dirty to the dirty-tree check or leak
// into prompt context.
export function filterCliStatus(status) {
  return String(status || '')
    .split('\n')
    .filter((line) => {
      return !isCliStatePath(statusPathFromPorcelainLine(line));
    })
    .join('\n');
}

/**
 * @param {string} cwd
 * @param {{ changed?: boolean, diffMaxBuffer?: number }} [options]
 */
export async function collectRepoContext(cwd, { changed = false, diffMaxBuffer } = {}) {
  const scopeRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const detectedRootRaw = await getRepoRoot(cwd);
  const detectedRoot = detectedRootRaw
    ? await fs.realpath(detectedRootRaw).catch(() => path.resolve(detectedRootRaw))
    : '';
  const isGit = Boolean(detectedRoot);
  const status = await runGit(['status', '--short', '--', '.'], scopeRoot);
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

function gitContextFailureMessage(result) {
  const detail = conciseErrorDetail(result?.stderr || result?.stdout || 'git diff failed');
  return `[commands-com: git diff capture failed: ${detail}]`;
}

function conciseErrorDetail(value, maxLength = 1000) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'git diff failed';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

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
