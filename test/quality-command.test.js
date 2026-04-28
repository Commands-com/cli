import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runQualityCommand } from '../src/quality.js';
import { createCycleRunContext } from '../src/cycle-state.js';
import { tempDir } from './support/cli.js';
import { captureCommandResultLogs as captureLogs } from './support/workflow-fixtures.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
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
      provider: 'mock',
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
  assert.deepEqual(
    fanout.adapter.buildOutput({ provider: { id: 'mock' }, item: ['maintainability', 'security/risk'], text: combinedText }),
    outputs[0],
  );

  const outputSummary = adapter.summarizeOutputs({ runContext: run, cycle, context, outputs });
  assert.equal(outputSummary.score, 'C');
  assert.equal(outputSummary.issueCount, 3);
  assert.match(outputSummary.synopsis, /3 issues across 1 provider audit/);
  assert.match(outputSummary.synopsis, /mock: maintainability, security\/risk: C, 3 issues/);

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
      { provider: 'mock', item: 'all-areas', error: 'transient provider failure' },
    ],
    outputSummary,
    cycleSummary,
    synthesisProvider: 'mock-synth',
    synthesisText,
    synthesisError: '',
  });
  assert.deepEqual(cycleRecord, {
    score: 'D',
    issueCount: 4,
    synopsis: 'Synthesis found four issues.',
    providerIssueCount: 3,
    synthesisProvider: 'mock-synth',
    synthesis: synthesisText,
    synthesisError: '',
    outputs,
  });
  assert.equal('fanoutFailures' in cycleRecord, false);
  assert.equal(adapter.formatOutputs(outputs).includes('## mock / maintainability, security/risk'), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord }), true);
  assert.equal(adapter.hasFixableIssues({ runContext: run, cycle, context, cycleRecord: { issueCount: 0 } }), false);
  assert.deepEqual(adapter.implementation({ runContext: run, cycle, context, cycleRecord }), {
    objective: 'Improve code quality for areas: maintainability, security/risk',
    testFailureUpdates: { score: 'F' },
  });

  return cycleRecord;
}

test('runQualityCommand wires quality assessment adapter hooks through the workflow boundary', async () => {
  const cwd = await tempDir('commands-com-quality-cmd-');
  try {
    const commandParsed = parsed([], {
      provider: 'mock',
      area: 'maintainability,security/risk',
      changed: 'true',
      json: 'true',
      test: 'true',
    });
    const calls = {};

    const result = await captureLogs(() => runQualityCommand(commandParsed, {
      cwd,
      dependencies: {
        runAssessmentCycles: async (state, adapter) => {
          calls.state = state;
          calls.adapter = adapter;
          state.cycles.push({
            cycle: 1,
            ...exerciseQualityAdapter(adapter, state),
          });
        },
      },
    }));

    const payload = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(payload.type, 'quality.completed');
    assert.match(payload.reportPath, /code-quality\.md$/);
    assert.equal(payload.score, 'D');
    assert.equal(payload.issueCount, 4);
    assert.equal(payload.cycles[0].providerIssueCount, 3);
    assert.equal(payload.outputs.length, 1);
    assert.equal(calls.state.kind, 'quality');
    assert.deepEqual(calls.state.options.areas ?? ['maintainability', 'security/risk'], ['maintainability', 'security/risk']);
    assert.equal(typeof calls.adapter.summarizeOutputs, 'function');
    assert.equal(typeof calls.adapter.summarizeSynthesis, 'function');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand derives audit item shape from area count', async () => {
  const cases = [
    {
      label: 'single area preserves derived pathSegment',
      flags: { area: 'correctness' },
      expectedItems: [{ value: ['correctness'], label: 'correctness', pathSegment: 'correctness' }],
    },
    {
      label: 'multiple areas collapse to all-areas pathSegment',
      flags: { area: 'architecture,correctness' },
      expectedItems: [{
        value: ['architecture', 'correctness'],
        label: 'architecture, correctness',
        pathSegment: 'all-areas',
      }],
    },
  ];

  for (const { label, flags, expectedItems } of cases) {
    const cwd = await tempDir('commands-com-quality-items-');
    try {
      let captured;
      await captureLogs(() => runQualityCommand(
        parsed([], { provider: 'mock', json: 'true', test: 'true', ...flags }),
        {
          cwd,
          dependencies: {
            runAssessmentCycles: async (state, adapter) => {
              const fanout = adapter.fanout({
                runContext: createCycleRunContext(state),
                cycle: 1,
                context: state.context,
              });
              captured = fanout.items;
              state.cycles.push({
                cycle: 1,
                score: 'A',
                issueCount: 0,
                synopsis: 'no issues',
                providerIssueCount: 0,
                synthesisProvider: 'mock',
                synthesis: '',
                synthesisError: '',
                outputs: [],
              });
            },
          },
        },
      ));
      assert.deepEqual(captured, expectedItems, label);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test('runQualityCommand summarizes a single-area output as a combined provider audit', async () => {
  const cwd = await tempDir('commands-com-quality-summary-');
  try {
    /** @type {import('../src/assessment-cycle.js').AssessmentCycleSummary | undefined} */
    let summary;
    await captureLogs(() => runQualityCommand(
      parsed([], { provider: 'mock', area: 'correctness', json: 'true', test: 'true' }),
      {
        cwd,
        dependencies: {
          runAssessmentCycles: async (state, adapter) => {
            summary = adapter.summarizeOutputs({
              runContext: createCycleRunContext(state),
              cycle: 1,
              context: state.context,
              outputs: [{
                provider: 'mock',
                area: 'correctness',
                areas: ['correctness'],
                text: '',
                score: 'B',
                issueCount: 1,
                synopsis: 'one issue',
              }],
            });
            state.cycles.push({
              cycle: 1,
              score: 'A',
              issueCount: 0,
              synopsis: 'no issues',
              providerIssueCount: 0,
              synthesisProvider: 'mock',
              synthesis: '',
              synthesisError: '',
              outputs: [],
            });
          },
        },
      },
    ));
    assert.ok(summary);
    assert.match(summary.synopsis || '', /1 provider audit/);
    assert.match(summary.synopsis || '', /mock: correctness/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
