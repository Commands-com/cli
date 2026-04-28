import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessmentNeedsImplementation,
  buildAssessmentFinalState,
  completeAssessmentCommandRun,
} from '../src/assessment-completion.js';
import { writeAssessmentFinalReport } from '../src/assessment-final-report.js';
import {
  qualityHasFinalIssues,
  reviewHasFinalIssues,
} from '../src/assessment-report.js';
import { memoryStore } from './support/memory-store.js';

/** @param {any} args @returns {any} */
function assessmentState({
  kind = 'quality',
  cycle,
  cycles,
  options = {},
  hasUnresolvedTestFailure = false,
  stopReason = '',
}) {
  const store = memoryStore({
    runId: 'run-final',
    dir: '/runs',
    writeTracking: 'map',
  });
  return {
    kind,
    store,
    logger: jsonLogger(),
    options: {
      providerIds: ['mock'],
      primaryProvider: { id: 'mock' },
      untilScore: '',
      failOnIssues: false,
      ...options,
    },
    workspace: { mode: 'current', cwd: '/repo' },
    cycles: cycles || (cycle ? [cycle] : []),
    hasUnresolvedTestFailure,
    stopReason,
  };
}

/** @returns {any} */
function jsonLogger() {
  return {
    jsonMode: true,
    payload: null,
    json(payload) {
      this.payload = payload;
    },
    info() {},
  };
}

/** @param {any} state @param {{ hasFinalIssues: any }} args */
function completeAssessment(state, { hasFinalIssues }) {
  return completeAssessmentCommandRun({
    state,
    reportArtifactName: `${state.kind}-cycle`,
    formatReport: () => 'assessment report\n',
    selectFinalCycle: (cycles) => cycles.at(-1),
    buildCompletionPayload: ({ reportPath, finalCycle }) => ({
      type: `${state.kind}.completed`,
      reportPath,
      score: finalCycle.score,
      issueCount: finalCycle.issueCount,
    }),
    hasFinalIssues,
  });
}

/** @param {any} state @param {any} cycle @param {any} hasFinalIssues */
function finalStateFor(state, cycle, hasFinalIssues) {
  return buildAssessmentFinalState(state, cycle, { hasFinalIssues });
}

test('quality final summary marks score B as issues even when issueCount is zero', async () => {
  const cycle = {
    score: 'B',
    issueCount: 0,
    synopsis: 'Quality score below A even with no counted issues.',
  };
  const state = assessmentState({ kind: 'quality', cycle });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.status, 'issues');
  assert.equal(report.summary.final.score, 'B');
  assert.equal(report.summary.final.issueCount, 0);
});

test('review final summary normalizes score A with unresolved issues', async () => {
  const cycle = {
    score: 'A',
    issueCount: 1,
    synopsis: 'One unresolved review issue remains.',
  };
  const state = assessmentState({ kind: 'review', cycle });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, reviewHasFinalIssues),
    reportPath: '/runs/review-cycle.md',
  });

  assert.equal(report.summary.status, 'issues');
  assert.equal(report.summary.final.score, 'B');
  assert.equal(report.summary.final.issueCount, 1);
});

test('final summary derives missing scores from issue counts', async () => {
  const cycle = {
    issueCount: 2,
    synopsis: 'Two unresolved issues remain.',
  };
  const state = assessmentState({ kind: 'review', cycle });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, reviewHasFinalIssues),
    reportPath: '/runs/review-cycle.md',
  });

  assert.equal(report.summary.status, 'issues');
  assert.equal(report.summary.final.score, 'C');
  assert.equal(report.summary.final.issueCount, 2);
});

test('final summary falls back to zero for missing issue counts', async () => {
  const cycle = {
    score: 'A',
    synopsis: 'No issue count was reported.',
  };
  const state = assessmentState({ kind: 'quality', cycle });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.status, 'passed');
  assert.equal(report.summary.final.score, 'A');
  assert.equal(report.summary.final.issueCount, 0);
});

test('final summary marks missed until targets as issues', async () => {
  const cycle = {
    score: 'B',
    issueCount: 0,
    synopsis: 'Clean but below the requested target score.',
  };
  const state = assessmentState({
    kind: 'quality',
    cycle,
    options: { untilScore: 'A' },
  });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.status, 'issues');
  assert.equal(report.summary.targetScore, 'A');
});

test('final summary keeps stopReason ahead of validation and issue status', async () => {
  const cycle = {
    score: 'A',
    issueCount: 1,
    synopsis: 'A stopped run still has unresolved findings.',
  };
  const state = assessmentState({
    kind: 'quality',
    cycle,
    hasUnresolvedTestFailure: true,
    stopReason: 'stalled',
  });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.status, 'stalled');
  assert.equal(report.summary.stopReason, 'stalled');
  assert.equal(report.summary.hasUnresolvedTestFailure, true);
});

test('final summary handles zero-cycle runs explicitly', async () => {
  const state = assessmentState({ kind: 'quality', cycles: [] });

  const report = await writeAssessmentFinalReport(state, {
    finalState: finalStateFor(state, undefined, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.status, 'passed');
  assert.equal(report.summary.cycles, 0);
  assert.deepEqual(report.summary.initial, {
    score: '',
    issueCount: 0,
  });
  assert.deepEqual(report.summary.final, {
    score: '',
    issueCount: 0,
    synopsis: '',
    fanoutFailureCount: 0,
    fanoutFailures: [],
  });
  assert.equal(report.summary.issueDelta, 0);
  assert.match(report.finalReport, /Cycles: 0/);
  assert.match(report.finalReport, /Initial: \(0 issues\)/);
  assert.match(report.finalReport, /Final: \(0 issues\)/);
});

test('assessment completion requires command-specific final issue semantics', async () => {
  const cycle = {
    score: 'A',
    issueCount: 0,
    synopsis: 'Clean assessment.',
  };
  const state = assessmentState({ kind: 'quality', cycle });

  await assert.rejects(
    () => completeAssessment(state, { hasFinalIssues: undefined }),
    /requires hasFinalIssues/,
  );
  await assert.rejects(
    () => writeAssessmentFinalReport(state, {
      finalCycle: cycle,
      reportPath: '/runs/code-quality.md',
    }),
    /requires finalState/,
  );
});

test('completeAssessmentCommandRun passes when until target score is met with remaining issues', async () => {
  const cycle = {
    score: 'B',
    issueCount: 1,
    synopsis: 'Target score was met but one issue remains.',
  };
  const state = assessmentState({
    kind: 'quality',
    cycle,
    options: { untilScore: 'B' },
  });

  const result = await completeAssessment(state, { hasFinalIssues: qualityHasFinalIssues });
  const finalSummary = state.store.writes.get('final-summary.json');

  assert.equal(result.exitCode, 0);
  assert.equal(state.logger.payload.final.status, 'passed');
  assert.equal(state.logger.payload.finalSummaryPath, '/runs/final-summary.json');
  assert.equal(state.logger.payload.finalReportPath, '/runs/final-report.md');
  assert.equal(state.logger.payload.reportPath, '/runs/quality-cycle.md');
  assert.equal(finalSummary.status, 'passed');
  assert.equal(finalSummary.final.issueCount, 1);
});

test('assessment final policy under until B handles review and quality B/0, B/1, and C/0', () => {
  /** @type {Array<{ label: string, cycle: any, expectedHasIssues: boolean }>} */
  const cases = [
    {
      label: 'B/0',
      cycle: {
        score: 'B',
        issueCount: 0,
        synopsis: 'Target review score met with no issues.',
      },
      expectedHasIssues: false,
    },
    {
      label: 'B/1',
      cycle: {
        score: 'B',
        issueCount: 1,
        synopsis: 'Target review score met with one remaining issue.',
      },
      expectedHasIssues: false,
    },
    {
      label: 'C/0',
      cycle: {
        score: 'C',
        issueCount: 0,
        synopsis: 'No counted issues remain, but the review target was missed.',
      },
      expectedHasIssues: true,
    },
  ];
  /** @type {Array<[string, any]>} */
  const commands = [
    ['review', reviewHasFinalIssues],
    ['quality', qualityHasFinalIssues],
  ];

  for (const [kind, hasFinalIssues] of commands) {
    for (const { label, cycle, expectedHasIssues } of cases) {
      const state = assessmentState({
        kind,
        cycle,
        options: { untilScore: 'B' },
      });

      assert.equal(
        finalStateFor(state, cycle, hasFinalIssues).hasIssues,
        expectedHasIssues,
        `${kind} ${label}`,
      );
    }
  }
});

test('assessmentNeedsImplementation under until B handles review and quality B/0, B/1, and C/0', () => {
  /** @type {Array<[string, any, boolean]>} */
  const cases = [
    ['B/0', { score: 'B', issueCount: 0, reviewerIssueCount: 0 }, false],
    ['B/1', { score: 'B', issueCount: 1, reviewerIssueCount: 1 }, false],
    ['C/0', { score: 'C', issueCount: 0, reviewerIssueCount: 0 }, true],
  ];
  /** @type {Array<[string, any]>} */
  const commands = [
    ['review', reviewHasFinalIssues],
    ['quality', qualityHasFinalIssues],
  ];

  for (const [kind, hasFinalIssues] of commands) {
    for (const [label, cycle, expectedFixable] of cases) {
      const runContext = {
        kind,
        options: { untilScore: 'B' },
        hasUnresolvedTestFailure: false,
      };

      assert.equal(
        assessmentNeedsImplementation(runContext, cycle, { hasFinalIssues }),
        expectedFixable,
        `${kind} ${label}`,
      );
    }
  }
});

test('final summary surfaces fanoutFailureCount and fanoutFailures from the selected final cycle', async () => {
  const failures = [
    { provider: 'codex', item: 'tests', error: 'timeout' },
    { provider: 'gemini', item: 'architecture', error: 'unsupported provider' },
  ];
  const cycle = {
    score: 'A',
    issueCount: 0,
    synopsis: 'Clean score with two crashed reviewers.',
    fanoutFailures: failures,
  };
  const state = assessmentState({ kind: 'quality', cycle });

  const report = await writeAssessmentFinalReport(state, {
    finalCycle: cycle,
    finalState: finalStateFor(state, cycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });

  assert.equal(report.summary.final.fanoutFailureCount, 2);
  assert.deepEqual(report.summary.final.fanoutFailures, failures);

  const cleanCycle = {
    score: 'A',
    issueCount: 0,
    synopsis: 'Clean run with no fan-out failures.',
  };
  const cleanState = assessmentState({ kind: 'quality', cycle: cleanCycle });
  const cleanReport = await writeAssessmentFinalReport(cleanState, {
    finalCycle: cleanCycle,
    finalState: finalStateFor(cleanState, cleanCycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });
  assert.equal(cleanReport.summary.final.fanoutFailureCount, 0);
  assert.deepEqual(cleanReport.summary.final.fanoutFailures, []);

  const emptyCycle = { ...cleanCycle, fanoutFailures: [] };
  const emptyState = assessmentState({ kind: 'quality', cycle: emptyCycle });
  const emptyReport = await writeAssessmentFinalReport(emptyState, {
    finalCycle: emptyCycle,
    finalState: finalStateFor(emptyState, emptyCycle, qualityHasFinalIssues),
    reportPath: '/runs/code-quality.md',
  });
  assert.equal(emptyReport.summary.final.fanoutFailureCount, 0);
  assert.deepEqual(emptyReport.summary.final.fanoutFailures, []);
});

test('completeAssessmentCommandRun uses review and quality final predicates consistently', async () => {
  const cycle = {
    score: 'B',
    issueCount: 0,
    synopsis: 'No counted findings, but the score is below A.',
  };
  const qualityState = assessmentState({
    kind: 'quality',
    cycle,
    options: { failOnIssues: true },
  });
  const reviewState = assessmentState({
    kind: 'review',
    cycle,
    options: { failOnIssues: true },
  });

  const qualityResult = await completeAssessment(qualityState, { hasFinalIssues: qualityHasFinalIssues });
  const reviewResult = await completeAssessment(reviewState, { hasFinalIssues: reviewHasFinalIssues });

  assert.equal(qualityResult.exitCode, 1);
  assert.equal(qualityState.logger.payload.final.status, 'issues');
  assert.equal(reviewResult.exitCode, 1);
  assert.equal(reviewState.logger.payload.final.status, 'issues');
});
