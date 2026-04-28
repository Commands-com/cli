import { cycleReportHeader, worktreeNextSteps } from './cycle-report.js';
import {
  normalizedCycleIssueCount,
  normalizedCycleScore,
  scoreIsWorseThanTarget,
} from './cycle-summary.js';

/**
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 */

/**
 * Final-cycle summary used to render review/quality reports. Loose shape:
 * the synthesizer fills score/issue/synopsis; reviewer/output and
 * fanoutFailure arrays are mode-specific.
 *
 * @typedef {object} AssessmentFinalCycle
 * @property {string} [score]
 * @property {number} [issueCount]
 * @property {number} [reviewerIssueCount]
 * @property {number} [providerIssueCount]
 * @property {string} [synopsis]
 * @property {number} [cycle]
 * @property {string} [synthesis]
 * @property {string} [synthesisProvider]
 * @property {string} [synthesisError]
 * @property {string} [implementationPlan]
 * @property {string} [implementation]
 * @property {{ ok: boolean, exitCode?: number }} [test]
 * @property {Array<{ provider: string, role?: string, text: string }>} [reviewers]
 * @property {Array<{ provider: string, area?: string, text: string }>} [outputs]
 * @property {Array<{ provider: string, item: string, error: string }>} [fanoutFailures]
 */

/**
 * Public assessment reporting facade.
 *
 * Review and quality commands import report rendering, issue predicates, and
 * final-cycle defaults from here. Completion payload builders live in
 * `assessment-completion.js`. `assessment-prompts.js` owns prompt construction.
 */
export const DEFAULT_QUALITY_FINAL_CYCLE = Object.freeze({
  score: 'A',
  issueCount: 0,
  synopsis: 'No quality audit outputs were produced.',
  outputs: Object.freeze([]),
});

export const DEFAULT_REVIEW_FINAL_CYCLE = Object.freeze({
  score: 'A',
  issueCount: 0,
  reviewerIssueCount: 0,
  synopsis: 'No review outputs were produced.',
  reviewers: Object.freeze([]),
});

const REVIEW_REPORT_MODE = {
  perCycleIssueCountLabel: 'Reviewer issue count',
  perCycleIssueCountKey: 'reviewerIssueCount',
  itemsKey: 'reviewers',
  itemFieldName: 'role',
  fallback: DEFAULT_REVIEW_FINAL_CYCLE,
};

const QUALITY_REPORT_MODE = {
  perCycleIssueCountLabel: 'Provider issue count',
  perCycleIssueCountKey: 'providerIssueCount',
  itemsKey: 'outputs',
  itemFieldName: 'area',
  fallback: DEFAULT_QUALITY_FINAL_CYCLE,
};

/**
 * @param {CycleState} state
 * @param {{ objective?: string, finalCycle?: AssessmentFinalCycle }} [options]
 */
export function formatReviewReport(state, { objective, finalCycle } = {}) {
  return formatAssessmentReportByMode(state, REVIEW_REPORT_MODE, {
    title: `Review Cycle: ${objective}`,
    finalCycle,
  });
}

/**
 * @param {CycleState} state
 * @param {{ finalCycle?: AssessmentFinalCycle }} [options]
 */
export function formatQualityReport(state, { finalCycle } = {}) {
  return formatAssessmentReportByMode(state, QUALITY_REPORT_MODE, {
    title: 'Code Quality Report',
    finalCycle,
  });
}

function formatAssessmentReportByMode(state, mode, { title, finalCycle }) {
  const selectedFinalCycle = finalCycle || selectFinalCycle(state.cycles, mode.fallback);
  return formatAssessmentReport({
    title,
    state,
    summaryLines: [
      `Score: ${selectedFinalCycle.score}`,
      `Issue count: ${selectedFinalCycle.issueCount}`,
      `Synopsis: ${selectedFinalCycle.synopsis}`,
      ...fanoutFailuresSummaryLines(selectedFinalCycle),
    ],
    renderCycle: (cycle) => formatAssessmentCycle(cycle, {
      summaryLines: [
        `Score: ${cycle.score}`,
        `Issue count: ${cycle.issueCount}`,
        `${mode.perCycleIssueCountLabel}: ${cycle[mode.perCycleIssueCountKey]}`,
        `Synopsis: ${cycle.synopsis}`,
      ],
      itemSections: (cycle[mode.itemsKey] || [])
        .map((item) => `### ${item.provider} / ${item[mode.itemFieldName]}\n\n${item.text}`),
    }),
  });
}

function selectFinalCycle(cycles, fallback) {
  return finalCycleWithDefaults(Array.isArray(cycles) ? cycles.at(-1) : undefined, fallback);
}

function fanoutFailuresSummaryLines(finalCycle) {
  const failures = Array.isArray(finalCycle?.fanoutFailures) ? finalCycle.fanoutFailures : [];
  if (!failures.length) return [];
  return [
    `Fan-out failures: ${failures.length}`,
    ...failures.map((failure) => (
      `- cycle ${finalCycle.cycle}: ${failure.provider}/${failure.item} failed: ${failure.error}`
    )),
  ];
}

export function reviewHasFinalIssues(state, finalCycle = selectFinalCycle(state.cycles, DEFAULT_REVIEW_FINAL_CYCLE)) {
  return assessmentCycleHasFinalIssues(state, finalCycle);
}

export function qualityHasFinalIssues(state, finalCycle = selectFinalCycle(state.cycles, DEFAULT_QUALITY_FINAL_CYCLE)) {
  return assessmentCycleHasFinalIssues(state, finalCycle);
}

function assessmentCycleHasFinalIssues(state, finalCycle) {
  return Boolean(
    normalizedCycleIssueCount(finalCycle) > 0
      || scoreIsWorseThanTarget(normalizedCycleScore(finalCycle), 'A')
      || state.hasUnresolvedTestFailure,
  );
}

function formatAssessmentReport({
  title,
  state,
  summaryLines = [],
  renderCycle,
}) {
  return [
    ...cycleReportHeader({
      title,
      store: state.store,
      providerIds: state.options.providerIds,
      model: state.options.model,
      primaryProvider: state.options.primaryProvider,
      context: state.context,
      workspace: state.workspace,
      summaryLines,
      unresolvedTestFailure: state.hasUnresolvedTestFailure,
    }),
    ...state.cycles.flatMap(renderCycle),
    worktreeNextSteps(state.workspace),
  ].join('\n');
}

function formatAssessmentCycle(cycle, { summaryLines, itemSections }) {
  return [
    `## Cycle ${cycle.cycle}`,
    '',
    ...summaryLines,
    '',
    cycle.synthesis ? `### Synthesis (${cycle.synthesisProvider})\n\n${cycle.synthesis}` : '',
    cycle.synthesisError ? `### Synthesis Error (${cycle.synthesisProvider})\n\n${cycle.synthesisError}` : '',
    ...itemSections,
    cycle.implementationPlan ? `### Implementation Plan\n\n${cycle.implementationPlan}` : '',
    cycle.implementation ? `### Implementation\n\n${cycle.implementation}` : '',
    cycle.test ? `### Test\n\n${formatTestResult(cycle.test)}` : '',
  ].filter(Boolean);
}

function formatTestResult(test) {
  return test.ok ? 'passed' : `failed with exit ${test.exitCode}`;
}

export function finalCycleWithDefaults(cycle, fallback) {
  if (!cycle) return fallback;
  const issueCount = normalizedCycleIssueCount(cycle);
  return {
    ...fallback,
    ...cycle,
    score: normalizedCycleScore(cycle, { fallbackScore: fallback.score }),
    issueCount,
    synopsis: cycle.synopsis || fallback.synopsis,
  };
}
