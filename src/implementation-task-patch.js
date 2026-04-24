import { writeJsonArtifact } from './implementation-task-artifacts.js';
import {
  implementationTaskWorkspace,
  taskWorkspaceRepoRelativePath,
} from './implementation-task-context.js';
import {
  captureGitPatch,
  validateTaskPatch,
} from './task-worktrees.js';

class TaskPatchValidationError extends Error {
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

export function emptyPatchInfo() {
  return { patch: '', diffStat: '', files: [], status: '' };
}

function repairedTaskForPatchValidation(task, error) {
  if (!(error instanceof TaskPatchValidationError)) return null;
  if (error.unassignedFiles.length !== error.validation.errors.length) return null;
  const files = [...new Set([...(task.files || []), ...error.unassignedFiles])];
  if (files.length === (task.files || []).length) return null;
  return { ...task, files };
}

async function writeTaskPatchArtifacts(store, artifacts, patchInfo) {
  await store.write(artifacts.diff, patchInfo.patch);
  await store.write(artifacts.diffStat, patchInfo.diffStat ? `${patchInfo.diffStat}\n` : '');
  await writeJsonArtifact(store, artifacts.changedFiles, patchInfo.files);
}

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
