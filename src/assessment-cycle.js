import {
  cycleMarkdownArtifactPath,
  cycleProviderItemArtifactDescriptor,
} from './artifact-paths.js';
import {
  createCycleRecorder,
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
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {import('./cycle-state.js').CycleRecord} CycleRecord
 * @typedef {import('./cycle-fanout.js').AssessmentFanoutItemDescriptor} AssessmentFanoutItemDescriptor
 */

/**
 * Provider-tagged output produced by the inner adapter's `buildOutput` hook.
 * Adapters extend this with provider-specific fields (review reviewers carry
 * `role`, quality outputs carry `area`/`areas`).
 *
 * @typedef {object} AssessmentCycleProviderOutput
 * @property {string} provider
 * @property {string} text
 * @property {string} [role]
 * @property {string} [area]
 * @property {Array<string>} [areas]
 * @property {string} [score]
 * @property {number} [issueCount]
 * @property {string} [synopsis]
 */

/**
 * @typedef {object} AssessmentCycleSummary
 * @property {string} [score]
 * @property {number} [issueCount]
 * @property {string} [synopsis]
 * @property {number} [reviewerIssueCount] Pre-synthesis reviewer aggregate (review only).
 * @property {number} [providerIssueCount] Pre-synthesis provider aggregate (quality only).
 */

/**
 * @typedef {object} AssessmentCycleContext
 * @property {CycleRunContext} runContext
 * @property {number} cycle
 * @property {CycleRepoContext} context Same object as `runContext.context`.
 *
 * @typedef {AssessmentCycleContext & {
 *   outputs?: Array<AssessmentCycleProviderOutput>,
 *   outputSummary?: AssessmentCycleSummary,
 *   cycleSummary?: AssessmentCycleSummary,
 *   cycleRecord?: CycleRecord,
 *   synthesisProvider?: string,
 *   synthesisText?: string,
 *   synthesisError?: string,
 * }} AssessmentCyclePostRecordContext
 */

/**
 * Inner adapter consumed by `runAssessmentProviderFanout`. The hook arg bag
 * grows by stage: `buildPrompt` sees the base args; `buildOutput` adds the
 * provider `result`/`text`; `logOutput` and `writeAdditionalArtifacts` add the
 * rendered `output` and persisted `artifact` paths.
 *
 * @typedef {{
 *   provider: { id: string, command?: string },
 *   item: unknown,
 *   itemDescriptor: AssessmentFanoutItemDescriptor,
 *   itemIndex: number,
 *   context: CycleRepoContext,
 *   cycle: number,
 * }} AssessmentFanoutHookArgs
 *
 * @typedef {object} AssessmentFanoutInnerAdapter
 * @property {string} [artifactRoot]
 * @property {(args: AssessmentFanoutHookArgs) => string} buildPrompt
 * @property {(args: AssessmentFanoutHookArgs & { result: { text?: string }, text: string }) => AssessmentCycleProviderOutput} buildOutput
 * @property {(args: AssessmentFanoutHookArgs & { result: { text?: string }, text: string, output: AssessmentCycleProviderOutput, artifact: { promptPath: string, outputPath: string, path: string } }) => void} [logOutput]
 * @property {(args: AssessmentFanoutHookArgs & { result: { text?: string }, text: string, output: AssessmentCycleProviderOutput, artifact: { promptPath: string, outputPath: string, path: string } }) => (void|Promise<void>)} [writeAdditionalArtifacts]
 */

/**
 * Contract implemented by review/quality assessment cycle adapters. Adapters
 * may attach extra fields to the cycle record (`reviewers`, `outputs`, etc.);
 * `buildCycleRecord` is typed loosely enough to allow that. The
 * `summarize*` / `build*` hook contexts grow as the cycle progresses
 * (outputs → synthesis text → final summary), all layered onto
 * `AssessmentCycleContext`.
 *
 * @typedef {object} AssessmentCycleAdapter
 * @property {string} findingsTitle
 * @property {string} synthesisFallbackDescription
 * @property {(context: AssessmentCycleContext) => void} [logCycleStart]
 * @property {(context: AssessmentCycleContext) => { items: Array<unknown>, label: string, partial?: boolean, adapter: AssessmentFanoutInnerAdapter }} fanout
 * @property {(context: AssessmentCycleContext & { outputs: Array<AssessmentCycleProviderOutput> }) => AssessmentCycleSummary} summarizeOutputs
 * @property {(context: AssessmentCycleContext & { outputs: Array<AssessmentCycleProviderOutput>, outputSummary: AssessmentCycleSummary, synthesisText: string }) => AssessmentCycleSummary} summarizeSynthesis
 * @property {(context: AssessmentCycleContext & { outputs: Array<AssessmentCycleProviderOutput> }) => string} buildSynthesisPrompt
 * @property {(context: AssessmentCycleContext & { outputs: Array<AssessmentCycleProviderOutput>, outputSummary: AssessmentCycleSummary, cycleSummary: AssessmentCycleSummary, synthesisProvider: string, synthesisText: string, synthesisError: string }) => Partial<CycleRecord>} buildCycleRecord
 * @property {(outputs: Array<AssessmentCycleProviderOutput>) => string} formatOutputs
 * @property {(context: AssessmentCyclePostRecordContext) => boolean} hasFixableIssues
 * @property {(context: AssessmentCyclePostRecordContext) => (void|Promise<void>)} [afterCycle]
 * @property {(context: AssessmentCyclePostRecordContext) => { objective: string, testFailureUpdates?: Partial<CycleRecord> }} implementation
 */

/**
 * @param {CycleState} state
 * @param {AssessmentCycleAdapter} adapter
 * @returns {Promise<void>}
 */
export async function runAssessmentCycles(state, adapter) {
  const { maxCycles } = state.options;
  const recorder = createCycleRecorder(state);
  const startCycle = state.cycles.length + 1;
  for (let cycle = startCycle; cycle <= maxCycles; cycle += 1) {
    const cycleContext = createAssessmentCycleContext(state, cycle);
    await callOptional(adapter.logCycleStart, cycleContext);

    const fanoutOptions = adapter.fanout(cycleContext);
    if (!isObjectRecord(fanoutOptions)) {
      throw new Error('runAssessmentCycles requires adapter.fanout to return options object');
    }
    const { outputs, failures: fanoutFailures } = await runAssessmentProviderFanout(state, {
      cycle,
      ...fanoutOptions,
      internal: {
        artifactPaths: cycleProviderItemArtifactDescriptor,
        writeFailureArtifact: writeCycleFanoutFailureArtifact,
      },
    });

    const outputSummary = adapter.summarizeOutputs({ ...cycleContext, outputs });
    const {
      synthesisProvider,
      synthesisText,
      synthesisError,
      cycleSummary,
    } = await maybeSynthesizeOutputs({
      adapter,
      state,
      cycleContext,
      outputs,
      outputSummary,
    });

    const adapterCycleRecord = adapter.buildCycleRecord({
      ...cycleContext,
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
    // Re-snapshot so post-record hooks see updated priorFindings.
    const postRecordContext = {
      ...createAssessmentCycleContext(state, cycle),
      outputs,
      outputSummary,
      cycleSummary,
      cycleRecord,
      synthesisProvider,
      synthesisText,
      synthesisError,
    };

    await callOptional(adapter.afterCycle, postRecordContext);

    if (!state.options.fix || !adapter.hasFixableIssues(postRecordContext)) {
      break;
    }
    if (shouldStopForStall(state, cycleRecord)) {
      state.stopReason = 'stalled';
      state.logger.info(`cycle ${cycle}: stalled after ${cycleRecord.progress.stalledCycles} unchanged cycle(s); stopping fix loop`);
      await writeRunState(state, { status: 'stalled' });
      break;
    }

    const implementationHandoff = adapter.implementation(postRecordContext);
    const implementationPhase = await runImplementationAndValidationPhase(state, {
      cycle,
      findings: recorder.priorFindings,
      ...implementationHandoff,
    });
    recorder.applyImplementationResult(cycleRecord, implementationPhase.result, {
      testFailureUpdates: implementationHandoff.testFailureUpdates,
    });
    await writeRunState(state, { status: 'running' });
    if (implementationHasNoTasks(implementationPhase.result)) {
      break;
    }
    if (implementationPhase.status === IMPLEMENTATION_PHASE_STATUS.PARTIAL) {
      throw implementationPhase.error || new Error(`cycle ${cycle}: implementation failed after partial result`);
    }
  }
}

async function maybeSynthesizeOutputs({
  adapter,
  state,
  cycleContext,
  outputs,
  outputSummary,
}) {
  if (outputs.length <= 1) {
    return {
      synthesisProvider: '',
      synthesisText: '',
      synthesisError: '',
      cycleSummary: outputSummary,
    };
  }

  const synthesisPrompt = adapter.buildSynthesisPrompt({ ...cycleContext, outputs });
  const { synthesisProvider, synthesisText, synthesisError } = await runSynthesisWithFallback(state, {
    cycle: cycleContext.cycle,
    prompt: synthesisPrompt,
    fallbackDescription: adapter.synthesisFallbackDescription,
  });
  return {
    synthesisProvider,
    synthesisText,
    synthesisError,
    cycleSummary: synthesisText.trim()
      ? adapter.summarizeSynthesis({ ...cycleContext, outputs, outputSummary, synthesisText })
      : outputSummary,
  };
}

function implementationHasNoTasks(result) {
  return Array.isArray(result?.implementation?.tasks)
    && result.implementation.tasks.length === 0;
}

/**
 * @param {CycleState} state
 * @param {number} cycle
 * @returns {AssessmentCycleContext}
 */
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
