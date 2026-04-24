import path from 'node:path';
import {
  captureGitPatch,
  repoRelativePathForContext,
  taskWorktreesAvailable,
} from './task-worktrees.js';

const TASK_WORKTREE_WORKSPACE_MODE = 'task-worktree';

export function createImplementationTaskRunContext({
  execution,
  taskWorkspace,
  assignment,
} = {}) {
  return Object.freeze({ execution, taskWorkspace, assignment });
}

export function implementationTaskExecution(taskRunContext) {
  return taskRunContext.execution;
}

export function implementationTaskWorkspace(taskRunContext) {
  return taskRunContext.taskWorkspace;
}

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
