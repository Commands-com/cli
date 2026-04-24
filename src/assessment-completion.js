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

export function assessmentNeedsImplementation(runContext, cycleRecord, { hasFinalIssues } = {}) {
  assertCommandIssuePredicate(hasFinalIssues);

  if (runContext.options?.untilScore) {
    return assessmentCycleRecordMissedUntilTarget(runContext, cycleRecord)
      || Boolean(runContext.hasUnresolvedTestFailure);
  }
  return Boolean(hasFinalIssues(runContext, cycleRecord));
}

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

function assertCommandIssuePredicate(hasFinalIssues) {
  if (typeof hasFinalIssues !== 'function') {
    throw new Error('completeAssessmentCommandRun requires hasFinalIssues');
  }
}

function assessmentFinalStatus(state, hasIssues) {
  if (state.stopReason) return state.stopReason;
  if (state.hasUnresolvedTestFailure) return 'validation-failed';
  return hasIssues ? 'issues' : 'passed';
}

function assessmentMissedUntilTarget(state, finalCycle) {
  return Boolean(state.options?.untilScore)
    && scoreIsWorseThanTarget(normalizedCycleScore(finalCycle), state.options.untilScore);
}

function assessmentCycleRecordMissedUntilTarget(runContext, cycleRecord) {
  // Assessment adapters store the normalized score on cycle records before
  // this stop check; the fallback covers minimal unit records without score.
  const cycleScore = cycleRecord?.score || normalizedCycleScore(cycleRecord);
  return Boolean(runContext.options?.untilScore)
    && scoreIsWorseThanTarget(cycleScore, runContext.options.untilScore);
}

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

function completionFinalCycle(state, finalCycle, fallback) {
  const cycle = finalCycle || (Array.isArray(state?.cycles) ? state.cycles.at(-1) : undefined);
  return finalCycleWithDefaults(cycle, fallback);
}
