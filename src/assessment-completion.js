import { markdownArtifactPath } from './artifact-paths.js';
import { finalCycleWithDefaults } from './assessment-report.js';
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
 * Common payload fields produced by `assessmentCompletionFields` and shared
 * by review and quality completion payloads. Adapter-specific fields (e.g.
 * `provider`, `outputs`) are layered on top via the `extra` argument.
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
 * Inputs for `buildAssessmentCompletionPayload`. The merged builder shared
 * by review and quality adapters; `type` is the literal payload `type`
 * field, `fallbackCycle` is the per-adapter default cycle, and `extra`
 * carries adapter-specific fields (e.g. quality's `provider`/`outputs`).
 *
 * @typedef {object} BuildAssessmentCompletionPayloadInputs
 * @property {CycleState} state
 * @property {string} reportPath
 * @property {AssessmentFinalCycle} [finalCycle]
 * @property {string} type
 * @property {AssessmentFinalCycleFallback} fallbackCycle
 * @property {Record<string, unknown>} [extra]
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
 * @param {BuildAssessmentCompletionPayloadInputs} args
 */
export function buildAssessmentCompletionPayload({
  state,
  reportPath,
  finalCycle,
  type,
  fallbackCycle,
  extra,
}) {
  const fields = assessmentCompletionFields(state, reportPath);
  const selectedFinalCycle = completionFinalCycle(state, finalCycle, fallbackCycle);
  return {
    type,
    ...fields,
    ...(extra || {}),
    score: selectedFinalCycle.score,
    issueCount: selectedFinalCycle.issueCount,
    synopsis: selectedFinalCycle.synopsis,
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
 * @param {{ hasFinalIssues: AssessmentIssuePredicate }} options
 * @returns {AssessmentFinalState}
 */
export function buildAssessmentFinalState(state, finalCycle, { hasFinalIssues }) {
  // Final-state resolution always runs after synthesis, so normalize the
  // score from the final cycle rather than trusting any cached field.
  const missedUntilTarget = missedUntilTargetForScore(state, normalizedCycleScore(finalCycle));
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
 * @param {{ hasFinalIssues: AssessmentIssuePredicate }} options
 * @returns {boolean}
 */
export function assessmentNeedsImplementation(runContext, cycleRecord, { hasFinalIssues }) {
  if (runContext.options?.untilScore) {
    // Cycle records carry the normalized score before this stop check;
    // the fallback covers minimal unit records without one.
    const cycleScore = cycleRecord?.score || normalizedCycleScore(cycleRecord);
    return missedUntilTargetForScore(runContext, cycleScore)
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
    return missedUntilTargetForScore(state, normalizedCycleScore(finalCycle));
  }
  return Boolean(hasFinalIssues(state, finalCycle));
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
 * @param {string} score
 * @returns {boolean}
 */
function missedUntilTargetForScore(state, score) {
  return Boolean(state.options?.untilScore)
    && scoreIsWorseThanTarget(score, state.options.untilScore);
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
