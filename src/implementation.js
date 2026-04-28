import {
  cycleArtifactPath,
  cycleMarkdownArtifactPath,
  cyclePromptArtifactPath,
} from './artifact-paths.js';
import { buildImplementationPlanPrompt } from './implementation-prompts.js';
import { writeJsonArtifact } from './implementation-task-artifacts.js';
import { combineErrors, formatFailureMessage } from './errors.js';
import { runImplementationTask } from './implementation-task-attempt.js';
import {
  createImplementationTaskRunContext,
  implementationTaskExecution,
  implementationTaskWorkspace,
  shouldUseTaskWorktrees,
} from './implementation-task-context.js';
import {
  applyImplementationPartialMergePolicy,
  integrationPatchForBatch,
} from './implementation-task-merge.js';
import {
  buildImplementationBatches,
  parseImplementationPlan,
} from './task-plan-parsing.js';
import {
  createProviderItemRunArtifacts,
  runProviderItem,
} from './provider-item-workflow.js';
import { providerFallbackChain, runWithProviderFallback } from './provider-fallback.js';

/** @type {{ info(message?: string): void, warn(message?: string): void }} */
const SILENT_LOGGER = Object.freeze({ info() {}, warn() {} });

const IMPLEMENTATION_EXECUTION_MODES = Object.freeze({
  PARALLEL_WORKTREES: 'parallel-worktrees',
  PARALLEL_UNSCOPED: 'parallel-unscoped',
  SERIAL_DIRECT: 'serial-direct',
  SERIAL: 'serial',
});
export const IMPLEMENTATION_PHASE_STATUS = Object.freeze({ COMPLETED: 'completed', PARTIAL: 'partial' });
const IMPLEMENTATION_BATCH_STATUS = Object.freeze({ COMPLETED: 'completed', FAILED: 'failed' });

function formatImplementationResults(implementations) {
  if (!implementations.length) return 'No implementation tasks were returned.';
  return implementations
    .map((implementation) => `## ${implementation.task.id}: ${implementation.task.title}\n\n${implementation.text}`)
    .join('\n\n');
}

function createImplementationResult({ plan, tasks, batches, implementations }) {
  return {
    plan,
    tasks,
    batches: batches.map((batch) => batch.map((task) => task.id)),
    implementations,
    text: formatImplementationResults(implementations),
  };
}

async function writeImplementationResultArtifact(store, cycle, result) {
  await store.write(cycleMarkdownArtifactPath(cycle, 'implementation'), result.text);
  return result;
}

async function flushImplementationResult({ store, cycle, plan, tasks, batches, implementations }) {
  return writeImplementationResultArtifact(store, cycle, createImplementationResult({
    plan,
    tasks,
    batches,
    implementations,
  }));
}

function implementationExecutionMode({ requestedParallel, useTaskWorktrees, workspace }) {
  if (requestedParallel && useTaskWorktrees) return IMPLEMENTATION_EXECUTION_MODES.PARALLEL_WORKTREES;
  if (requestedParallel && isDirectWorkspace(workspace)) return IMPLEMENTATION_EXECUTION_MODES.SERIAL_DIRECT;
  if (requestedParallel) return IMPLEMENTATION_EXECUTION_MODES.PARALLEL_UNSCOPED;
  return IMPLEMENTATION_EXECUTION_MODES.SERIAL;
}

function isDirectWorkspace(workspace) {
  return workspace?.mode === 'current'
    || (!workspace?.mode && typeof workspace?.cwd === 'string');
}

function usesParallelBatchShape(mode) {
  return mode === IMPLEMENTATION_EXECUTION_MODES.PARALLEL_WORKTREES
    || mode === IMPLEMENTATION_EXECUTION_MODES.PARALLEL_UNSCOPED
    || mode === IMPLEMENTATION_EXECUTION_MODES.SERIAL_DIRECT;
}

async function runBatchJobs(jobs, { mode, run }) {
  if (
    mode === IMPLEMENTATION_EXECUTION_MODES.PARALLEL_WORKTREES
    || mode === IMPLEMENTATION_EXECUTION_MODES.PARALLEL_UNSCOPED
  ) {
    return Promise.allSettled(jobs.map((job) => run(job)));
  }

  const settled = [];
  for (const job of jobs) {
    try {
      settled.push({ status: 'fulfilled', value: await run(job) });
    } catch (error) {
      settled.push({ status: 'rejected', reason: error });
      break;
    }
  }
  return settled;
}

async function runImplementationBatch({
  taskRunContext,
  batch,
  batchIndex,
  batchCount,
  mode,
  useTaskWorktrees,
}) {
  if (!taskRunContext) {
    throw new Error('runImplementationBatch requires taskRunContext');
  }

  const { cycle } = implementationTaskWorkspace(taskRunContext);
  const { logger, logPrefix } = implementationTaskExecution(taskRunContext);
  logger.info(`cycle ${cycle}: implementers batch ${batchIndex + 1}/${batchCount} (${batch.length} task(s))`);
  const integrationPatch = await integrationPatchForBatch(taskRunContext, { useTaskWorktrees });
  const settled = await runBatchJobs(batch, {
    mode,
    run: (task) => runImplementationTask(taskRunContext, {
      task,
      integrationPatch: integrationPatch.patch,
      useTaskWorktrees,
    }),
  });

  const successes = [];
  const failures = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') successes.push(item.value);
    else failures.push(item.reason);
  }

  const mergePolicyResult = await applyImplementationPartialMergePolicy({
    taskRunContext,
    successes,
    useTaskWorktrees,
  });
  failures.push(...mergePolicyResult.failures);

  if (failures.length) {
    return {
      status: IMPLEMENTATION_BATCH_STATUS.FAILED,
      implementations: mergePolicyResult.merged,
      error: new Error(`${logPrefix} implementation batch ${batchIndex + 1} failed: ${failures.map(formatFailureMessage).join('; ')}`),
    };
  }
  return {
    status: IMPLEMENTATION_BATCH_STATUS.COMPLETED,
    implementations: mergePolicyResult.merged,
  };
}

/**
 * @param {{
 *   execution: {
 *     provider: any,
 *     providers?: Array<any>,
 *     model?: string,
 *     timeoutMs: any,
 *     retries?: number,
 *     retryDelayMs?: any,
 *     logger?: { info(message?: string): void },
 *     logPrefix?: string,
 *   },
 *   taskWorkspace: { store: any, cycle: any, context: any, workspace?: any },
 *   assignment: { objective: any, findings: any, testCommand?: string },
 *   orchestration?: { maxImplementers?: number, parallel?: boolean },
 * }} args
 */
export async function runOrchestratedImplementationPhase({
  execution,
  taskWorkspace,
  assignment,
  orchestration = {},
}) {
  const {
    provider,
    providers = [],
    model = '',
    timeoutMs,
    retries = 1,
    retryDelayMs,
    logger = SILENT_LOGGER,
    logPrefix = 'review',
  } = execution;
  const { store, cycle, context, workspace } = taskWorkspace;
  const { objective, findings, testCommand = '' } = assignment;
  const { maxImplementers = 6, parallel = true } = orchestration;

  const output = logger;
  const maxTasks = Math.max(1, maxImplementers);
  const planPrompt = buildImplementationPlanPrompt({ objective, findings, context, testCommand, maxTasks });
  const { planResult, planProvider } = await runImplementationPlanWithFallback({
    provider,
    providers,
    store,
    cycle,
    planPrompt,
    context,
    model,
    timeoutMs,
    retries,
    retryDelayMs,
    logger: output,
  });

  const tasks = parseImplementationPlan(planResult.text, { maxTasks, fallbackInstructions: findings });
  const taskRunContext = createImplementationTaskRunContext({
    execution: {
      provider: planProvider,
      fallbackProviders: providerFallbackChain(planProvider, providers),
      model,
      timeoutMs,
      retries,
      retryDelayMs,
      logger: output,
      logPrefix,
    },
    taskWorkspace: {
      store,
      cycle,
      context,
      workspace,
    },
    assignment: {
      objective,
      findings,
      testCommand,
    },
  });
  const useTaskWorktrees = shouldUseTaskWorktrees(taskRunContext);
  const executionMode = implementationExecutionMode({
    requestedParallel: parallel,
    useTaskWorktrees,
    workspace,
  });
  const batches = buildImplementationBatches(tasks, {
    maxParallel: maxTasks,
    parallel: usesParallelBatchShape(executionMode),
  });
  await writeJsonArtifact(store, cycleArtifactPath(cycle, 'tasks.json'), tasks);
  output.info(`cycle ${cycle}: implementation plan (${tasks.length} task(s), ${batches.length} batch(es), cap ${maxTasks})`);
  if (tasks.length === 0) {
    output.info(`cycle ${cycle}: no actionable implementation tasks`);
  } else if (useTaskWorktrees) {
    output.info(`cycle ${cycle}: task worktrees (${tasks.length})`);
  } else if (executionMode === IMPLEMENTATION_EXECUTION_MODES.SERIAL_DIRECT && tasks.length > 1) {
    output.info(`cycle ${cycle}: task worktrees unavailable; running implementers serially in direct workspace`);
  }

  const implementations = [];
  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batchResult = await runImplementationBatch({
        taskRunContext,
        batch: batches[batchIndex],
        batchIndex,
        batchCount: batches.length,
        mode: executionMode,
        useTaskWorktrees,
      });
      implementations.push(...batchResult.implementations);
      if (batchResult.status === IMPLEMENTATION_BATCH_STATUS.FAILED) {
        return partialImplementationPhase({
          store,
          cycle,
          plan: planResult.text,
          tasks,
          batches,
          implementations,
          error: batchResult.error,
        });
      }
    }
  } catch (error) {
    if (implementations.length > 0) {
      return partialImplementationPhase({
        store,
        cycle,
        plan: planResult.text,
        tasks,
        batches,
        implementations,
        error,
      });
    }
    throw error;
  }

  return {
    status: IMPLEMENTATION_PHASE_STATUS.COMPLETED,
    result: await flushImplementationResult({
      store,
      cycle,
      plan: planResult.text,
      tasks,
      batches,
      implementations,
    }),
  };
}

async function partialImplementationPhase({ store, cycle, plan, tasks, batches, implementations, error }) {
  const result = createImplementationResult({ plan, tasks, batches, implementations });
  return {
    status: IMPLEMENTATION_PHASE_STATUS.PARTIAL,
    result,
    error: combineErrors([error, await writePartialImplementationArtifact({ store, cycle, result })]),
  };
}

async function writePartialImplementationArtifact({ store, cycle, result }) {
  try {
    await writeImplementationResultArtifact(store, cycle, result);
    return null;
  } catch (error) {
    return error;
  }
}

async function runImplementationPlanWithFallback({
  provider,
  providers,
  store,
  cycle,
  planPrompt,
  context,
  model,
  timeoutMs,
  retries,
  retryDelayMs,
  logger,
}) {
  return runWithProviderFallback({
    providerChain: providerFallbackChain(provider, providers),
    runForProvider: async (planProvider) => {
      const planArtifact = createProviderItemRunArtifacts({
        store,
        promptPath: cyclePromptArtifactPath(cycle, 'implementation-plan'),
        outputPath: cycleMarkdownArtifactPath(cycle, 'implementation-plan'),
      });
      const { result: planResult } = await runProviderItem({
        provider: planProvider,
        label: 'implementation plan',
        prompt: planPrompt,
        artifacts: planArtifact,
        cwd: context.repoRoot,
        model,
        timeoutMs,
        logger,
        retry: {
          retries,
          delayMs: retryDelayMs,
          logMessage: ({ retry, retries: maxRetries }) => (
            `cycle ${cycle}: implementation plan retry ${retry}/${maxRetries} after transient ${planProvider.id} failure`
          ),
        },
        artifactPolicy: {
          writeRetry: ({ retry, error }) => store.write(
            cycleMarkdownArtifactPath(cycle, `implementation-plan.attempt-${retry}-error`),
            formatFailureMessage(error),
          ),
          writeFailure: ({ error }) => store.write(
            cycleMarkdownArtifactPath(cycle, 'implementation-plan-error'),
            formatFailureMessage(error),
          ),
        },
      });
      return { planResult, planProvider };
    },
    onFallback: ({ from, to }) => {
      logger.info(`cycle ${cycle}: implementation plan fallback ${from.id} -> ${to.id}`);
    },
  });
}
