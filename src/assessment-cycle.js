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
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {import('./cycle-state.js').CycleRecord} CycleRecord
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./cycle-fanout.js').AssessmentFanoutFailure} AssessmentCycleFanoutFailure
 * @typedef {import('./cycle-fanout.js').AssessmentFanoutItemDescriptor} AssessmentFanoutItemDescriptor
 */

/**
 * Provider-tagged output produced by the inner adapter's `buildOutput` hook.
 * Adapters extend this with provider-specific fields (review reviewers carry
 * `role`, quality outputs carry `area`/`areas`).
 *
 * @typedef {object} AssessmentCycleProviderOutput
 * @property {string} provider Provider id that produced this output.
 * @property {string} text Raw provider text.
 * @property {string} [score] Parsed score, when present.
 * @property {number} [issueCount] Parsed issue count, when present.
 * @property {string} [synopsis] Parsed synopsis, when present.
 */

/**
 * Aggregate cycle summary produced by the adapter's output and synthesis
 * summarizers. Both ultimately shape the cycle record.
 *
 * @typedef {object} AssessmentCycleSummary
 * @property {string} [score] Latest cycle score.
 * @property {number} [issueCount] Aggregate issue count.
 * @property {string} [synopsis] One-line cycle synopsis.
 * @property {number} [reviewerIssueCount] Pre-synthesis reviewer aggregate (review only).
 * @property {number} [providerIssueCount] Pre-synthesis provider aggregate (quality only).
 */

/**
 * Inner adapter consumed by `runAssessmentProviderFanout`. The args bag varies
 * by hook (`buildPrompt` sees prompt args, `buildOutput` adds the provider
 * `result`/`text`, `logOutput`/`writeAdditionalArtifacts` add the rendered
 * `output` and persisted `artifact`).
 *
 * @typedef {object} AssessmentFanoutInnerAdapter
 * @property {string} [artifactRoot] Artifact root segment for this fan-out.
 * @property {(args: AssessmentFanoutPromptArgs) => string} buildPrompt Provider prompt builder.
 * @property {(args: AssessmentFanoutResultArgs) => AssessmentCycleProviderOutput} buildOutput Output builder.
 * @property {(args: AssessmentFanoutOutputArgs) => void} [logOutput] Optional output logger.
 * @property {(args: AssessmentFanoutOutputArgs) => (void|Promise<void>)} [writeAdditionalArtifacts] Optional extra artifact writer.
 */

/**
 * Args passed to the inner adapter's `buildPrompt` hook by `cycle-fanout.js`.
 *
 * @typedef {object} AssessmentFanoutPromptArgs
 * @property {{ id: string, command?: string }} provider Provider descriptor.
 * @property {unknown} item Item value (kind-specific: reviewer role, quality areas, ...).
 * @property {AssessmentFanoutItemDescriptor} itemDescriptor Normalized item descriptor.
 * @property {number} itemIndex Zero-based item index within the fan-out.
 * @property {CycleRepoContext} context Repository context for prompt rendering.
 * @property {number} cycle One-based cycle number.
 */

/**
 * Args passed to `buildOutput` — `buildPrompt` args plus the provider result.
 *
 * @typedef {AssessmentFanoutPromptArgs & {
 *   result: { text?: string },
 *   text: string,
 * }} AssessmentFanoutResultArgs
 */

/**
 * Args passed to `logOutput` / `writeAdditionalArtifacts` — `buildOutput` args
 * plus the rendered output and persisted artifact metadata.
 *
 * @typedef {AssessmentFanoutResultArgs & {
 *   output: AssessmentCycleProviderOutput,
 *   artifact: { promptPath: string, outputPath: string, path: string },
 * }} AssessmentFanoutOutputArgs
 */

/**
 * Options returned by `adapter.fanout` and spread into
 * `runAssessmentProviderFanout`.
 *
 * @typedef {object} AssessmentCycleFanoutOptions
 * @property {Array<unknown>} items Fan-out items.
 * @property {string} label Human-readable fan-out label.
 * @property {boolean} [partial] Whether per-job failures should surface in `failures`.
 * @property {AssessmentFanoutInnerAdapter} adapter Inner adapter consumed by `runAssessmentProviderFanout`.
 */

/**
 * Implementation handoff returned by `adapter.implementation`. The optional
 * `testFailureUpdates` lets adapters bias the cycle record when validation
 * fails (quality flips score to F).
 *
 * @typedef {object} AssessmentCycleImplementationHandoff
 * @property {string} objective Objective passed to the implementation planner.
 * @property {Partial<CycleRecord>} [testFailureUpdates] Cycle record overrides applied on a failing test run.
 */

/**
 * Fresh per-cycle context shared with `logCycleStart` and `fanout` hooks (and
 * returned by `createAssessmentCycleContext`).
 *
 * @typedef {object} AssessmentCycleContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 */

/**
 * Args passed to `summarizeOutputs` and `buildSynthesisPrompt` after fan-out.
 *
 * @typedef {object} AssessmentCycleOutputsContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 * @property {Array<AssessmentCycleProviderOutput>} outputs Raw provider outputs from fan-out.
 */

/**
 * Args passed to `summarizeSynthesis` once synthesis text is available.
 *
 * @typedef {object} AssessmentCycleSynthesisContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 * @property {Array<AssessmentCycleProviderOutput>} outputs Raw provider outputs from fan-out.
 * @property {AssessmentCycleSummary} outputSummary Aggregate summary of raw provider outputs.
 * @property {string} synthesisText Synthesis text produced by `runSynthesisWithFallback`.
 */

/**
 * Args passed to `buildCycleRecord` once synthesis has run.
 *
 * @typedef {object} AssessmentCycleRecordContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 * @property {Array<AssessmentCycleProviderOutput>} outputs Raw provider outputs from fan-out.
 * @property {AssessmentCycleSummary} outputSummary Aggregate summary of raw provider outputs.
 * @property {AssessmentCycleSummary} cycleSummary Final cycle summary (synthesis-derived when present, else `outputSummary`).
 * @property {string} synthesisProvider Provider id that produced the synthesis text.
 * @property {string} synthesisText Synthesis text produced by `runSynthesisWithFallback`.
 * @property {string} synthesisError Error message captured during synthesis (empty when none).
 */

/**
 * Args passed to post-record hooks (`hasFixableIssues`, `implementation`).
 *
 * @typedef {object} AssessmentCycleAfterContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 * @property {CycleRecord} cycleRecord Cycle record produced by the recorder.
 */

/**
 * Args passed to the optional `afterCycle` hook with the full cycle context.
 *
 * @typedef {object} AssessmentCycleAfterCycleContext
 * @property {CycleRunContext} runContext Canonical read-only run context captured for this hook.
 * @property {number} cycle One-based cycle number.
 * @property {CycleRepoContext} context Same repository context object as `runContext.context`.
 * @property {Array<AssessmentCycleProviderOutput>} outputs Raw provider outputs from fan-out.
 * @property {AssessmentCycleSummary} outputSummary Aggregate summary of raw provider outputs.
 * @property {AssessmentCycleSummary} cycleSummary Final cycle summary (synthesis-derived when present, else `outputSummary`).
 * @property {CycleRecord} cycleRecord Cycle record produced by the recorder.
 * @property {string} synthesisProvider Provider id that produced the synthesis text.
 * @property {string} synthesisText Synthesis text produced by `runSynthesisWithFallback`.
 * @property {string} synthesisError Error message captured during synthesis (empty when none).
 */

/**
 * Contract implemented by review/quality assessment cycle adapters. Adapters
 * may attach extra fields to the cycle record (`reviewers`, `outputs`, etc.);
 * `buildCycleRecord` is typed loosely enough to allow that.
 *
 * @typedef {object} AssessmentCycleAdapter
 * @property {string} findingsTitle Section title used when formatting prior findings.
 * @property {string} synthesisFallbackDescription Description logged when synthesis falls back.
 * @property {(context: AssessmentCycleContext) => void} [logCycleStart] Optional pre-fanout log hook.
 * @property {(context: AssessmentCycleContext) => AssessmentCycleFanoutOptions} fanout Provider fan-out options.
 * @property {(context: AssessmentCycleOutputsContext) => AssessmentCycleSummary} summarizeOutputs Summarize raw provider outputs.
 * @property {(context: AssessmentCycleSynthesisContext) => AssessmentCycleSummary} summarizeSynthesis Summarize synthesis text.
 * @property {(context: AssessmentCycleOutputsContext) => string} buildSynthesisPrompt Build the synthesis prompt.
 * @property {(context: AssessmentCycleRecordContext) => Partial<CycleRecord>} buildCycleRecord Build cycle record extras.
 * @property {(outputs: Array<AssessmentCycleProviderOutput>) => string} formatOutputs Render outputs for prior findings.
 * @property {(context: AssessmentCycleAfterContext) => boolean} hasFixableIssues Decide whether implementation should run.
 * @property {(context: AssessmentCycleAfterCycleContext) => (void|Promise<void>)} [afterCycle] Optional post-record hook.
 * @property {(context: AssessmentCycleAfterContext) => AssessmentCycleImplementationHandoff} implementation Implementation handoff builder.
 */

/**
 * Args bag passed to `writeCycleFanoutFailureArtifact`.
 *
 * @typedef {object} CycleFanoutFailureArtifactArgs
 * @property {CycleStore} store Artifact store.
 * @property {number} cycle One-based cycle number.
 * @property {{ artifactRoot: string, providerFile: string, itemFile: string }} artifact Artifact descriptor.
 * @property {unknown} error Captured failure.
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
    const cycleContext = createAssessmentCycleContext(state, cycle);
    await callOptional(adapter.logCycleStart, cycleContext);

    const phaseView = createCyclePhaseView(state);
    const fanoutOptions = adapter.fanout(cycleContext);
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

    const outputSummary = adapter.summarizeOutputs({ ...cycleContext, outputs });
    const synthesisPrompt = adapter.buildSynthesisPrompt({ ...cycleContext, outputs });
    const { synthesisProvider, synthesisText, synthesisError } = await runSynthesisWithFallback(phaseView, {
      cycle,
      prompt: synthesisPrompt,
      fallbackDescription: adapter.synthesisFallbackDescription,
    });
    const cycleSummary = synthesisText.trim()
      ? adapter.summarizeSynthesis({ ...cycleContext, outputs, outputSummary, synthesisText })
      : outputSummary;

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

    if (!state.options.fix || !adapter.hasFixableIssues({ ...postRecordContext, cycleRecord })) {
      break;
    }
    if (shouldStopForStall(state, cycleRecord)) {
      state.stopReason = 'stalled';
      state.logger.info(`cycle ${cycle}: stalled after ${cycleRecord.progress.stalledCycles} unchanged cycle(s); stopping fix loop`);
      await writeRunState(state, { status: 'stalled' });
      break;
    }

    const implementationHandoff = adapter.implementation({ ...postRecordContext, cycleRecord });
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

/**
 * @param {CycleFanoutFailureArtifactArgs} args
 * @returns {Promise<string>}
 */
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

/**
 * @template T
 * @param {((args: T) => (void|Promise<void>)) | undefined} fn
 * @param {T} args
 * @returns {Promise<void>}
 */
async function callOptional(fn, args) {
  if (typeof fn === 'function') {
    await fn(args);
  }
}
