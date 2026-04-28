import path from 'node:path';
import { getWorktreeDiffStatus, pruneIsolatedWorktree } from './git.js';
import { DEFAULT_TIMEOUT_MS, SHELL_OUTPUT_CAP_BYTES } from './provider-limits.js';
import { runProcess } from './process-runner.js';
import { WORKSPACE_MODES } from './workflow-constants.js';

/**
 * @typedef {import('./git.js').WorktreeDiffStatus} WorktreeDiffStatus
 * @typedef {import('./git.js').PruneWorktreeResult} PruneWorktreeResult
 * @typedef {import('./git.js').RepoContext} RepoContext
 * @typedef {import('./git.js').IsolatedWorktree} IsolatedWorktree
 */

/**
 * Validation/test-command shell invocation result returned by `runShell`.
 *
 * @typedef {Object} ShellResult
 * @property {boolean} ok Whether the command exited 0 without error.
 * @property {number} exitCode Numeric exit code (124 on timeout).
 * @property {string} stdout Captured stdout.
 * @property {string} stderr Captured stderr.
 */

/**
 * Decision returned by `resolveWorktreePruneDecision`. When `shouldPrune` is
 * `false`, `prune` carries the skipped result that callers can record verbatim;
 * when `true`, the caller invokes `pruneIsolatedWorktree` and stores its result.
 *
 * @typedef {Object} WorktreePruneDecision
 * @property {boolean} shouldPrune Whether the worktree should be pruned.
 * @property {PruneWorktreeResult} [prune] Skip result when `shouldPrune` is false.
 */

/**
 * Workspace handed to `finalizeWorktree` — extends `IsolatedWorktree` with
 * mutation slots for the diff status snapshot and the prune outcome.
 *
 * @typedef {Object} FinalizeWorkspace
 * @property {string} mode Workspace mode.
 * @property {string} cwd Working directory used by validation.
 * @property {string} [path] Worktree path.
 * @property {string} [branch] Worktree branch.
 * @property {string} [baseRef] Base ref used to compute pending diff.
 * @property {string} [baseSha] Base sha used to compute pending diff.
 * @property {string} [originalRepoRoot] Original repo root.
 * @property {string} [originalStatus] Original repo status snapshot.
 * @property {WorktreeDiffStatus} [diffStatus] Diff status snapshot recorded after finalize.
 * @property {PruneWorktreeResult} [prune] Prune outcome recorded after finalize.
 */

/**
 * @param {string} command
 * @param {string} cwd
 * @param {{ timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<ShellResult>}
 */
export async function runShell(command, cwd, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = SHELL_OUTPUT_CAP_BYTES,
} = {}) {
  const result = await runProcess({
    command,
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs,
    maxOutputBytes,
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * @param {string} command
 * @param {ShellResult} result
 * @returns {string}
 */
export function summarizeTestFailure(command, result) {
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  return [
    '## Validation failure',
    '',
    `Command failed: \`${command}\``,
    `Exit code: ${result.exitCode}`,
    stdout ? ['', 'Stdout excerpt:', stdout.slice(0, 4_000)].join('\n') : '',
    stderr ? ['', 'Stderr excerpt:', stderr.slice(0, 4_000)].join('\n') : '',
  ].filter(Boolean).join('\n');
}

// Callers must run `status` through `filterCliStatus` (see ./git.js) first; this helper treats any non-empty status as dirty.
/**
 * @param {{ fix?: boolean, worktree?: boolean, allowDirty?: boolean, status?: string }} args
 * @returns {boolean}
 */
export function shouldBlockUnsafeFix({ fix, worktree, allowDirty, status }) {
  return Boolean(fix && !worktree && !allowDirty && String(status || '').trim());
}

function isSafeScopedRelativePath(relative) {
  return Boolean(
    relative
      && relative !== '.'
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
  );
}

/**
 * @param {RepoContext} originalContext
 * @param {IsolatedWorktree} isolated
 * @returns {string}
 */
export function scopedWorktreeCwd(originalContext, isolated) {
  if (!originalContext.gitRoot) return isolated.path;
  const relative = path.relative(originalContext.gitRoot, originalContext.repoRoot);
  return isSafeScopedRelativePath(relative) ? path.join(isolated.path, relative) : isolated.path;
}

/**
 * @param {string} reason
 * @returns {PruneWorktreeResult}
 */
function skippedWorktreePrune(reason) {
  return { ok: false, skipped: true, reason };
}

/**
 * Decide whether the isolated worktree should be pruned at finalize time.
 *
 * Skip reasons:
 *   - `keep_worktree` — explicit user opt-out via `--keep-worktree`.
 *   - `diff_status_failed` — defensive skip when we cannot trust the diff
 *     snapshot (e.g. git invocation failure); we never prune a worktree we
 *     cannot prove is clean.
 *   - `worktree_has_changes` — the worktree has uncommitted modifications
 *     relative to its base ref. This is the **post-fix happy path**, not an
 *     error: after a successful `--fix` cycle the implementer leaves edits on
 *     disk for the user to inspect / commit. Prune is skipped so the user
 *     does not lose work. Callers that want the user to understand the
 *     surviving worktree should pair this skip reason with a user-facing
 *     notice (see `finalizeWorktree`).
 *
 * `shouldPrune: true` is only returned when the worktree is provably clean
 * against its base ref.
 *
 * @param {{ keepWorktree?: boolean, diffStatus?: WorktreeDiffStatus }} args
 * @returns {WorktreePruneDecision}
 */
function resolveWorktreePruneDecision({ keepWorktree, diffStatus }) {
  if (keepWorktree) {
    return { shouldPrune: false, prune: skippedWorktreePrune('keep_worktree') };
  }
  if (!diffStatus?.ok) {
    return { shouldPrune: false, prune: skippedWorktreePrune('diff_status_failed') };
  }
  if (diffStatus.hasChanges) {
    return { shouldPrune: false, prune: skippedWorktreePrune('worktree_has_changes') };
  }
  return { shouldPrune: true };
}

/**
 * @param {FinalizeWorkspace} workspace
 * @param {{ keepWorktree?: boolean, logger?: import('./cycle-state.js').CycleLogger }} options
 * @returns {Promise<FinalizeWorkspace>}
 */
export async function finalizeWorktree(workspace, { keepWorktree, logger } = {}) {
  if (workspace.mode !== WORKSPACE_MODES.WORKTREE) return workspace;
  const diffStatus = await getWorktreeDiffStatus(workspace.cwd, workspace.baseSha || workspace.baseRef || 'HEAD');
  workspace.diffStatus = diffStatus;
  const pruneDecision = resolveWorktreePruneDecision({ keepWorktree, diffStatus });
  if (pruneDecision.shouldPrune) {
    workspace.prune = await pruneIsolatedWorktree(workspace);
  } else {
    workspace.prune = pruneDecision.prune;
    if (
      !keepWorktree
      && pruneDecision.prune?.reason === 'worktree_has_changes'
      && typeof logger?.info === 'function'
    ) {
      const worktreePath = workspace.path || workspace.cwd;
      logger.info(`worktree retained (uncommitted changes detected): ${worktreePath}`);
    }
  }
  return workspace;
}
