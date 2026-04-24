import {
  cycleMarkdownArtifactPath,
  cycleProviderItemArtifactDescriptor,
} from './artifact-paths.js';
import {
  createCycleRecorder,
  createCyclePhaseView,
  createCycleRunContext,
} from './cycle-state.js';
import {
  runAssessmentProviderFanout,
} from './cycle-fanout.js';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runImplementationAndValidationPhase,
} from './cycle-implementation.js';
import {
  formatPriorFindings,
  runSynthesisWithFallback,
} from './cycle-synthesis.js';
import {
  applyCycleProgress,
  shouldStopForStall,
} from './cycle-progress.js';
import { formatFailureMessage } from './errors.js';
import { isObjectRecord } from './objects.js';
import { writeRunState } from './run-state.js';

/**
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 * @typedef {import('./cycle-state.js').CycleRunContext} CycleRunContext
 */

/**
 * Fresh per-cycle context shared with assessment adapter hooks.
 *
 * @typedef {Object} AssessmentCycleContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {Object} context Same repository context object as `runContext.context`.
 */

/**
 * Contract implemented by review/quality assessment cycle adapters. Adapter
 * construction validates the runtime shape; hook arguments include
 * `AssessmentCycleContext` plus hook-specific fields.
 *
 * @typedef {Object} AssessmentCycleAdapter
 */

/**
 * Run an assessment adapter through provider fan-out, synthesis, optional
 * implementation, and stop handling.
 *
 * @param {CycleState} state Cycle workflow state created by `createCycleState`.
 * @param {AssessmentCycleAdapter} adapter Assessment-kind-specific behavior.
 * @returns {Promise<void>}
 */
export async function runAssessmentCycles(state, adapter) {
  const { maxCycles } = state.options;
  const recorder = createCycleRecorder(state);
  const startCycle = state.cycles.length + 1;
  for (let cycle = startCycle; cycle <= maxCycles; cycle += 1) {
    const preImplementationContext = createAssessmentCycleContext(state, cycle);
    await callOptional(adapter.logCycleStart, preImplementationContext);

    const phaseView = createCyclePhaseView(state);
    const fanoutOptions = adapter.fanout(preImplementationContext);
    if (!isObjectRecord(fanoutOptions)) {
      throw new Error('runAssessmentCycles requires adapter.fanout to return options object');
    }
    const { outputs, failures: fanoutFailures } = await runAssessmentProviderFanout(phaseView, {
      cycle,
      ...fanoutOptions,
      internal: {
        artifactPaths: cycleProviderItemArtifactDescriptor,
        writeFailureArtifact: writeCycleFanoutFailureArtifact,
      },
    });

    const outputSummary = adapter.summarizeOutputs({ ...preImplementationContext, outputs });
    const synthesisPrompt = adapter.buildSynthesisPrompt({ ...preImplementationContext, outputs });
    const { synthesisProvider, synthesisText, synthesisError } = await runSynthesisWithFallback(phaseView, {
      cycle,
      prompt: synthesisPrompt,
      fallbackDescription: adapter.synthesisFallbackDescription,
    });
    const cycleSummary = synthesisText.trim()
      ? adapter.summarizeSynthesis({ ...preImplementationContext, outputs, outputSummary, synthesisText })
      : outputSummary;

    const adapterCycleRecord = adapter.buildCycleRecord({
      ...preImplementationContext,
      outputs,
      outputSummary,
      cycleSummary,
      synthesisProvider,
      synthesisText,
      synthesisError,
    });
    const cycleRecord = recorder.beginCycle(cycle, {
      ...adapterCycleRecord,
      fanoutFailures,
    }, {
      priorFindings: formatPriorFindings({
        synthesisText,
        synthesisError,
        findingsTitle: adapter.findingsTitle,
        findingsText: adapter.formatOutputs(outputs),
      }),
    });
    applyCycleProgress(state, cycleRecord);
    await writeRunState(state, { status: 'running' });
    const postRecordContext = createAssessmentCycleContext(state, cycle);

    await callOptional(adapter.afterCycle, {
      ...postRecordContext,
      outputs,
      outputSummary,
      cycleSummary,
      cycleRecord,
      synthesisProvider,
      synthesisText,
      synthesisError,
    });

    const preImplementationHandoffContext = createAssessmentCycleContext(state, cycle);
    if (!state.options.fix || !adapter.hasFixableIssues({ ...preImplementationHandoffContext, cycleRecord })) {
      break;
    }
    if (shouldStopForStall(state, cycleRecord)) {
      state.stopReason = 'stalled';
      state.logger.info(`cycle ${cycle}: stalled after ${cycleRecord.progress.stalledCycles} unchanged cycle(s); stopping fix loop`);
      await writeRunState(state, { status: 'stalled' });
      break;
    }

    const implementationHandoff = adapter.implementation({ ...preImplementationHandoffContext, cycleRecord });
    const implementationPhase = await runImplementationAndValidationPhase(phaseView, {
      cycle,
      findings: recorder.priorFindings,
      ...implementationHandoff,
    });
    recorder.applyImplementationResult(cycleRecord, implementationPhase.result, {
      testFailureUpdates: implementationHandoff.testFailureUpdates,
    });
    await writeRunState(state, { status: 'running' });
    if (implementationPhase.status === IMPLEMENTATION_PHASE_STATUS.PARTIAL) {
      throw implementationPhase.error || new Error(`cycle ${cycle}: implementation failed after partial result`);
    }
  }
}

function createAssessmentCycleContext(state, cycle) {
  const runContext = createCycleRunContext(state);
  return {
    runContext,
    cycle,
    context: runContext.context,
  };
}

async function writeCycleFanoutFailureArtifact({ store, cycle, artifact, error }) {
  const errorPath = cycleMarkdownArtifactPath(
    cycle,
    artifact.artifactRoot,
    artifact.providerFile,
    `${artifact.itemFile}.error`,
  );
  await store.write(errorPath, formatFailureMessage(error));
  return errorPath;
}

async function callOptional(fn, args) {
  if (typeof fn === 'function') {
    await fn(args);
  }
}
