import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualityCommand } from '../src/quality.js';
import { createCycleRunContext } from '../src/cycle-state.js';
import { createCommandLogger } from '../src/logger.js';
import { captureCommandResultLogs as captureLogs } from './support/workflow-fixtures.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

function testState(cwd, { kind = 'quality', options = {} } = {}) {
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
      fix: true,
      changed: true,
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
    priorFindings: 'prior quality finding',
    hasUnresolvedTestFailure: false,
  };
}

function qualityText({ score, issueCount, summary }) {
  return [
    '```yaml',
    `score: ${score}`,
    `verdict: ${issueCount > 0 ? 'issues' : 'clean'}`,
    `issue_count: ${issueCount}`,
    `summary: ${summary}`,
    '```',
    '',
    `${summary} Details follow.`,
  ].join('\n');
}

function exerciseQualityAdapter(adapter, state) {
  const context = state.context;
  const run = createCycleRunContext(state);
  const cycle = 1;
  const combinedText = qualityText({
    score: 'C',
    issueCount: 3,
    summary: 'One maintainability issue and two security risks.',
  });
  const outputs = [
    {
      provider: 'unit',
      area: 'maintainability, security/risk',
      areas: ['maintainability', 'security/risk'],
      text: combinedText,
      score: 'C',
      issueCount: 3,
      synopsis: 'One maintainability issue and two security risks.',
    },
  ];

  assert.equal(adapter.findingsTitle, 'Provider outputs');
  assert.equal(adapter.synthesisFallbackDescription, 'provider summaries');

  const fanout = adapter.fanout({ runContext: run, cycle, context });
  assert.equal(fanout.label, 'quality fan-out');
  assert.equal(fanout.partial, true);
  assert.equal(fanout.adapter.artifactRoot, 'areas');
  assert.deepEqual(fanout.items, [
    {
      value: ['maintainability', 'security/risk'],
      label: 'maintainability, security/risk',
      pathSegment: 'all-areas',
    },
  ]);

  const prompt = fanout.adapter.buildPrompt({ item: ['maintainability', 'security/risk'], context });
  assert.match(prompt, /code quality audit across areas: maintainability, security\/risk/);
  assert.match(prompt, /Assess all selected areas in one provider session/);
  assert.match(prompt, /Scope: prioritize the current diff/);
  assert.match(prompt, /prior quality finding/);
  assert.deepEqual(
    fanout.adapter.buildOutput({ provider: { id: 'unit' }, item: ['maintainability', 'security/risk'], text: combinedText }),
    outputs[0],
  );

  const outputSummary = adapter.summarizeOutputs({ runContext: run, cycle, context, outputs });
  assert.equal(outputSummary.score, 'C');
  assert.equal(outputSummary.issueCount, 3);
  assert.match(outputSummary.synopsis, /3 issues across 1 provider audit/);
  assert.match(outputSummary.synopsis, /unit: maintainability, security\/risk: C, 3 issues/);

  const synthesisText = qualityText({
    score: 'D',
    issueCount: 4,
    summary: 'Synthesis found four issues.',
  });
  const cycleSummary = adapter.summarizeSynthesis({
    runContext: run,
    cycle,
    context,
    outputs,
    outputSummary,
    synthesisText,
  });
  assert.deepEqual(cycleSummary, {
    score: 'D',
    issueCount: 4,
    synopsis: 'Synthesis found four issues.',
  });

  const synthesisPrompt = adapter.buildSynthesisPrompt({ runContext: run, cycle, context, outputs });
  assert.match(synthesisPrompt, /Synthesize code quality findings for a Commands\.com quality audit\./);
  assert.equal(synthesisPrompt.includes('Areas: maintainability, security/risk'), true);
  assert.equal(synthesisPrompt.includes('Provider outputs:'), true);

  const cycleRecord = adapter.buildCycleRecord({
    runContext: run,
    cycle,
    context,
    outputs,
    fanoutFailures: [
      { provider: 'unit', item: 'all-areas', error: 'transient provider failure' },
    ],
    outputSummary,
    cycleSummary,
    synthesisProvider: 'unit-synth',
    synthesisText,
    synthesisError: '',
  });
  assert.deepEqual(cycleRecord, {
    score: 'D',
    issueCount: 4,
    synopsis: 'Synthesis found four issues.',
    providerIssueCount: 3,
    synthesisProvider: 'unit-synth',
    synthesis: synthesisText,
    synthesisError: '',
    outputs,
  });
  assert.equal('fanoutFailures' in cycleRecord, false);
  assert.equal(adapter.formatOutputs(outputs).includes('## unit / maintainability, security/risk'), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord }), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord: { issueCount: 0 } }), false);
  const untilState = testState(context.repoRoot, { options: { untilScore: 'A' } });
  const untilRun = createCycleRunContext(untilState);
  assert.equal(
    adapter.hasFixableIssues({
      runContext: untilRun,
      cycle,
      context,
      cycleRecord: { score: 'B', issueCount: 0 },
    }),
    true,
  );
  assert.equal(
    adapter.hasFixableIssues({
      runContext: untilRun,
      cycle,
      context,
      cycleRecord: { score: 'A', issueCount: 3 },
    }),
    false,
  );
  assert.deepEqual(adapter.implementation({ runContext: run, cycle, context, cycleRecord }), {
    objective: 'Improve code quality for areas: maintainability, security/risk',
    testFailureUpdates: { score: 'F' },
  });

  return cycleRecord;
}

test('runQualityCommand wires quality assessment adapter hooks through the workflow boundary', async () => {
  const cwd = '/unit/repo';
  const commandParsed = parsed([], {
    area: 'maintainability,security/risk',
    changed: 'true',
    fix: 'true',
    json: 'true',
  });
  let logger;
  const calls = {};

  const result = await captureLogs(() => {
    logger = createCommandLogger(commandParsed, { kind: 'quality' });
    return runQualityCommand(commandParsed, {
      cwd,
      logger,
      dependencies: {
        runCycleWorkflow: async (actualParsed, options) => {
          calls.workflowOptions = options;
          assert.equal(actualParsed, commandParsed);
          assert.equal(options.logger, logger);
          assert.equal(options.cwd, cwd);
          assert.equal(options.kind, 'quality');
          assert.equal(options.label, 'maintainability-security/risk');
          assert.deepEqual(options.metadata, {
            areas: ['maintainability', 'security/risk'],
          });

          const state = testState(cwd);
          state.logger = options.logger;
          calls.state = state;
          calls.adapter = options.adapter;
          state.cycles.push({
            cycle: 1,
            ...exerciseQualityAdapter(options.adapter, state),
          });
          return state;
        },
      },
    });
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(payload.type, 'quality.completed');
  assert.equal(payload.reportPath, '/unit/code-quality.md');
  assert.equal(payload.score, 'D');
  assert.equal(payload.issueCount, 4);
  assert.equal(payload.cycles[0].providerIssueCount, 3);
  assert.equal(payload.outputs.length, 1);
  const reportWrite = calls.state.store.writes.find((write) => write.name === 'code-quality.md');
  assert.equal(reportWrite.content.includes('Score: D'), true);
  assert.ok(calls.state.store.writes.some((write) => write.name === 'final-report.md'));
  assert.equal(typeof calls.workflowOptions.adapter, 'object');
  assert.equal(typeof calls.adapter.summarizeOutputs, 'function');
  assert.equal(typeof calls.adapter.summarizeSynthesis, 'function');
});

test('runQualityCommand owns area parsing and fail-on-issues result policy', async () => {
  const cwd = '/unit/repo';
  const commandParsed = parsed([], {
    area: 'maintainability, ,tests',
    'fail-on-issues': 'true',
    json: 'true',
  });
  let logger;
  const calls = {};

  const result = await captureLogs(() => {
    logger = createCommandLogger(commandParsed, { kind: 'quality' });
    return runQualityCommand(commandParsed, {
      cwd,
      logger,
      dependencies: {
        runCycleWorkflow: async (actualParsed, options) => {
          calls.workflowOptions = options;
          assert.equal(actualParsed, commandParsed);
          assert.equal(options.logger, logger);
          assert.deepEqual(options.metadata, {
            areas: ['maintainability', 'tests'],
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
            score: 'B',
            issueCount: 1,
            synopsis: 'One issue remains.',
            providerIssueCount: 1,
            synthesisProvider: 'unit',
            synthesis: '',
            synthesisError: '',
            outputs: [],
          });
          return state;
        },
      },
    });
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 1);
  assert.equal(result.commandResult.failed, true);
  assert.equal(payload.type, 'quality.completed');
  assert.equal(payload.score, 'B');
  assert.equal(payload.issueCount, 1);
  assert.equal(calls.workflowOptions.kind, 'quality');
});
