import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentCompletionPayload } from '../src/assessment-completion.js';
import {
  DEFAULT_QUALITY_FINAL_CYCLE,
  DEFAULT_REVIEW_FINAL_CYCLE,
  finalCycleWithDefaults,
  formatQualityReport,
  formatReviewReport,
  qualityHasFinalIssues,
  reviewHasFinalIssues,
} from '../src/assessment-report.js';

function selectQualityFinalCycle(cycles) {
  return finalCycleWithDefaults(cycles?.at(-1), DEFAULT_QUALITY_FINAL_CYCLE);
}

/** @param {any} overrides @returns {any} */
function baseState(overrides = {}) {
  const { options = {}, ...stateOverrides } = overrides;
  return /** @type {any} */ ({
    store: { runId: 'run-id' },
    options: {
      providerIds: ['codex'],
      model: '',
      primaryProvider: { id: 'codex' },
      ...options,
    },
    context: { repoRoot: '/repo' },
    workspace: { mode: 'current', cwd: '/repo' },
    hasUnresolvedTestFailure: false,
    cycles: [],
    ...stateOverrides,
  });
}

test('formatReviewReport preserves cycle ordering, implementation sections, tests, and worktree footer', () => {
  const state = baseState({
    store: { runId: 'run-review' },
    options: {
      providerIds: ['codex', 'claude'],
      model: 'gpt-test',
      primaryProvider: { id: 'codex' },
    },
    workspace: {
      mode: 'worktree',
      cwd: '/tmp/worktree',
      branch: 'commands/fix-parser',
    },
    hasUnresolvedTestFailure: true,
    cycles: [
      {
        cycle: 1,
        score: 'C',
        issueCount: 2,
        reviewerIssueCount: 2,
        synopsis: 'Parser still has review findings.',
        synthesisProvider: 'codex',
        synthesis: 'Review synthesis text.',
        synthesisError: '',
        reviewers: [
          {
            provider: 'codex',
            role: 'correctness',
            text: 'Review finding text.',
          },
        ],
        implementationPlan: 'Plan text.',
        implementation: 'Implementation text.',
        test: { ok: false, exitCode: 1 },
      },
      {
        cycle: 2,
        score: 'A',
        issueCount: 0,
        reviewerIssueCount: 0,
        synopsis: 'Review findings are resolved.',
        synthesisProvider: 'claude',
        synthesis: '',
        synthesisError: 'Synthesis fallback failed.',
        reviewers: [],
        test: { ok: true, exitCode: 0 },
      },
    ],
  });

  assert.equal(formatReviewReport(state, { objective: 'Fix parser' }), [
    '# Review Cycle: Fix parser',
    '',
    'Run: run-review',
    'Providers: codex, claude (gpt-test)',
    'Synthesizer/implementer: codex',
    'Repository: /repo',
    'Workspace mode: worktree',
    'Score: A',
    'Issue count: 0',
    'Synopsis: Review findings are resolved.',
    'Unresolved test failure: yes',
    'Worktree branch: commands/fix-parser',
    'Worktree path: /tmp/worktree',
    '',
    '',
    '## Cycle 1',
    'Score: C',
    'Issue count: 2',
    'Reviewer issue count: 2',
    'Synopsis: Parser still has review findings.',
    '### Synthesis (codex)',
    '',
    'Review synthesis text.',
    '### codex / correctness',
    '',
    'Review finding text.',
    '### Implementation Plan',
    '',
    'Plan text.',
    '### Implementation',
    '',
    'Implementation text.',
    '### Test',
    '',
    'failed with exit 1',
    '## Cycle 2',
    'Score: A',
    'Issue count: 0',
    'Reviewer issue count: 0',
    'Synopsis: Review findings are resolved.',
    '### Synthesis Error (claude)',
    '',
    'Synthesis fallback failed.',
    '### Test',
    '',
    'passed',
    '',
    '## Worktree Next Steps',
    '',
    'Inspect changes: `cd /tmp/worktree`',
    'Merge manually from branch: `commands/fix-parser`',
  ].join('\n'));

  assert.deepEqual(buildAssessmentCompletionPayload({
    state,
    reportPath: '/runs/review-cycle.md',
    type: 'review.completed',
    fallbackCycle: DEFAULT_REVIEW_FINAL_CYCLE,
  }), {
    type: 'review.completed',
    runId: 'run-review',
    reportPath: '/runs/review-cycle.md',
    providers: ['codex', 'claude'],
    synthesizerProvider: 'codex',
    implementerProvider: 'codex',
    score: 'A',
    issueCount: 0,
    synopsis: 'Review findings are resolved.',
    unresolvedTestFailure: true,
    workspace: state.workspace,
    cycles: state.cycles,
  });
  assert.equal(reviewHasFinalIssues(state), true);
});

test('formatQualityReport preserves summary, synthesis, provider output, implementation, and test sections', () => {
  const state = baseState({
    store: { runId: 'run-quality' },
    options: {
      providerIds: ['gemini'],
      primaryProvider: { id: 'gemini' },
    },
    cycles: [
      {
        cycle: 1,
        score: 'C',
        issueCount: 3,
        providerIssueCount: 2,
        synopsis: 'Needs smaller modules.',
        synthesisProvider: 'gemini',
        synthesis: 'Quality synthesis text.',
        synthesisError: 'Quality synthesis warning.',
        outputs: [
          {
            provider: 'gemini',
            area: 'maintainability',
            text: 'Quality output text.',
          },
        ],
        implementationPlan: 'Refactor report assembly.',
        test: { ok: true, exitCode: 0 },
      },
    ],
  });
  const finalCycle = selectQualityFinalCycle(state.cycles);

  assert.equal(formatQualityReport(state, { finalCycle }), [
    '# Code Quality Report',
    '',
    'Run: run-quality',
    'Providers: gemini',
    'Synthesizer/implementer: gemini',
    'Repository: /repo',
    'Workspace mode: current',
    'Score: C',
    'Issue count: 3',
    'Synopsis: Needs smaller modules.',
    '',
    '',
    '',
    '',
    '',
    '## Cycle 1',
    'Score: C',
    'Issue count: 3',
    'Provider issue count: 2',
    'Synopsis: Needs smaller modules.',
    '### Synthesis (gemini)',
    '',
    'Quality synthesis text.',
    '### Synthesis Error (gemini)',
    '',
    'Quality synthesis warning.',
    '### gemini / maintainability',
    '',
    'Quality output text.',
    '### Implementation Plan',
    '',
    'Refactor report assembly.',
    '### Test',
    '',
    'passed',
    '',
  ].join('\n'));

  assert.deepEqual(buildAssessmentCompletionPayload({
    state,
    reportPath: '/runs/code-quality.md',
    finalCycle,
    type: 'quality.completed',
    fallbackCycle: DEFAULT_QUALITY_FINAL_CYCLE,
    extra: {
      provider: 'gemini',
      outputs: state.cycles[0].outputs,
    },
  }), {
    type: 'quality.completed',
    runId: 'run-quality',
    reportPath: '/runs/code-quality.md',
    provider: 'gemini',
    providers: ['gemini'],
    synthesizerProvider: 'gemini',
    implementerProvider: 'gemini',
    score: 'C',
    issueCount: 3,
    synopsis: 'Needs smaller modules.',
    unresolvedTestFailure: false,
    workspace: state.workspace,
    cycles: state.cycles,
    outputs: state.cycles[0].outputs,
  });
  assert.equal(qualityHasFinalIssues(state, finalCycle), true);
});

test('formatQualityReport summary header omits Fan-out failures when only historical cycles failed', () => {
  const state = baseState({
    options: { providerIds: ['codex'], primaryProvider: { id: 'codex' } },
    cycles: [
      {
        cycle: 1,
        score: 'C',
        issueCount: 1,
        providerIssueCount: 0,
        synopsis: 'Cycle 1 had a transient failure.',
        outputs: [],
        fanoutFailures: [{ provider: 'codex', item: 'tests', error: 'boom' }],
      },
      {
        cycle: 2,
        score: 'A',
        issueCount: 0,
        providerIssueCount: 0,
        synopsis: 'Cycle 2 recovered cleanly.',
        outputs: [],
        fanoutFailures: [],
      },
    ],
  });
  const finalCycle = selectQualityFinalCycle(state.cycles);

  const report = formatQualityReport(state, { finalCycle });
  const header = report.split('## Cycle 1')[0];
  assert.ok(!header.includes('Fan-out failures'),
    'header must not advertise Fan-out failures when the final cycle is clean');
  assert.equal(state.cycles[0].fanoutFailures.length, 1,
    'historical fanoutFailures remain on the cycle record for JSON consumers');
});

test('formatQualityReport renders Fan-out failures count and lines for the final cycle', () => {
  const state = baseState({
    options: { providerIds: ['codex'], primaryProvider: { id: 'codex' } },
    cycles: [
      {
        cycle: 3,
        score: 'C',
        issueCount: 1,
        providerIssueCount: 0,
        synopsis: 'Final cycle still has fan-out failures.',
        outputs: [],
        fanoutFailures: [
          { provider: 'codex', item: 'tests', error: 'timeout' },
          { provider: 'gemini', item: 'architecture', error: 'unsupported provider' },
        ],
      },
    ],
  });
  const finalCycle = selectQualityFinalCycle(state.cycles);

  const report = formatQualityReport(state, { finalCycle });
  const header = report.split('## Cycle 3')[0];
  assert.match(header, /Fan-out failures: 2/);
  assert.match(header, /- cycle 3: codex\/tests failed: timeout/);
  assert.match(header, /- cycle 3: gemini\/architecture failed: unsupported provider/);
});

test('qualityHasFinalIssues treats non-A scores as issues even when issue count is zero', () => {
  const state = baseState({
    options: { providerIds: ['codex'], primaryProvider: { id: 'codex' } },
  });
  for (const score of ['B', 'C', 'D', 'F']) {
    const finalCycle = { score, issueCount: 0, synopsis: `${score} with no issues.` };
    assert.equal(qualityHasFinalIssues(state, finalCycle), true, `score ${score}`);
  }
});

test('quality report helpers preserve empty-cycle fallback payload and report behavior', () => {
  const state = baseState({
    store: { runId: 'run-empty-quality' },
    options: {
      providerIds: ['codex'],
      primaryProvider: { id: 'codex' },
    },
  });

  const finalCycle = selectQualityFinalCycle(state.cycles);
  assert.equal(finalCycle.score, 'A');
  assert.equal(finalCycle.issueCount, 0);
  assert.equal(finalCycle.synopsis, 'No quality audit outputs were produced.');
  assert.equal(qualityHasFinalIssues(state, finalCycle), false);
  assert.match(formatQualityReport(state, { finalCycle }), /Score: A/);
  assert.deepEqual(buildAssessmentCompletionPayload({
    state,
    reportPath: '/runs/code-quality.md',
    finalCycle,
    type: 'quality.completed',
    fallbackCycle: DEFAULT_QUALITY_FINAL_CYCLE,
    extra: {
      provider: 'codex',
      outputs: finalCycle.outputs,
    },
  }), {
    type: 'quality.completed',
    runId: 'run-empty-quality',
    reportPath: '/runs/code-quality.md',
    provider: 'codex',
    providers: ['codex'],
    synthesizerProvider: 'codex',
    implementerProvider: 'codex',
    score: 'A',
    issueCount: 0,
    synopsis: 'No quality audit outputs were produced.',
    unresolvedTestFailure: false,
    workspace: state.workspace,
    cycles: [],
    outputs: [],
  });
});
