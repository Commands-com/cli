import { writeJsonArtifact } from './implementation-task-artifacts.js';
import {
  implementationTaskWorkspace,
  taskWorkspaceRepoRelativePath,
} from './implementation-task-context.js';
import {
  captureGitPatch,
  validateTaskPatch,
} from './task-worktrees.js';

/**
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./implementation-task-context.js').ImplementationTask} ImplementationTask
 * @typedef {import('./implementation-task-context.js').ImplementationTaskRunContext} ImplementationTaskRunContext
 * @typedef {import('./implementation-task-context.js').ImplementationTaskAttemptWorkspace} ImplementationTaskAttemptWorkspace
 * @typedef {import('./implementation-task-context.js').TaskPatchInfo} TaskPatchInfo
 * @typedef {import('./implementation-task-context.js').TaskPatchValidation} TaskPatchValidation
 * @typedef {import('./implementation-task-artifacts.js').TaskArtifactPaths} TaskArtifactPaths
 */

/**
 * Result returned by `captureAndValidateTaskPatch`. The returned `task` may
 * be a repaired copy with additional `files` when the implementer
 * legitimately edited another in-repo file.
 *
 * @typedef {object} TaskPatchCapture
 * @property {ImplementationTask} task
 * @property {ImplementationTaskAttemptWorkspace} workspace
 * @property {TaskPatchInfo} patchInfo
 */

class TaskPatchValidationError extends Error {
  /**
   * @param {ImplementationTask} task
   * @param {TaskPatchValidation} validation
   * @param {TaskPatchInfo} patchInfo
   */
  constructor(task, validation, patchInfo) {
    super(`implementer ${task.id} patch validation failed: ${validation.errors.join('; ')}`);
    this.name = 'TaskPatchValidationError';
    this.validation = validation;
    this.patchInfo = patchInfo;
    this.unassignedFiles = validation.errors
      .map((error) => error.match(/ changed unassigned file: (.+)$/)?.[1] || '')
      .filter(Boolean);
  }
}

/** @returns {TaskPatchInfo} */
export function emptyPatchInfo() {
  return { ok: true, patch: '', diffStat: '', files: [], status: '' };
}

/**
 * @param {ImplementationTask} task
 * @param {unknown} error
 * @returns {ImplementationTask | null}
 */
function repairedTaskForPatchValidation(task, error) {
  if (!(error instanceof TaskPatchValidationError)) return null;
  if (error.unassignedFiles.length !== error.validation.errors.length) return null;
  // Intentional product behavior: the orchestrator's task `files` are an
  // ownership hint for parallelism, but a captured patch is the exact truth.
  // When the only violations are extra in-repo files, accept the useful work
  // and expand ownership instead of spending another implementer cycle. Mixed
  // validation errors still fail so outside-scope paths and CLI artifacts stay
  // blocked by `validateTaskPatch`.
  const files = [...new Set([...(task.files || []), ...error.unassignedFiles])];
  if (files.length === (task.files || []).length) return null;
  return { ...task, files };
}

/**
 * @param {CycleStore} store
 * @param {TaskArtifactPaths} artifacts
 * @param {TaskPatchInfo} patchInfo
 * @returns {Promise<void>}
 */
async function writeTaskPatchArtifacts(store, artifacts, patchInfo) {
  await store.write(artifacts.diff, patchInfo.patch);
  await store.write(artifacts.diffStat, patchInfo.diffStat ? `${patchInfo.diffStat}\n` : '');
  await writeJsonArtifact(store, artifacts.changedFiles, patchInfo.files);
}

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @param {{
 *   task: ImplementationTask,
 *   workspace: ImplementationTaskAttemptWorkspace,
 *   artifacts: TaskArtifactPaths,
 *   useTaskWorktrees: boolean,
 * }} args
 * @returns {Promise<TaskPatchCapture>}
 */
export async function captureAndValidateTaskPatch(taskRunContext, {
  task,
  workspace,
  artifacts,
  useTaskWorktrees,
}) {
  if (!useTaskWorktrees) return { task, workspace, patchInfo: emptyPatchInfo() };

  const { store } = implementationTaskWorkspace(taskRunContext);
  const patchInfo = await captureGitPatch(workspace.worktree?.path || workspace.cwd, {
    baseRef: workspace.baseline?.baselineRef || 'HEAD',
    includeUntracked: true,
    repoRelativePath: taskWorkspaceRepoRelativePath(workspace),
  });
  if (!patchInfo.ok) {
    throw new Error(`implementer ${task.id} diff capture failed: ${patchInfo.error || 'git diff failed'}`);
  }
  const validation = validateTaskPatch({ task, files: patchInfo.files });
  if (validation.ok) {
    await writeTaskPatchArtifacts(store, artifacts, patchInfo);
    return { task, workspace, patchInfo };
  }

  const validationError = new TaskPatchValidationError(task, validation, patchInfo);
  const repairedTask = repairedTaskForPatchValidation(task, validationError);
  if (!repairedTask) throw validationError;
  const repairedValidation = validateTaskPatch({ task: repairedTask, files: patchInfo.files });
  if (!repairedValidation.ok) throw new TaskPatchValidationError(task, repairedValidation, patchInfo);
  await writeTaskPatchArtifacts(store, artifacts, patchInfo);
  return { task: repairedTask, workspace, patchInfo };
}
