import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewCommand } from '../src/review.js';
import { createCycleRunContext } from '../src/cycle-state.js';
import { createCommandLogger } from '../src/logger.js';
import { captureCommandResultLogs as captureLogs } from './support/workflow-fixtures.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

function testState(cwd, { kind = 'review', options = {} } = {}) {
  return {
    kind,
    store: {
      runId: 'unit-run',
      writes: [],
      async write(name, content) {
        this.writes.push({ name, content: String(content || '') });
        return `/unit/${name}`;
      },
    },
    options: {
      providerIds: ['unit'],
      primaryProvider: { id: 'unit' },
      model: '',
      json: true,
      failOnIssues: false,
      fix: false,
      changed: false,
      ...options,
    },
    context: {
      repoRoot: cwd,
      gitRoot: cwd,
      branch: 'main',
      head: 'abc123',
      status: '',
      diffStat: '',
      diff: '',
    },
    workspace: { mode: 'current', cwd },
    cycles: [],
    priorFindings: 'prior regression note',
    hasUnresolvedTestFailure: false,
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
    reviewOutput('unit', 'correctness', 2),
    reviewOutput('unit', 'maintainability/risk', 0),
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
  assert.match(prompt, /prior regression note/);
  assert.deepEqual(
    fanout.adapter.buildOutput({ provider: { id: 'unit' }, item: 'correctness', text: outputs[0].text }),
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
  assert.equal(synthesisPrompt.includes('## unit / maintainability/risk'), true);

  const cycleRecord = adapter.buildCycleRecord({
    runContext: run,
    cycle,
    context,
    outputs,
    fanoutFailures: [
      { provider: 'unit', item: 'maintainability/risk', error: 'transient reviewer failure' },
    ],
    outputSummary,
    cycleSummary,
    synthesisProvider: 'unit-synth',
    synthesisText,
    synthesisError: '',
  });
  assert.deepEqual(cycleRecord, {
    score: 'B',
    issueCount: 1,
    synopsis: '1 actionable review issue.',
    reviewerIssueCount: 2,
    synthesisProvider: 'unit-synth',
    synthesis: synthesisText,
    synthesisError: '',
    reviewers: outputs,
  });
  assert.equal('fanoutFailures' in cycleRecord, false);
  assert.equal(adapter.formatOutputs(outputs).includes('## unit / correctness'), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord }), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord: { score: 'A', issueCount: 0 } }), false);
  assert.equal(adapter.hasFixableIssues({
    runContext: createCycleRunContext(testState(context.repoRoot, { options: { untilScore: 'A' } })),
    cycle,
    context,
    cycleRecord: { score: 'B', issueCount: 1 },
  }), true);
  assert.deepEqual(adapter.implementation({ runContext: run, cycle, context, cycleRecord }), {
    objective: 'Harden adapter wiring',
  });

  return cycleRecord;
}

test('runReviewCommand wires review assessment adapter hooks through the workflow boundary', async () => {
  const cwd = '/unit/repo';
  const commandParsed = parsed(['Harden', 'adapter', 'wiring'], {
    reviewers: 'correctness,maintainability/risk',
    json: 'true',
  });
  let logger;
  const calls = {};

  const result = await captureLogs(() => {
    logger = createCommandLogger(commandParsed, { kind: 'review' });
    return runReviewCommand(commandParsed, {
      cwd,
      logger,
      dependencies: {
        runCycleWorkflow: async (actualParsed, options) => {
          calls.workflowOptions = options;
          assert.equal(actualParsed, commandParsed);
          assert.equal(options.logger, logger);
          assert.equal(options.cwd, cwd);
          assert.equal(options.kind, 'review');
          assert.equal(options.label, 'Harden adapter wiring');
          assert.deepEqual(options.metadata, {
            objective: 'Harden adapter wiring',
            reviewers: ['correctness', 'maintainability/risk'],
          });

          const state = testState(cwd);
          state.logger = options.logger;
          calls.state = state;
          calls.adapter = options.adapter;
          state.cycles.push({
            cycle: 1,
            ...exerciseReviewAdapter(options.adapter, state),
          });
          return state;
        },
      },
    });
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(payload.type, 'review.completed');
  assert.equal(payload.score, 'B');
  assert.equal(payload.issueCount, 1);
  assert.equal(payload.synopsis, '1 actionable review issue.');
  assert.equal(payload.reportPath, '/unit/review-cycle.md');
  assert.equal(payload.cycles[0].issueCount, 1);
  assert.equal(payload.cycles[0].reviewerIssueCount, 2);
  const reportWrite = calls.state.store.writes.find((write) => write.name === 'review-cycle.md');
  assert.equal(reportWrite.content.includes('# Review Cycle: Harden adapter wiring'), true);
  assert.ok(calls.state.store.writes.some((write) => write.name === 'final-report.md'));
  assert.equal(typeof calls.workflowOptions.adapter, 'object');
  assert.equal(typeof calls.adapter.summarizeOutputs, 'function');
  assert.equal(typeof calls.adapter.summarizeSynthesis, 'function');
});

test('runReviewCommand owns reviewer parsing and fail-on-issues result policy', async () => {
  const cwd = '/unit/repo';
  const commandParsed = parsed(['Review', 'boundary'], {
    reviewers: 'correctness, ,tests',
    'fail-on-issues': 'true',
    json: 'true',
  });
  let logger;
  const calls = {};

  const result = await captureLogs(() => {
    logger = createCommandLogger(commandParsed, { kind: 'review' });
    return runReviewCommand(commandParsed, {
      cwd,
      logger,
      dependencies: {
        runCycleWorkflow: async (actualParsed, options) => {
          calls.workflowOptions = options;
          assert.equal(actualParsed, commandParsed);
          assert.equal(options.logger, logger);
          assert.deepEqual(options.metadata, {
            objective: 'Review boundary',
            reviewers: ['correctness', 'tests'],
          });

          const state = testState(cwd, {
            options: {
              failOnIssues: true,
              json: true,
            },
          });
          state.logger = options.logger;
          state.cycles.push({
            cycle: 1,
            score: 'C',
            issueCount: 2,
            reviewerIssueCount: 2,
            synopsis: 'Two review findings remain.',
            synthesisProvider: 'unit',
            synthesis: '',
            synthesisError: '',
            reviewers: [],
          });
          return state;
        },
      },
    });
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 1);
  assert.equal(result.commandResult.failed, true);
  assert.equal(payload.type, 'review.completed');
  assert.equal(payload.cycles[0].issueCount, 2);
  assert.equal(calls.workflowOptions.kind, 'review');
});
