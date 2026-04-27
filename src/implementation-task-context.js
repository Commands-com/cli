import path from 'node:path';
import {
  captureGitPatch,
  repoRelativePathForContext,
  taskWorktreesAvailable,
} from './task-worktrees.js';

const TASK_WORKTREE_WORKSPACE_MODE = 'task-worktree';

/**
 * @typedef {import('./cycle-state.js').CycleProvider} CycleProvider
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./cycle-state.js').CycleLogger} CycleLogger
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 */

/**
 * Task worktree handle returned by `createTaskWorktree`. `managerCwd` is
 * the integration cwd used to manage this worktree (where
 * `git worktree remove` must be invoked from).
 *
 * @typedef {object} TaskWorktree
 * @property {string} path Absolute path to the task worktree root.
 * @property {number} attempt One-based attempt index this worktree was created for.
 * @property {string} baseRef Base ref the worktree was branched from.
 * @property {string} baseSha Resolved sha for `baseRef` at creation time.
 * @property {string} cwd Provider-facing cwd inside the worktree.
 * @property {string} managerCwd Integration cwd used to manage the worktree.
 */

/**
 * Baseline established inside a task worktree by
 * `prepareTaskWorktreeBaseline`.
 *
 * @typedef {object} TaskBaseline
 * @property {string} baselineRef Ref name (always `'HEAD'`) describing the baseline.
 * @property {string} baselineSha Sha of the baseline commit.
 * @property {boolean} [committed] Whether a baseline commit was created.
 */

/**
 * Patch capture result returned by `captureGitPatch`.
 *
 * @typedef {object} TaskPatchInfo
 * @property {boolean} ok Whether all underlying git invocations succeeded.
 * @property {string} patch Binary diff text (`git diff --binary`).
 * @property {string} diffStat Trimmed `git diff --stat` text.
 * @property {Array<string>} files Repo-relative paths of files in the diff.
 * @property {string} status Filtered porcelain status text.
 * @property {string} [error] Aggregated error text when `ok` is false.
 */

/**
 * Patch validation result returned by `validatePatchFiles` /
 * `validateTaskPatch`.
 *
 * @typedef {object} TaskPatchValidation
 * @property {boolean} ok Whether the patch passed validation.
 * @property {Array<string>} errors Per-violation error messages.
 */

/**
 * Result returned by `removeTaskWorktree`.
 *
 * @typedef {object} TaskWorktreeRemoval
 * @property {boolean} ok Whether the worktree was removed cleanly.
 * @property {string} [error] Error text when removal failed.
 */

/**
 * Implementation task descriptor produced by `parseImplementationPlan`.
 *
 * @typedef {object} ImplementationTask
 * @property {string} id Stable task id used in artifacts and logs.
 * @property {string} title Human-readable task title.
 * @property {Array<string>} files Assigned file scope (relative paths).
 * @property {string} [instructions] Task instructions for the implementer.
 * @property {number} [order] One-based execution order.
 */

/**
 * Per-attempt workspace descriptor used by implementer execution. `cwd`
 * is where the provider runs; `worktree`/`baseline` are present when
 * `useTaskWorktrees` is true. The descriptor produced by
 * `createAttemptWorkspaceDescriptor` always sets these properties (even
 * if their values are `undefined`/`null`), so they are typed as required
 * with broadened value types rather than as optional properties.
 *
 * @typedef {object} ImplementationTaskAttemptWorkspace
 * @property {string | undefined} cwd Provider cwd (scoped to repo-relative path).
 * @property {TaskWorktree | null} worktree Task worktree handle, when used.
 * @property {TaskBaseline} baseline Baseline established inside the worktree.
 * @property {string} [mode] Workspace mode marker (e.g. `'task-worktree'`).
 * @property {string} [originalRepoRoot] Original repo root, when running in an isolated worktree.
 */

/**
 * Provider/runtime fields read from the run context's `execution` slice.
 *
 * @typedef {object} ImplementationTaskExecution
 * @property {CycleProvider} [provider] Primary provider.
 * @property {Array<CycleProvider>} [fallbackProviders] Fallback providers.
 * @property {string} [model] Model override.
 * @property {number} [timeoutMs] Provider timeout.
 * @property {number} [retries] Transient-failure retry count.
 * @property {number} [retryDelayMs] Base delay between transient retries.
 * @property {CycleLogger} [logger] Command logger.
 * @property {string} [logPrefix] Optional log prefix.
 */

/**
 * Workspace fields read from the run context's `taskWorkspace` slice.
 *
 * @typedef {object} ImplementationTaskWorkspaceRecord
 * @property {CycleStore} store Artifact store for this run.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Repository context.
 * @property {ImplementationTaskAttemptWorkspace} [workspace] Active per-attempt workspace.
 */

/**
 * Assignment fields read from the run context's `assignment` slice.
 *
 * @typedef {object} ImplementationTaskAssignment
 * @property {string} [objective] Synthesized objective for the implementer prompt.
 * @property {string} [findings] Prior findings text.
 * @property {string} [testCommand] Optional validation command.
 */

/**
 * Frozen run context handed to implementer execution. Constructed by
 * `createImplementationTaskRunContext` and consumed by every helper in
 * the implementer cluster (artifacts, patch, attempt, merge).
 *
 * @typedef {object} ImplementationTaskRunContext
 * @property {ImplementationTaskExecution} execution Provider/runtime fields.
 * @property {ImplementationTaskWorkspaceRecord} taskWorkspace Workspace fields.
 * @property {ImplementationTaskAssignment} assignment Assignment fields.
 */

/**
 * @param {{
 *   execution?: ImplementationTaskExecution,
 *   taskWorkspace?: ImplementationTaskWorkspaceRecord,
 *   assignment?: ImplementationTaskAssignment,
 * }} [args]
 * @returns {ImplementationTaskRunContext}
 */
export function createImplementationTaskRunContext({
  execution,
  taskWorkspace,
  assignment,
} = {}) {
  return /** @type {ImplementationTaskRunContext} */ (Object.freeze({ execution, taskWorkspace, assignment }));
}

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @returns {ImplementationTaskExecution}
 */
export function implementationTaskExecution(taskRunContext) {
  return taskRunContext.execution;
}

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @returns {ImplementationTaskWorkspaceRecord}
 */
export function implementationTaskWorkspace(taskRunContext) {
  return taskRunContext.taskWorkspace;
}

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @returns {ImplementationTaskAssignment}
 */
export function implementationTaskAssignment(taskRunContext) {
  return taskRunContext.assignment;
}

export function shouldUseTaskWorktrees(taskRunContext) {
  const { context, workspace } = taskRunContext.taskWorkspace;
  if (!taskWorktreesAvailable(context)) return false;
  if (workspace?.mode === TASK_WORKTREE_WORKSPACE_MODE) return false;
  return true;
}

export function taskWorktreeRoot(taskRunContext) {
  const { context, workspace } = taskRunContext.taskWorkspace;
  return workspace?.originalRepoRoot || context.gitRoot || context.repoRoot;
}

export function taskWorkspaceRepoRelativePath(workspace) {
  const worktreeRoot = workspace?.worktree?.path;
  const scopedCwd = workspace?.cwd;
  if (!worktreeRoot || !scopedCwd) return '';
  const relative = path.relative(worktreeRoot, scopedCwd);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative;
}

export function implementationTaskPromptContext(context, workspace) {
  if (!workspace?.worktree) return context;
  const repoRoot = workspace.cwd || workspace.worktree.cwd || workspace.worktree.path || context.repoRoot;
  return { ...context, repoRoot, gitRoot: workspace.worktree.path || repoRoot };
}

async function captureIntegrationWorkspaceStatus(taskRunContext, { task, useTaskWorktrees, label }) {
  if (!useTaskWorktrees) return '';
  const { context } = taskRunContext.taskWorkspace;
  const patchInfo = await captureGitPatch(context.gitRoot || context.repoRoot, {
    baseRef: 'HEAD',
    includeUntracked: true,
    excludeCliState: true,
    repoRelativePath: repoRelativePathForContext(context),
  });
  if (!patchInfo.ok) {
    throw new Error(`implementer ${task.id} integration workspace ${label} status failed: ${patchInfo.error || 'git diff failed'}`);
  }
  return patchInfo.status;
}

function formatStatusChange(status) {
  return status ? status.split('\n').join('; ') : '(clean)';
}

export function captureIntegrationWorkspaceBeforeProvider(taskRunContext, { task, useTaskWorktrees }) {
  return captureIntegrationWorkspaceStatus(taskRunContext, { task, useTaskWorktrees, label: 'before provider' });
}

export async function assertIntegrationWorkspaceUnchanged(taskRunContext, { task, beforeStatus, useTaskWorktrees }) {
  if (!useTaskWorktrees) return;
  const afterStatus = await captureIntegrationWorkspaceStatus(taskRunContext, {
    task,
    useTaskWorktrees,
    label: 'after provider',
  });
  if (afterStatus !== beforeStatus) {
    throw new Error([
      `implementer ${task.id} changed the integration workspace outside its task worktree`,
      `before: ${formatStatusChange(beforeStatus)}`,
      `after: ${formatStatusChange(afterStatus)}`,
    ].join('; '));
  }
}
