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
 * @typedef {import('./cycle-state.js').CycleState} CycleState
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
 * Result returned by the implementation phase. The caller owns applying these
 * values to `CycleState` and cycle records.
 *
 * @typedef {Object} CycleImplementationValidationResult
 * @property {Object} implementation Implementation planner/worker result.
 * @property {Object|null} testResult Optional validation command result.
 * @property {CycleRepoContext} nextContext Repository context after implementation.
 * @property {string} nextFindings Findings to carry into the next cycle.
 */

/**
 * @param {CycleState} state
 * @param {CycleImplementationValidationArgs} args
 */
export async function runImplementationAndValidationPhase(state, {
  cycle,
  objective,
  findings,
}) {
  const {
    kind,
    store,
    workspace,
    context,
    logger,
    options,
  } = state;
  const phaseLogger = /** @type {{ info(message?: string): void }} */ (logger);
  const {
    primaryProvider,
    providers,
    model,
    timeoutMs,
    providerRetries,
    serial,
    testCommand,
    maxImplementers,
  } = options;
  const implementationParallel = !serial && maxImplementers > 1;
  phaseLogger.info(`cycle ${cycle}: orchestrator (${primaryProvider.id})`);
  const implementationPhase = await runOrchestratedImplementationPhase({
    execution: {
      provider: primaryProvider,
      providers,
      model,
      timeoutMs,
      retries: providerRetries,
      logger: phaseLogger,
      logPrefix: kind,
    },
    taskWorkspace: { store, cycle, context, workspace },
    assignment: { objective, findings, testCommand },
    orchestration: { maxImplementers, parallel: implementationParallel },
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
