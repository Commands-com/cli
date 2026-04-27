import { markdownArtifactPath } from './artifact-paths.js';
import {
  DEFAULT_QUALITY_FINAL_CYCLE,
  DEFAULT_REVIEW_FINAL_CYCLE,
  finalCycleWithDefaults,
} from './assessment-report.js';
import { completeCommandRun } from './command-result.js';
import {
  formatIssueCount,
  normalizedCycleIssueCount,
  normalizedCycleScore,
  scoreIsWorseThanTarget,
} from './cycle-summary.js';
import { writeAssessmentFinalReport } from './assessment-final-report.js';

/**
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 * @typedef {import('./cycle-state.js').CycleRunContext} CycleRunContext
 * @typedef {import('./cycle-state.js').CycleRecord} CycleRecord
 * @typedef {import('./cycle-state.js').CycleWorkspace} CycleWorkspace
 * @typedef {import('./assessment-report.js').AssessmentFinalCycle} AssessmentFinalCycle
 */

/**
 * Predicate used by review/quality adapters to decide whether the latest
 * cycle still has unresolved issues. Both `CycleState` (used at the
 * completion boundary) and the lighter `CycleRunContext` (used by stop
 * checks during loop iteration) are valid first arguments; adapters
 * accept either via duck-typed access on `hasUnresolvedTestFailure` and
 * `options.untilScore`.
 *
 * @typedef {(state: CycleState | CycleRunContext, cycle: AssessmentFinalCycle | CycleRecord | undefined) => boolean} AssessmentIssuePredicate
 */

/**
 * Inputs for `buildReviewCompletionPayload` / `buildQualityCompletionPayload`.
 * Fields are structurally optional so the destructure-with-default pattern
 * type-checks; adapter callers always supply real values.
 *
 * @typedef {object} CompletionPayloadInputs
 * @property {CycleState} [state]
 * @property {string} [reportPath]
 * @property {AssessmentFinalCycle} [finalCycle]
 */

/**
 * Common payload fields produced by `assessmentCompletionFields` and shared
 * by review and quality completion payloads. Adapter-specific fields (e.g.
 * `provider`, `outputs`) are layered on top by the per-adapter builders.
 *
 * @typedef {object} AssessmentCompletionFields
 * @property {string} runId
 * @property {string} reportPath
 * @property {Array<string>} providers
 * @property {string} synthesizerProvider
 * @property {string} implementerProvider
 * @property {boolean} unresolvedTestFailure
 * @property {CycleWorkspace} workspace
 * @property {Array<CycleRecord>} cycles
 */

/**
 * Adapter-specific completion payload returned by `buildCompletionPayload`.
 * The shape is concrete inside each adapter (review/quality) but the generic
 * `completeAssessmentCommandRun` only needs to spread it into the final
 * envelope, so it is typed as a string-keyed record here.
 *
 * @typedef {Record<string, unknown>} AdapterCompletionPayload
 */

/**
 * Internal disposition computed by `buildAssessmentFinalState`. `hasIssues`
 * drives the command exit code; `missedUntilTarget` controls the optional
 * `--until` informational line; `status` is the terminal disposition string
 * persisted in `final-summary.json`.
 *
 * @typedef {object} AssessmentFinalState
 * @property {boolean} hasIssues
 * @property {boolean} missedUntilTarget
 * @property {string} status
 */

/**
 * Loose default-cycle shape used by `completionFinalCycle` to absorb the
 * frozen `DEFAULT_QUALITY_FINAL_CYCLE` / `DEFAULT_REVIEW_FINAL_CYCLE`
 * literals (which carry readonly arrays). Only `score`, `issueCount`,
 * and `synopsis` are read downstream via `finalCycleWithDefaults`.
 *
 * @typedef {object} AssessmentFinalCycleFallback
 * @property {string} [score]
 * @property {number} [issueCount]
 * @property {string} [synopsis]
 */

/**
 * Inputs for `completeAssessmentCommandRun`. The callbacks let review and
 * quality share the same finalization shape while supplying their own
 * report formatter, final-cycle selector, and completion payload builder.
 *
 * @typedef {object} CompleteAssessmentCommandRunArgs
 * @property {CycleState} state
 * @property {string} reportArtifactName
 * @property {(state: CycleState, options: { objective?: string, finalCycle: AssessmentFinalCycle }) => string} formatReport
 * @property {{ objective?: string }} [formatReportOptions]
 * @property {(cycles: Array<CycleRecord>) => AssessmentFinalCycle} selectFinalCycle
 * @property {(args: { state: CycleState, reportPath: string, finalCycle: AssessmentFinalCycle }) => AdapterCompletionPayload} buildCompletionPayload
 * @property {AssessmentIssuePredicate} hasFinalIssues
 */

/**
 * @param {CompletionPayloadInputs} [args]
 */
export function buildReviewCompletionPayload({ state, reportPath, finalCycle } = {}) {
  const fields = assessmentCompletionFields(state, reportPath);
  const selectedFinalCycle = completionFinalCycle(state, finalCycle, DEFAULT_REVIEW_FINAL_CYCLE);
  return {
    type: 'review.completed',
    ...fields,
    score: selectedFinalCycle.score,
    issueCount: selectedFinalCycle.issueCount,
    synopsis: selectedFinalCycle.synopsis,
  };
}

/**
 * @param {CompletionPayloadInputs} args
 */
export function buildQualityCompletionPayload({
  state,
  reportPath,
  finalCycle,
}) {
  const fields = assessmentCompletionFields(state, reportPath);
  const selectedFinalCycle = completionFinalCycle(state, finalCycle, DEFAULT_QUALITY_FINAL_CYCLE);
  return {
    type: 'quality.completed',
    ...fields,
    provider: state.options.primaryProvider.id,
    score: selectedFinalCycle.score,
    issueCount: selectedFinalCycle.issueCount,
    synopsis: selectedFinalCycle.synopsis,
    outputs: selectedFinalCycle.outputs,
  };
}

/**
 * @param {CompleteAssessmentCommandRunArgs} args
 */
export async function completeAssessmentCommandRun({
  state,
  reportArtifactName,
  formatReport,
  formatReportOptions = {},
  selectFinalCycle,
  buildCompletionPayload,
  hasFinalIssues,
}) {
  assertCommandIssuePredicate(hasFinalIssues);

  const finalCycle = selectFinalCycle(state.cycles);
  const report = formatReport(state, { ...formatReportOptions, finalCycle });
  const reportPath = await state.store.write(markdownArtifactPath(reportArtifactName), report);
  const finalState = buildAssessmentFinalState(state, finalCycle, { hasFinalIssues });
  const finalReport = await writeAssessmentFinalReport(state, {
    finalCycle,
    finalState,
    reportPath,
  });
  return completeCommandRun({
    payload: {
      ...buildCompletionPayload({ state, reportPath, finalCycle }),
      finalSummaryPath: finalReport.summaryPath,
      finalReportPath: finalReport.finalReportPath,
      final: finalReport.summary,
    },
    failOnIssues: state.options.failOnIssues || Boolean(state.options.untilScore),
    hasFinalIssues: finalState.hasIssues,
    logger: state.logger,
    onText: (textLogger) => {
      const finalScore = normalizedCycleScore(finalCycle);
      const finalIssueCount = normalizedCycleIssueCount(finalCycle);
      textLogger.info(`final: ${finalScore} (${formatIssueCount(finalIssueCount)}) after ${state.cycles.length} cycle(s)`);
      textLogger.info(`score: ${finalScore} (${formatIssueCount(finalIssueCount)})`);
      textLogger.info(`synopsis: ${finalCycle.synopsis}`);
      if (finalState.missedUntilTarget) {
        textLogger.info(`until: target ${state.options.untilScore} was not reached within ${state.options.maxCycles} cycle(s)`);
      }
      textLogger.info(`report: ${reportPath}`);
      textLogger.info(`final report: ${finalReport.finalReportPath}`);
    },
  });
}

/**
 * @param {CycleState} state
 * @param {AssessmentFinalCycle} finalCycle
 * @param {{ hasFinalIssues?: AssessmentIssuePredicate }} [options]
 * @returns {AssessmentFinalState}
 */
export function buildAssessmentFinalState(state, finalCycle, { hasFinalIssues } = {}) {
  assertCommandIssuePredicate(hasFinalIssues);

  const missedUntilTarget = assessmentMissedUntilTarget(state, finalCycle);
  const hasIssues = assessmentHasFinalIssues(state, finalCycle, { hasFinalIssues });
  return {
    hasIssues,
    missedUntilTarget,
    status: assessmentFinalStatus(state, hasIssues),
  };
}

/**
 * @param {CycleRunContext} runContext
 * @param {CycleRecord} cycleRecord
 * @param {{ hasFinalIssues?: AssessmentIssuePredicate }} [options]
 * @returns {boolean}
 */
export function assessmentNeedsImplementation(runContext, cycleRecord, { hasFinalIssues } = {}) {
  assertCommandIssuePredicate(hasFinalIssues);

  if (runContext.options?.untilScore) {
    return assessmentCycleRecordMissedUntilTarget(runContext, cycleRecord)
      || Boolean(runContext.hasUnresolvedTestFailure);
  }
  return Boolean(hasFinalIssues(runContext, cycleRecord));
}

/**
 * @param {CycleState} state
 * @param {AssessmentFinalCycle} finalCycle
 * @param {{ hasFinalIssues: AssessmentIssuePredicate }} options
 * @returns {boolean}
 */
function assessmentHasFinalIssues(state, finalCycle, { hasFinalIssues }) {
  if (state.hasUnresolvedTestFailure) {
    return true;
  }
  if (state.options?.untilScore) {
    // Score-target runs define success by the requested normalized score.
    // Remaining issue count is already reflected in normalizedCycleScore.
    return assessmentMissedUntilTarget(state, finalCycle);
  }
  return Boolean(hasFinalIssues(state, finalCycle));
}

/**
 * @param {AssessmentIssuePredicate | undefined} hasFinalIssues
 */
function assertCommandIssuePredicate(hasFinalIssues) {
  if (typeof hasFinalIssues !== 'function') {
    throw new Error('completeAssessmentCommandRun requires hasFinalIssues');
  }
}

/**
 * @param {CycleState} state
 * @param {boolean} hasIssues
 * @returns {string}
 */
function assessmentFinalStatus(state, hasIssues) {
  if (state.stopReason) return state.stopReason;
  if (state.hasUnresolvedTestFailure) return 'validation-failed';
  return hasIssues ? 'issues' : 'passed';
}

/**
 * @param {CycleState | CycleRunContext} state
 * @param {AssessmentFinalCycle | CycleRecord | undefined} finalCycle
 * @returns {boolean}
 */
function assessmentMissedUntilTarget(state, finalCycle) {
  return Boolean(state.options?.untilScore)
    && scoreIsWorseThanTarget(normalizedCycleScore(finalCycle), state.options.untilScore);
}

/**
 * @param {CycleRunContext} runContext
 * @param {CycleRecord} cycleRecord
 * @returns {boolean}
 */
function assessmentCycleRecordMissedUntilTarget(runContext, cycleRecord) {
  // Assessment adapters store the normalized score on cycle records before
  // this stop check; the fallback covers minimal unit records without score.
  const cycleScore = cycleRecord?.score || normalizedCycleScore(cycleRecord);
  return Boolean(runContext.options?.untilScore)
    && scoreIsWorseThanTarget(cycleScore, runContext.options.untilScore);
}

/**
 * @param {CycleState} state
 * @param {string} reportPath
 * @returns {AssessmentCompletionFields}
 */
function assessmentCompletionFields(state, reportPath) {
  return {
    runId: state.store.runId,
    reportPath,
    providers: state.options.providerIds,
    synthesizerProvider: state.options.primaryProvider.id,
    implementerProvider: state.options.primaryProvider.id,
    unresolvedTestFailure: state.hasUnresolvedTestFailure,
    workspace: state.workspace,
    cycles: state.cycles,
  };
}

/**
 * @param {CycleState} state
 * @param {AssessmentFinalCycle | undefined} finalCycle
 * @param {AssessmentFinalCycleFallback} fallback
 * @returns {AssessmentFinalCycle}
 */
function completionFinalCycle(state, finalCycle, fallback) {
  const cycle = finalCycle || (Array.isArray(state?.cycles) ? state.cycles.at(-1) : undefined);
  return finalCycleWithDefaults(cycle, fallback);
}
