import {
  cycleArtifactPath,
  cycleMarkdownArtifactPath,
} from './artifact-paths.js';
import { collectRepoContext } from './git.js';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runOrchestratedImplementationPhase,
} from './implementation.js';
import { combineErrors } from './errors.js';
import { isObjectRecord } from './objects.js';
import { formatRepoContext } from './repo-context-prompt.js';
import {
  runShell,
  summarizeTestFailure,
} from './workflow.js';

export { IMPLEMENTATION_PHASE_STATUS };

/**
 * @typedef {import('./cycle-state.js').CycleProvider} CycleProvider
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./cycle-state.js').CycleWorkspace} CycleWorkspace
 * @typedef {import('./cycle-state.js').CycleLogger} CycleLogger
 */

/**
 * Inputs for the implementation and validation phase.
 *
 * @typedef {Object} CycleImplementationValidationArgs
 * @property {number} cycle One-based cycle number.
 * @property {string} objective Objective passed to the implementation planner.
 * @property {string} findings Prior findings handed to implementers.
 */

/**
 * Runtime option subset used by implementation.
 *
 * @typedef {Object} CycleImplementationRuntime
 * @property {Array<CycleProvider>} [providers] Provider fallback chain.
 * @property {CycleProvider} primaryProvider Provider used for planning and implementation.
 * @property {string} testCommand Optional validation command.
 * @property {string} [model] Provider model override.
 * @property {number} [timeoutMs] Provider and validation timeout.
 * @property {number} maxImplementers Maximum number of implementation tasks.
 * @property {boolean} [implementationParallel] Whether implementation batches may run in parallel.
 * @property {number} [providerRetries] Transient provider retry count.
 */

/**
 * Explicit dependency object consumed by implementation and validation.
 *
 * @typedef {Object} CycleImplementationDependencies
 * @property {string} kind Workflow kind for implementer log prefixes.
 * @property {CycleStore} store Artifact store.
 * @property {CycleWorkspace} workspace Active workspace.
 * @property {CycleRepoContext} context Repository context captured before implementation.
 * @property {CycleLogger} logger Command logger.
 * @property {CycleImplementationRuntime} implementationRuntimeOptions Implementation runtime options.
 */

/**
 * Result returned by the implementation phase. The caller owns applying these
 * values to `CycleState` and cycle records.
 *
 * @typedef {Object} CycleImplementationValidationResult
 * @property {Object} implementation Implementation planner/worker result.
 * @property {Object|null} testResult Optional validation command result.
 * @property {CycleRepoContext} nextContext Repository context after implementation.
 * @property {string} nextFindings Findings to carry into the next cycle.
 */

export async function runImplementationAndValidationPhase(dependencies, {
  cycle,
  objective,
  findings,
}) {
  assertCycleImplementationDependencies(dependencies);
  const {
    kind,
    store,
    workspace,
    context,
    logger,
    implementationRuntimeOptions: runtimeOptions,
  } = dependencies;
  const {
    primaryProvider,
    providers,
    testCommand,
    model,
    timeoutMs,
    maxImplementers,
    implementationParallel,
    providerRetries,
  } = runtimeOptions;
  logger.info(`cycle ${cycle}: orchestrator (${primaryProvider.id})`);
  const implementationPhase = await runOrchestratedImplementationPhase({
    provider: primaryProvider,
    providers,
    store,
    cycle,
    objective,
    findings,
    context,
    workspace,
    testCommand,
    model,
    timeoutMs,
    maxImplementers,
    parallel: implementationParallel,
    retries: providerRetries,
    logger,
    logPrefix: kind,
  });

  const validationOutcome = await buildImplementationValidationOutcome({
    store,
    cycle,
    findings,
    context,
    workspace,
    testCommand,
    timeoutMs,
    logger,
    implementation: implementationPhase.result,
    tolerateErrors: implementationPhase.status === IMPLEMENTATION_PHASE_STATUS.PARTIAL,
  });
  if (validationOutcome.error && implementationPhase.status !== IMPLEMENTATION_PHASE_STATUS.PARTIAL) {
    throw validationOutcome.error;
  }

  if (implementationPhase.status === IMPLEMENTATION_PHASE_STATUS.PARTIAL) {
    return {
      status: IMPLEMENTATION_PHASE_STATUS.PARTIAL,
      result: validationOutcome.result,
      error: combineErrors([implementationPhase.error, validationOutcome.error]),
    };
  }
  return {
    status: IMPLEMENTATION_PHASE_STATUS.COMPLETED,
    result: validationOutcome.result,
  };
}

async function buildImplementationValidationOutcome({
  store,
  cycle,
  findings,
  context,
  workspace,
  testCommand,
  timeoutMs,
  logger,
  implementation,
  tolerateErrors = false,
}) {
  let nextFindings = findings;
  let testResult = null;
  let nextContext = context;
  let firstError = null;
  const captureError = (error) => {
    if (!firstError) firstError = error;
    if (!tolerateErrors) throw error;
  };

  if (testCommand) {
    try {
      logger.info(`cycle ${cycle}: ${testCommand}`);
      testResult = await runShell(testCommand, context.repoRoot, { timeoutMs });
      if (!testResult.ok) {
        nextFindings = [nextFindings, summarizeTestFailure(testCommand, testResult)]
          .filter(Boolean)
          .join('\n\n');
      }
    } catch (error) {
      captureError(error);
    }

    if (testResult) {
      try {
        await store.write(cycleArtifactPath(cycle, 'test.log'), testLogText({ testCommand, testResult }));
      } catch (error) {
        captureError(error);
      }
    }
  }

  try {
    nextContext = await collectRepoContext(workspace.cwd, { changed: true });
  } catch (error) {
    captureError(error);
  }

  if (nextContext !== context) {
    try {
      await store.write(cycleMarkdownArtifactPath(cycle, 'post-implementation-context'), formatRepoContext(nextContext));
    } catch (error) {
      captureError(error);
    }
  }

  return {
    result: {
      implementation,
      testResult,
      nextContext,
      nextFindings,
    },
    error: firstError,
  };
}

function testLogText({ testCommand, testResult }) {
  return [
    `$ ${testCommand}`,
    '',
    testResult.stdout,
    testResult.stderr,
  ].join('\n');
}

function assertCycleImplementationDependencies(dependencies) {
  const runtimeOptions = dependencies?.implementationRuntimeOptions;
  const missing = [
    [isObjectRecord(dependencies), 'explicit implementation dependencies'],
    [typeof dependencies?.kind === 'string' && Boolean(dependencies.kind), 'kind'],
    [typeof dependencies?.store?.write === 'function', 'dependencies.store.write'],
    [typeof dependencies?.workspace?.cwd === 'string', 'dependencies.workspace.cwd'],
    [typeof dependencies?.context?.repoRoot === 'string', 'dependencies.context.repoRoot'],
    [typeof dependencies?.logger?.info === 'function', 'dependencies.logger.info'],
    [isObjectRecord(runtimeOptions), 'dependencies.implementationRuntimeOptions'],
    [typeof runtimeOptions?.primaryProvider?.id === 'string', 'dependencies.implementationRuntimeOptions.primaryProvider'],
  ].find(([passes]) => !passes);
  if (missing) throw new Error(`runImplementationAndValidationPhase requires ${missing[1]}`);
}
