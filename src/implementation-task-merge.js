import {
  applyGitPatch,
  captureGitPatch,
  removeTaskWorktree,
  repoRelativePathForContext,
  validatePatchFiles,
  validateTaskPatch,
} from './task-worktrees.js';
import {
  taskArtifacts,
  writeTaskState,
} from './implementation-task-artifacts.js';
import {
  implementationTaskExecution,
  implementationTaskWorkspace,
} from './implementation-task-context.js';

export async function integrationPatchForBatch(taskRunContext, { useTaskWorktrees }) {
  if (!useTaskWorktrees) return { patch: '' };
  const { context } = implementationTaskWorkspace(taskRunContext);
  const patchInfo = await captureGitPatch(context.repoRoot, {
    baseRef: 'HEAD',
    includeUntracked: true,
    excludeCliState: true,
    repoRelativePath: repoRelativePathForContext(context),
  });
  if (!patchInfo.ok) {
    throw new Error(`could not capture integration patch: ${patchInfo.error || 'git diff failed'}`);
  }
  const validation = validatePatchFiles({
    label: 'integration patch',
    files: patchInfo.files,
  });
  if (!validation.ok) {
    throw new Error(`could not capture integration patch: ${validation.errors.join('; ')}`);
  }
  return patchInfo;
}

export async function applyImplementationPartialMergePolicy({
  taskRunContext,
  successes,
  useTaskWorktrees,
}) {
  const merged = [];
  const failures = [];
  let processed = 0;
  for (const result of successes) {
    processed += 1;
    try {
      merged.push(await mergeImplementationTask(taskRunContext, { result, useTaskWorktrees }));
    } catch (error) {
      failures.push(error);
      break;
    }
  }
  if (failures.length && useTaskWorktrees) {
    for (const result of successes.slice(processed)) {
      await removeTaskWorktree(result.worktree).catch(() => {});
    }
  }
  return { merged, failures };
}

async function mergeImplementationTask(taskRunContext, {
  result,
  useTaskWorktrees,
}) {
  if (!useTaskWorktrees) return result;

  const {
    store,
    cycle,
    context,
  } = implementationTaskWorkspace(taskRunContext);
  const { timeoutMs, logger } = implementationTaskExecution(taskRunContext);
  const artifacts = taskArtifacts(cycle, result.task);
  const validation = validateTaskPatch({ task: result.task, files: result.changedFiles });
  if (!validation.ok) {
    const error = new Error(`implementer ${result.task.id} merge validation failed: ${validation.errors.join('; ')}`);
    await store.write(
      artifacts.mergeLog,
      ['ok: false', 'validation:', validation.errors.join('\n')].join('\n'),
    );
    await writeTaskState(taskRunContext, {
      task: result.task,
      attempt: result.attempt,
      state: 'failed',
      worktree: result.worktree,
      baseline: result.baseline,
      patchInfo: { files: result.changedFiles, diffStat: result.diffStat },
      error,
    });
    throw error;
  }
  const applied = await applyGitPatch(context.gitRoot || context.repoRoot, result.patch, {
    threeWay: true,
    timeoutMs,
  });
  await store.write(
    artifacts.mergeLog,
    [
      `ok: ${applied.ok}`,
      `exitCode: ${applied.exitCode}`,
      applied.stdout ? ['', 'stdout:', applied.stdout].join('\n') : '',
      applied.stderr ? ['', 'stderr:', applied.stderr].join('\n') : '',
    ].filter(Boolean).join('\n'),
  );
  if (!applied.ok) {
    const error = new Error(`implementer ${result.task.id} merge-conflict: ${(applied.stderr || applied.stdout).trim()}`);
    await writeTaskState(taskRunContext, {
      task: result.task,
      attempt: result.attempt,
      state: 'merge-conflict',
      worktree: result.worktree,
      baseline: result.baseline,
      patchInfo: { files: result.changedFiles, diffStat: result.diffStat },
      error,
    });
    throw error;
  }

  const cleanup = await removeTaskWorktree(result.worktree);
  await writeTaskState(taskRunContext, {
    task: result.task,
    attempt: result.attempt,
    state: 'merged',
    worktree: result.worktree,
    baseline: result.baseline,
    patchInfo: { files: result.changedFiles, diffStat: result.diffStat },
    cleanup,
  });
  logger.info(`cycle ${cycle}: implementer ${result.task.id} merged`);

  return {
    task: result.task,
    provider: result.provider,
    text: result.text,
    attempt: result.attempt,
    worktree: result.worktree?.cwd || '',
    diffStat: result.diffStat,
    changedFiles: result.changedFiles,
    state: 'merged',
  };
}
