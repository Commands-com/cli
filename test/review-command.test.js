import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runReviewCommand } from '../src/review.js';
import { createCycleRunContext } from '../src/cycle-state.js';
import { tempDir } from './support/cli.js';
import { captureCommandResultLogs as captureLogs } from './support/workflow-fixtures.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

function reviewText(issueCount) {
  const score = issueCount === 0 ? 'A' : issueCount === 1 ? 'B' : 'C';
  const summary = issueCount > 0
    ? `${issueCount} actionable review ${issueCount === 1 ? 'issue' : 'issues'}.`
    : 'No actionable review findings.';
  return [
    '```yaml',
    `score: ${score}`,
    `verdict: ${issueCount > 0 ? 'issues' : 'clean'}`,
    `issue_count: ${issueCount}`,
    `summary: ${summary}`,
    '```',
    '',
    issueCount > 0 ? 'Actionable regression finding.' : 'No actionable findings.',
  ].join('\n');
}

function reviewOutput(provider, role, issueCount) {
  return {
    provider,
    role,
    text: reviewText(issueCount),
    score: issueCount === 0 ? 'A' : issueCount === 1 ? 'B' : 'C',
    issueCount,
    synopsis: issueCount > 0
      ? `${issueCount} actionable review ${issueCount === 1 ? 'issue' : 'issues'}.`
      : 'No actionable review findings.',
  };
}

function exerciseReviewAdapter(adapter, state) {
  const context = state.context;
  const run = createCycleRunContext(state);
  const cycle = 2;
  const outputs = [
    reviewOutput('mock', 'correctness', 2),
    reviewOutput('mock', 'maintainability/risk', 0),
  ];

  assert.equal(adapter.findingsTitle, 'Reviewer outputs');
  assert.equal(adapter.synthesisFallbackDescription, 'reviewer summaries');

  const fanout = adapter.fanout({ runContext: run, cycle, context });
  assert.equal(fanout.label, 'reviewer fan-out');
  assert.equal(fanout.partial, true);
  assert.equal(fanout.adapter.artifactRoot, 'reviewers');
  assert.deepEqual(fanout.items, [
    { value: 'correctness', label: 'correctness', pathSegment: '01-correctness' },
    { value: 'maintainability/risk', label: 'maintainability/risk', pathSegment: '02-maintainability-risk' },
  ]);

  const prompt = fanout.adapter.buildPrompt({ item: 'correctness', context });
  assert.match(prompt, /You are the correctness reviewer in a Commands\.com review cycle\./);
  assert.match(prompt, /Objective: Harden adapter wiring/);
  assert.deepEqual(
    fanout.adapter.buildOutput({ provider: { id: 'mock' }, item: 'correctness', text: outputs[0].text }),
    outputs[0],
  );

  const outputSummary = adapter.summarizeOutputs({ runContext: run, cycle, context, outputs });
  assert.deepEqual(outputSummary, {
    score: 'C',
    issueCount: 2,
    synopsis: '2 issues across 2 roles. correctness: C, 2 issues - 2 actionable review issues.; maintainability/risk: A, 0 issues - No actionable review findings.',
    reviewerIssueCount: 2,
  });

  const synthesisText = reviewText(1);
  const cycleSummary = adapter.summarizeSynthesis({
    runContext: run,
    cycle,
    context,
    outputs,
    outputSummary,
    synthesisText,
  });
  assert.deepEqual(cycleSummary, {
    score: 'B',
    issueCount: 1,
    synopsis: '1 actionable review issue.',
    reviewerIssueCount: 2,
  });

  const synthesisPrompt = adapter.buildSynthesisPrompt({ runContext: run, cycle, context, outputs });
  assert.match(synthesisPrompt, /Synthesize review findings for a Commands\.com review cycle\./);
  assert.equal(synthesisPrompt.includes('Reviewer outputs:'), true);
  assert.equal(synthesisPrompt.includes('## mock / maintainability/risk'), true);

  const cycleRecord = adapter.buildCycleRecord({
    runContext: run,
    cycle,
    context,
    outputs,
    fanoutFailures: [
      { provider: 'mock', item: 'maintainability/risk', error: 'transient reviewer failure' },
    ],
    outputSummary,
    cycleSummary,
    synthesisProvider: 'mock-synth',
    synthesisText,
    synthesisError: '',
  });
  assert.deepEqual(cycleRecord, {
    score: 'B',
    issueCount: 1,
    synopsis: '1 actionable review issue.',
    reviewerIssueCount: 2,
    synthesisProvider: 'mock-synth',
    synthesis: synthesisText,
    synthesisError: '',
    reviewers: outputs,
  });
  assert.equal('fanoutFailures' in cycleRecord, false);
  assert.equal(adapter.formatOutputs(outputs).includes('## mock / correctness'), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord }), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord: { score: 'A', issueCount: 0 } }), false);
  assert.deepEqual(adapter.implementation({ runContext: run, cycle, context, cycleRecord }), {
    objective: 'Harden adapter wiring',
  });

  return cycleRecord;
}

test('runReviewCommand wires review assessment adapter hooks through the workflow boundary', async () => {
  const cwd = await tempDir('commands-com-review-cmd-');
  try {
    const commandParsed = parsed(['Harden', 'adapter', 'wiring'], {
      provider: 'mock',
      reviewers: 'correctness,maintainability/risk',
      json: 'true',
      test: 'true',
    });
    const calls = {};

    const result = await captureLogs(() => runReviewCommand(commandParsed, {
      cwd,
      dependencies: {
        runAssessmentCycles: async (state, adapter) => {
          calls.state = state;
          calls.adapter = adapter;
          state.cycles.push({
            cycle: 1,
            ...exerciseReviewAdapter(adapter, state),
          });
        },
      },
    }));

    const payload = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(payload.type, 'review.completed');
    assert.equal(payload.score, 'B');
    assert.equal(payload.issueCount, 1);
    assert.equal(payload.synopsis, '1 actionable review issue.');
    assert.match(payload.reportPath, /review-cycle\.md$/);
    assert.equal(payload.cycles[0].issueCount, 1);
    assert.equal(payload.cycles[0].reviewerIssueCount, 2);
    assert.equal(calls.state.kind, 'review');
    assert.equal(typeof calls.adapter.summarizeOutputs, 'function');
    assert.equal(typeof calls.adapter.summarizeSynthesis, 'function');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand untilScore option keeps clean cycles fixable until target met', async () => {
  const cwd = await tempDir('commands-com-review-until-');
  try {
    let beforeTargetFixable;
    let atTargetFixable;
    await captureLogs(() => runReviewCommand(
      parsed(['until target review'], {
        provider: 'mock',
        reviewers: 'correctness',
        json: 'true',
        test: 'true',
        until: 'A',
      }),
      {
        cwd,
        dependencies: {
          runAssessmentCycles: async (state, adapter) => {
            const run = createCycleRunContext(state);
            beforeTargetFixable = adapter.hasFixableIssues({
              runContext: run,
              cycle: 1,
              context: state.context,
              cycleRecord: { cycle: 1, score: 'B', issueCount: 1 },
            });
            atTargetFixable = adapter.hasFixableIssues({
              runContext: run,
              cycle: 1,
              context: state.context,
              cycleRecord: { cycle: 1, score: 'A', issueCount: 0 },
            });
            state.cycles.push({
              cycle: 1,
              score: 'A',
              issueCount: 0,
              synopsis: 'no issues',
              reviewerIssueCount: 0,
              synthesisProvider: 'mock',
              synthesis: '',
              synthesisError: '',
              reviewers: [],
            });
          },
        },
      },
    ));
    assert.equal(beforeTargetFixable, true);
    assert.equal(atTargetFixable, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
