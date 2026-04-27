import { buildImplementationTaskPrompt } from './implementation-prompts.js';
import { isTransientProviderError } from './providers.js';
import { normalizeFiniteNonNegativeNumber } from './number-utils.js';
import { providerFallbackChain, runWithProviderFallback } from './provider-fallback.js';
import {
  createProviderItemRunArtifacts,
  runProviderItem,
} from './provider-item-workflow.js';
import {
  taskArtifacts,
  taskFailureErrorArtifacts,
  taskResultPayload,
  writeTaskErrorArtifacts,
  writeTaskState,
} from './implementation-task-artifacts.js';
import {
  captureAndValidateTaskPatch,
  emptyPatchInfo,
} from './implementation-task-patch.js';
import { formatFailureMessage } from './errors.js';
import {
  implementationTaskAssignment,
  implementationTaskExecution,
  implementationTaskWorkspace,
  assertIntegrationWorkspaceUnchanged,
  captureIntegrationWorkspaceBeforeProvider,
  implementationTaskPromptContext,
  taskWorktreeRoot,
} from './implementation-task-context.js';
import { isObjectRecord } from './objects.js';
import {
  createTaskWorktree,
  prepareTaskWorktreeBaseline,
} from './task-worktrees.js';

class ImplementationTaskAttemptError extends Error {
  /**
   * @param {unknown} error
   * @param {{ workspace?: { cwd?: string, worktree?: any, baseline?: any } }} [options]
   */
  constructor(error, { workspace } = {}) {
    super(formatFailureMessage(error), { cause: error });
    this.name = 'ImplementationTaskAttemptError';
    this.originalError = error;
    this.metadata = {
      workspace: createAttemptWorkspaceDescriptor({
        cwd: workspace?.cwd,
        worktree: workspace?.worktree,
        baseline: workspace?.baseline,
      }),
    };
  }
}

function decorateImplementationTaskAttemptError(error, workspace = {}) {
  if (error instanceof ImplementationTaskAttemptError) return error;
  return new ImplementationTaskAttemptError(error, { workspace });
}

function implementationTaskAttemptErrorDetails(error) {
  if (error instanceof ImplementationTaskAttemptError) {
    return {
      error: error.originalError,
      workspace: createAttemptWorkspaceDescriptor(error.metadata?.workspace),
    };
  }
  return {
    error,
    workspace: createAttemptWorkspaceDescriptor(),
  };
}

function initialTaskBaseline() {
  return { baselineRef: 'HEAD', baselineSha: '' };
}

function createAttemptBaselineDescriptor(baseline) {
  const baselineRecord = isObjectRecord(baseline) ? baseline : {};
  return {
    ...baselineRecord,
    baselineRef: baselineRecord.baselineRef ?? 'HEAD',
    baselineSha: baselineRecord.baselineSha ?? '',
  };
}

function createAttemptWorkspaceDescriptor(workspace = {}) {
  const {
    cwd,
    worktree = null,
    baseline,
  } = isObjectRecord(workspace) ? workspace : {};
  const normalizedWorktree = worktree || null;
  return {
    cwd: cwd ?? normalizedWorktree?.cwd ?? normalizedWorktree?.path,
    worktree: normalizedWorktree,
    baseline: createAttemptBaselineDescriptor(baseline || initialTaskBaseline()),
  };
}

function createInitialAttemptWorkspace(taskRunContext) {
  const { context } = implementationTaskWorkspace(taskRunContext);
  return createAttemptWorkspaceDescriptor({
    cwd: context.repoRoot,
  });
}

async function setupTaskAttemptWorkspace(taskRunContext, {
  task,
  attempt,
  integrationPatch,
  useTaskWorktrees,
  artifacts,
  workspace,
  writeAttemptStatus,
}) {
  if (!useTaskWorktrees) return workspace;

  const { store, cycle, context } = implementationTaskWorkspace(taskRunContext);
  const worktree = await createTaskWorktree({
    integrationCwd: context.gitRoot || context.repoRoot,
    context,
    taskRoot: taskWorktreeRoot(taskRunContext),
    runId: store.runId,
    cycle,
    taskId: task.id,
    attempt,
  });
  const worktreeWorkspace = createAttemptWorkspaceDescriptor({
    cwd: worktree.cwd,
    worktree,
    baseline: workspace.baseline,
  });
  await store.write(artifacts.worktree, `${worktree.cwd}\n`);
  const preparedWorkspace = createAttemptWorkspaceDescriptor({
    ...worktreeWorkspace,
    baseline: await prepareTaskWorktreeBaseline(worktree, integrationPatch),
  });
  await writeTaskState(taskRunContext, {
    task,
    attempt,
    state: 'running',
    workspace: preparedWorkspace,
    writeAttemptStatus,
  });
  return preparedWorkspace;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(retryDelayMs, retryNumber) {
  const baseDelay = normalizeFiniteNonNegativeNumber(retryDelayMs ?? 750);
  return baseDelay * retryNumber;
}

async function invokeImplementationTaskProvider(taskRunContext, {
  task,
  attempt,
  workspace,
  artifacts,
}) {
  const { provider, fallbackProviders, model, timeoutMs, logger } = implementationTaskExecution(taskRunContext);
  const { store, context, cycle } = implementationTaskWorkspace(taskRunContext);
  const { objective, findings, testCommand } = implementationTaskAssignment(taskRunContext);
  const promptContext = implementationTaskPromptContext(context, workspace);
  const prompt = buildImplementationTaskPrompt({ objective, task, findings, context: promptContext, testCommand });
  return runWithProviderFallback({
    providerChain: providerFallbackChain(provider, fallbackProviders),
    runForProvider: async (taskProvider) => {
      const taskArtifact = createProviderItemRunArtifacts({
        store,
        promptPath: artifacts.prompt,
        outputPath: artifacts.output,
      });
      const providerResult = await runProviderItem({
        provider: taskProvider,
        label: task.id,
        prompt,
        artifacts: taskArtifact,
        cwd: workspace.cwd,
        model,
        timeoutMs,
        logger,
        execution: { allowTools: true },
        retry: { retries: 0 },
        artifactPolicy: {
          writeFailure: async ({ error }) => {
            await writeTaskErrorArtifacts(
              store,
              [artifacts.attempts(attempt, 'error')],
              error,
            );
          },
        },
      });
      return { workspace, ...providerResult };
    },
    onFallback: ({ from, to }) => {
      logger.info(`cycle ${cycle}: implementer ${task.id} fallback ${from.id} -> ${to.id}`);
    },
  });
}

async function recordTaskAttemptSuccess(taskRunContext, {
  task,
  attempt,
  text,
  workspace,
  patchInfo,
  writeAttemptStatus,
}) {
  const { cycle } = implementationTaskWorkspace(taskRunContext);
  const { logger } = implementationTaskExecution(taskRunContext);
  await writeTaskState(taskRunContext, {
    task,
    attempt,
    state: 'succeeded',
    workspace,
    patchInfo,
    writeAttemptStatus,
  });
  logger.info(`cycle ${cycle}: implementer ${task.id} succeeded`);

  return taskResultPayload({
    taskRunContext,
    task,
    text,
    attempt,
    worktree: workspace.worktree,
    baseline: workspace.baseline,
    patchInfo,
  });
}

export async function runImplementationTask(taskRunContext, {
  task,
  integrationPatch,
  useTaskWorktrees,
}) {
  const {
    provider,
    retries,
    retryDelayMs,
    logger,
  } = implementationTaskExecution(taskRunContext);
  const { store, cycle } = implementationTaskWorkspace(taskRunContext);
  const maxRetries = normalizeFiniteNonNegativeNumber(retries);
  let transientRetries = 0;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return await runImplementationTaskAttempt(taskRunContext, {
        task,
        attempt,
        integrationPatch,
        useTaskWorktrees,
        writeAttemptStatus: attempt > 1,
      });
    } catch (error) {
      lastError = error;
      const retryNumber = attempt;
      const { error: originalError, workspace } = implementationTaskAttemptErrorDetails(error);
      const canRetry = transientRetries < maxRetries && isTransientProviderError(originalError);
      if (!canRetry) {
        await recordImplementationTaskFailure(taskRunContext, {
          task,
          attempt,
          error,
          writeAttemptStatus: attempt > 1,
        });
        throw error;
      }

      await writeTaskErrorArtifacts(
        store,
        [taskArtifacts(cycle, task).attempts(retryNumber, 'error')],
        originalError,
      );
      transientRetries += 1;
      await writeTaskState(taskRunContext, {
        task,
        attempt,
        state: 'retrying',
        workspace,
        error: originalError,
        writeAttemptStatus: true,
      });
      logger.info(
        `cycle ${cycle}: implementer ${task.id} retry ${retryNumber}/${maxRetries} after transient ${provider.id} failure`,
      );
      const delayMs = retryDelay(retryDelayMs, retryNumber);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}

async function runImplementationTaskAttempt(taskRunContext, {
  task,
  attempt,
  integrationPatch,
  useTaskWorktrees,
  writeAttemptStatus = false,
}) {
  const { cycle } = implementationTaskWorkspace(taskRunContext);
  const { logger } = implementationTaskExecution(taskRunContext);
  const artifacts = taskArtifacts(cycle, task);
  let workspace = createInitialAttemptWorkspace(taskRunContext);

  try {
    logger.info(`cycle ${cycle}: implementer ${task.id}: ${task.title}`);
    await writeTaskState(taskRunContext, {
      task,
      attempt,
      state: 'running',
      workspace,
      writeAttemptStatus,
    });
    workspace = await setupTaskAttemptWorkspace(taskRunContext, {
      task,
      attempt,
      integrationPatch,
      useTaskWorktrees,
      artifacts,
      workspace,
      writeAttemptStatus,
    });
    const integrationStatusBefore = await captureIntegrationWorkspaceBeforeProvider(
      taskRunContext,
      { task, useTaskWorktrees },
    );
    const { result } = await invokeImplementationTaskProvider(taskRunContext, {
      task,
      attempt,
      workspace,
      artifacts,
    });
    await assertIntegrationWorkspaceUnchanged(taskRunContext, {
      task,
      beforeStatus: integrationStatusBefore,
      useTaskWorktrees,
    });
    const patchCapture = await captureAndValidateTaskPatch(taskRunContext, {
      task,
      workspace,
      artifacts,
      useTaskWorktrees,
    });
    workspace = patchCapture.workspace;
    return recordTaskAttemptSuccess(taskRunContext, {
      task: patchCapture.task,
      text: result.text,
      attempt,
      workspace,
      patchInfo: patchCapture.patchInfo,
      writeAttemptStatus,
    });
  } catch (error) {
    throw decorateImplementationTaskAttemptError(error, workspace);
  }
}

async function recordImplementationTaskFailure(taskRunContext, {
  task,
  attempt,
  error,
  writeAttemptStatus = false,
}) {
  const { store, cycle } = implementationTaskWorkspace(taskRunContext);
  const { error: originalError, workspace } = implementationTaskAttemptErrorDetails(error);
  await writeTaskErrorArtifacts(store, taskFailureErrorArtifacts(cycle, task), originalError);
  await writeTaskState(taskRunContext, {
    task,
    attempt,
    state: 'failed',
    workspace,
    error: originalError,
    writeAttemptStatus,
  });
}
