import path from 'node:path';
import { filterCliStatus, getWorktreeDiffStatus, pruneIsolatedWorktree } from './git.js';
import { DEFAULT_TIMEOUT_MS, SHELL_OUTPUT_CAP_BYTES } from './provider-limits.js';
import { runProcess } from './process-runner.js';
import { WORKSPACE_MODES } from './workflow-constants.js';

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

export function shouldBlockUnsafeFix({ fix, worktree, allowDirty, status }) {
  return Boolean(fix && !worktree && !allowDirty && filterCliStatus(status).trim());
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

export function scopedWorktreeCwd(originalContext, isolated) {
  if (!originalContext.gitRoot) return isolated.path;
  const relative = path.relative(originalContext.gitRoot, originalContext.repoRoot);
  return isSafeScopedRelativePath(relative) ? path.join(isolated.path, relative) : isolated.path;
}

function skippedWorktreePrune(reason) {
  return { ok: false, skipped: true, reason };
}

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

export async function finalizeWorktree(workspace, { keepWorktree }) {
  if (workspace.mode !== WORKSPACE_MODES.WORKTREE) return workspace;
  const diffStatus = await getWorktreeDiffStatus(workspace.cwd, workspace.baseSha || workspace.baseRef || 'HEAD');
  workspace.diffStatus = diffStatus;
  const pruneDecision = resolveWorktreePruneDecision({ keepWorktree, diffStatus });
  if (pruneDecision.shouldPrune) {
    workspace.prune = await pruneIsolatedWorktree(workspace);
  } else {
    workspace.prune = pruneDecision.prune;
  }
  return workspace;
}
