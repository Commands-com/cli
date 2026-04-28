import { artifactPath, markdownArtifactPath } from './artifact-paths.js';
import {
  formatIssueCount,
  normalizedCycleIssueCount,
  normalizedCycleScore,
} from './cycle-summary.js';

/**
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 * @typedef {import('./assessment-report.js').AssessmentFinalCycle} AssessmentFinalCycle
 */

/**
 * Terminal disposition recorded once a run stops looping. The status string
 * appears in `final-summary.json` and the human-readable final report.
 *
 * @typedef {object} AssessmentFinalState
 * @property {string} status
 */

/**
 * Inputs for `writeAssessmentFinalReport`.
 *
 * @typedef {object} WriteAssessmentFinalReportOptions
 * @property {AssessmentFinalCycle} [finalCycle] Final cycle summary (defaults to last cycle).
 * @property {AssessmentFinalState} finalState Terminal disposition.
 * @property {string} [reportPath] Path to the detailed report, surfaced in the final summary.
 */

/**
 * @param {CycleState} state
 * @param {WriteAssessmentFinalReportOptions} options
 */
export async function writeAssessmentFinalReport(state, {
  finalCycle,
  finalState,
  reportPath,
}) {
  const summary = buildAssessmentFinalSummary(state, {
    finalCycle,
    finalState,
    reportPath,
  });
  const finalReport = formatAssessmentFinalReport(summary);
  const summaryPath = await writeJson(state.store, artifactPath('final-summary.json'), summary);
  const finalReportPath = await state.store.write(markdownArtifactPath('final-report'), finalReport);
  return {
    summary,
    summaryPath,
    finalReport,
    finalReportPath,
  };
}

function writeJson(store, name, value) {
  if (typeof store.writeJson === 'function') return store.writeJson(name, value);
  return store.write(name, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {CycleState} state
 * @param {{ finalCycle?: AssessmentFinalCycle, finalState: AssessmentFinalState, reportPath?: string }} options
 */
function buildAssessmentFinalSummary(state, {
  finalCycle,
  finalState,
  reportPath = '',
}) {
  const cycles = Array.isArray(state.cycles) ? state.cycles : [];
  const firstCycle = cycles[0] || {};
  const lastCycle = finalCycle || cycles[cycles.length - 1] || {};
  const finalIssueCount = normalizedCycleIssueCount(lastCycle);
  const initialIssueCount = normalizedCycleIssueCount(firstCycle);
  const finalFanoutFailures = Array.isArray(lastCycle.fanoutFailures)
    ? lastCycle.fanoutFailures.map(({ provider, item, error }) => ({ provider, item, error }))
    : [];
  return {
    kind: state.kind,
    runId: state.store?.runId || '',
    status: finalState.status,
    cycles: cycles.length,
    providers: state.options?.providerIds || [],
    synthesizerProvider: state.options?.primaryProvider?.id || '',
    implementerProvider: state.options?.primaryProvider?.id || '',
    workspace: state.workspace || {},
    targetScore: state.options?.untilScore || '',
    initial: {
      score: normalizedCycleScore(firstCycle),
      issueCount: initialIssueCount,
    },
    final: {
      score: normalizedCycleScore(lastCycle),
      issueCount: finalIssueCount,
      synopsis: lastCycle.synopsis || '',
      fanoutFailureCount: finalFanoutFailures.length,
      fanoutFailures: finalFanoutFailures,
    },
    issueDelta: initialIssueCount - finalIssueCount,
    hasUnresolvedTestFailure: Boolean(state.hasUnresolvedTestFailure),
    stopReason: state.stopReason || '',
    reportPath,
  };
}

function formatAssessmentFinalReport(summary) {
  const lines = [
    `# ${title(summary.kind)} Final Report`,
    '',
    `Status: ${summary.status}`,
    `Run: ${summary.runId}`,
    `Cycles: ${summary.cycles}`,
    summary.targetScore ? `Target: ${summary.targetScore}` : '',
    scoreLine('Initial', summary.initial),
    scoreLine('Final', summary.final),
    `Issue delta: ${formatDelta(summary.issueDelta)}`,
    `Providers: ${summary.providers.join(', ') || '(none)'}`,
    summary.stopReason ? `Stop reason: ${summary.stopReason}` : '',
    summary.hasUnresolvedTestFailure ? 'Validation: unresolved failure' : 'Validation: clear',
    summary.reportPath ? `Detailed report: ${summary.reportPath}` : '',
    '',
    summary.final.synopsis ? `Synopsis: ${summary.final.synopsis}` : '',
  ].filter((line) => line !== '');
  return `${lines.join('\n')}\n`;
}

function scoreLine(label, value) {
  const score = value?.score ? `${value.score} ` : '';
  return `${label}: ${score}(${formatIssueCount(normalizedCycleIssueCount(value))})`;
}

function formatDelta(value) {
  if (value > 0) return `-${value}`;
  if (value < 0) return `+${Math.abs(value)}`;
  return '0';
}

function title(kind) {
  const text = String(kind || 'Assessment');
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
