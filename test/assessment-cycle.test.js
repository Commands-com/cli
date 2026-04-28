import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAssessmentCycles } from '../src/assessment-cycle.js';
import { createCycleState } from '../src/cycle-state.js';
import { runCycleWorkflow } from '../src/cycle-workflow.js';
import { tempDir } from './support/cli.js';
import { memoryStore } from './support/memory-store.js';
import { emitCodexMessage, writeFakeProvider } from './support/fake-provider.js';

function flags(entries = []) { return new Map(entries); }

function silentLogger() { return { info() {} }; }

function uniqueSorted(values) { return [...new Set(values)].sort(); }

const CYCLE_METADATA_FIELDS = Object.freeze(
  'changed fix worktree baseRef allowDirty keepWorktree maxCycles maxImplementers stallCycles resume untilScore parallel serial providerRetries testCommand timeoutMs json failOnIssues'.split(' '),
);

function testState(cwd, {
  providers = [{ id: 'mock' }],
  primaryProvider = providers[0],
  fix = false,
  maxCycles = 1,
  options = {},
} = {}) {
  return createCycleState({
    kind: 'fake',
    store: memoryStore({
      dir: path.join(cwd, 'store'),
      valueKey: 'content',
      stringifyWrites: true,
      writeJson: false,
    }),
    workspace: { mode: 'current', cwd },
    context: { repoRoot: cwd, branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      providers,
      primaryProvider,
      providerIds: providers.map((provider) => provider.id),
      model: '',
      changed: false,
      fix,
      worktree: false,
      keepWorktree: false,
      allowDirty: false,
      serial: true,
      parallel: false,
      failOnIssues: false,
      json: true,
      timeoutMs: 5_000,
      maxCycles,
      maxImplementers: 1,
      providerRetries: 0,
      testCommand: '',
      ...options,
    },
  });
}

function synthesisPrompt(issueCount) {
  return [
    'Synthesize fake assessment findings.',
    '',
    `<!-- commands-com-prompt-intent: ${JSON.stringify({
      kind: 'review-synthesis',
      synthesisIssueCount: issueCount,
    })} -->`,
  ].join('\n');
}

test('runCycleWorkflow persists resolved cycle option metadata', async () => {
  const cwd = await tempDir();
  try {
    const state = await runCycleWorkflow({
      positionals: ['metadata projection'],
      flags: flags([
        ['provider', 'mock'],
        ['changed', 'true'],
        ['fix', 'true'],
        ['keep-worktree', 'true'],
        ['allow-dirty', 'true'],
        ['fail-on-issues', 'true'],
        ['json', 'true'],
        ['max-cycles', '2'],
        ['max-implementers', '4'],
        ['retries', '0'],
        ['timeout-ms', '1234'],
        ['test', 'npm test'],
        ['serial', 'true'],
        ['parallel', 'true'],
      ]),
    }, {
      cwd,
      kind: 'review',
      label: 'metadata',
      logger: silentLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: async () => {} },
    });

    const runsRoot = path.join(cwd, '.commands-com', 'runs');
    const runIds = await fs.readdir(runsRoot);
    assert.equal(runIds.length, 1);

    const metadata = JSON.parse(await fs.readFile(
      path.join(runsRoot, runIds[0], 'metadata.json'),
      'utf8',
    ));
    assert.deepEqual(
      uniqueSorted(Object.keys(metadata)),
      uniqueSorted([
        'kind',
        'provider',
        'providers',
        'synthesizerProvider',
        'implementerProvider',
        'model',
        'workspace',
        'createdAt',
        ...CYCLE_METADATA_FIELDS,
      ]),
    );
    assert.deepEqual(
      Object.fromEntries(CYCLE_METADATA_FIELDS.map((field) => [field, metadata[field]])),
      Object.fromEntries(CYCLE_METADATA_FIELDS.map((field) => [field, state.options[field]])),
    );
    assert.equal(metadata.json, true);
    assert.equal(metadata.serial, true);
    assert.equal(metadata.parallel, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

/** @param {any} options @returns {any} */
function createFakeAdapter({
  outputIssueCount = 0,
  synthesisIssueCount = outputIssueCount,
  includeOptionalHooks = false,
  calls = [],
  implementation = () => ({ objective: 'Fix fake assessment issues' }),
  hasFixableIssues = ({ cycleRecord }) => cycleRecord.issueCount > 0,
  summarizeOutputs,
  summarizeSynthesis,
} = {}) {
  const adapter = {
    findingsTitle: 'Fake provider outputs',
    synthesisFallbackDescription: 'fake provider summaries',
    fanout({ cycle }) {
      return {
        items: [{ value: 'fake-area', label: 'Fake area', pathSegment: 'fake-area' }],
        label: 'fake fan-out',
        adapter: {
          artifactRoot: 'fake',
          buildPrompt: ({ item }) => [
            `Assess ${item} in cycle ${cycle}.`,
            '<!-- commands-com-prompt-intent: {"kind":"review"} -->',
          ].join('\n'),
          buildOutput: ({ provider, item, text }) => ({ provider: provider.id, item, text }),
        },
      };
    },
    summarizeOutputs(args) {
      if (summarizeOutputs) return summarizeOutputs(args);
      calls.push({ hook: 'summarizeOutputs', cycle: args.cycle, outputs: args.outputs });
      return {
        source: 'outputs',
        issueCount: outputIssueCount,
        synopsis: `output issue count ${outputIssueCount}`,
      };
    },
    summarizeSynthesis(args) {
      if (summarizeSynthesis) return summarizeSynthesis(args);
      calls.push({
        hook: 'summarizeSynthesis',
        cycle: args.cycle,
        outputs: args.outputs,
        synthesisText: args.synthesisText,
        outputSummary: args.outputSummary,
      });
      return {
        source: 'synthesis',
        issueCount: synthesisIssueCount,
        synopsis: `synthesis issue count ${synthesisIssueCount}`,
      };
    },
    buildSynthesisPrompt() {
      return synthesisPrompt(synthesisIssueCount);
    },
    buildCycleRecord({
      outputs,
      outputSummary,
      cycleSummary,
      synthesisProvider,
      synthesisText,
      synthesisError,
    }) {
      return {
        ...cycleSummary,
        outputIssueCount: outputSummary.issueCount,
        usedOutputSummary: outputSummary === cycleSummary,
        synthesisProvider,
        synthesis: synthesisText,
        synthesisError,
        outputs,
      };
    },
    formatOutputs(outputs) {
      return outputs.map((output) => `## ${output.provider} / ${output.item}\n\n${output.text}`).join('\n\n');
    },
    hasFixableIssues(args) {
      calls.push({ hook: 'hasFixableIssues', cycleRecord: args.cycleRecord, args });
      return hasFixableIssues(args);
    },
    implementation(args) {
      calls.push({ hook: 'implementation', args });
      return implementation(args);
    },
  };

  if (includeOptionalHooks) {
    adapter.logCycleStart = (args) => {
      calls.push({ hook: 'logCycleStart', args });
    };
    adapter.afterCycle = (args) => {
      calls.push({ hook: 'afterCycle', args });
    };
  }

  return adapter;
}

test('runAssessmentCycles stops after a successful clean cycle without implementation', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd, { fix: true, maxCycles: 3 });
    const adapter = createFakeAdapter({
      outputIssueCount: 0,
      synthesisIssueCount: 0,
      calls,
    });

    await runAssessmentCycles(state, adapter);

    assert.equal(state.cycles.length, 1);
    assert.equal(state.cycles[0].source, 'outputs');
    assert.equal(state.cycles[0].issueCount, 0);
    assert.deepEqual(state.cycles[0].fanoutFailures, []);
    assert.equal(state.cycles[0].synthesisProvider, '');
    assert.equal(state.cycles[0].synthesis, '');
    assert.equal(state.cycles[0].implementation, undefined);
    assert.equal(calls.some((call) => call.hook === 'implementation'), false);
    assert.deepEqual(
      state.store.writes.map((write) => write.name),
      [
        'prompts/cycle-1-mock-fake-area.md',
        'cycle-1/fake/mock/fake-area.md',
      ],
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles rejects adapter fanout options that are not an object', async () => {
  const cwd = await tempDir();
  try {
    const state = testState(cwd);
    const adapter = createFakeAdapter();
    adapter.fanout = () => null;

    await assert.rejects(
      runAssessmentCycles(state, adapter),
      /runAssessmentCycles requires adapter\.fanout to return options object/,
    );
    assert.deepEqual(state.store.writes, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles owns cycle fan-out failure artifact writing', async () => {
  const cwd = await tempDir();
  try {
    const state = testState(cwd, {
      providers: [{ id: 'unsupported-test-provider' }],
    });
    const adapter = createFakeAdapter();
    const originalFanout = adapter.fanout.bind(adapter);
    const failureCalls = [];
    adapter.fanout = (args) => {
      const options = originalFanout(args);
      return {
        ...options,
        writeFailureArtifact: () => {
          failureCalls.push('options');
        },
        adapter: {
          ...options.adapter,
          writeFailureArtifact: () => {
            failureCalls.push('adapter');
          },
        },
      };
    };

    await assert.rejects(
      runAssessmentCycles(state, adapter),
      /unsupported provider: unsupported-test-provider/,
    );

    const writesByName = Object.fromEntries(state.store.writes.map((write) => [write.name, write.content]));
    assert.deepEqual(failureCalls, []);
    assert.match(
      writesByName['prompts/cycle-1-unsupported-test-provider-fake-area.md'],
      /Assess fake-area in cycle 1/,
    );
    assert.equal(
      writesByName['cycle-1/fake/unsupported-test-provider/fake-area.error.md'],
      'unsupported provider: unsupported-test-provider',
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles hands fixable cycle records to implementation', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const objective = 'Implement fake assessment handoff';
    const state = testState(cwd, { fix: true, maxCycles: 1 });
    const adapter = createFakeAdapter({
      outputIssueCount: 1,
      synthesisIssueCount: 1,
      calls,
      implementation: () => ({
        objective,
        testFailureUpdates: { score: 'F' },
      }),
    });

    await runAssessmentCycles(state, adapter);

    const cycleRecord = state.cycles[0];
    const implementationCall = calls.find((call) => call.hook === 'implementation');
    const planPrompt = state.store.writes.find((write) => write.name === 'prompts/cycle-1-implementation-plan.md');

    assert.equal(state.cycles.length, 1);
    assert.equal(implementationCall.args.cycleRecord, cycleRecord);
    assert.equal(implementationCall.args.runContext.kind, 'fake');
    assert.match(implementationCall.args.runContext.priorFindings, /^## Synthesis/);
    assert.match(implementationCall.args.runContext.priorFindings, /## Fake provider outputs/);
    assert.equal(Object.hasOwn(implementationCall.args, 'state'), false);
    assert.match(planPrompt.content, new RegExp(objective));
    assert.match(planPrompt.content, /## Fake provider outputs/);
    assert.match(cycleRecord.implementationPlan, /"id": "task-1"/);
    assert.deepEqual(cycleRecord.implementationTasks.map((task) => task.id), ['task-1']);
    assert.deepEqual(cycleRecord.implementationBatches, [['task-1']]);
    assert.equal(cycleRecord.implementations[0].provider, 'mock');
    assert.match(cycleRecord.implementation, /Mock implementer/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles stops after an explicit empty implementation plan converges the cycle', async () => {
  const cwd = await tempDir();
  try {
    const providerPath = await writeFakeProvider(path.join(cwd, 'bin'), 'codex', [
      "const fs = require('node:fs');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "if (prompt.includes('\"kind\":\"implementation-plan\"')) {",
      `  ${emitCodexMessage('```json\\n{"tasks":[]}\\n```')}`,
      '  process.exit(0);',
      '}',
      "if (prompt.includes('\"kind\":\"implementation-task\"')) {",
      "  console.error('implementation task should not run');",
      '  process.exit(9);',
      '}',
      emitCodexMessage([
        '```yaml',
        'score: B',
        'verdict: issues',
        'major_issue_count: 1',
        'summary: One gated issue remains.',
        '```',
      ].join('\n')),
    ]);
    const state = testState(cwd, {
      providers: [{ id: 'codex', command: providerPath }],
      fix: true,
      maxCycles: 3,
    });
    const adapter = createFakeAdapter({ outputIssueCount: 1 });

    await runAssessmentCycles(state, adapter);

    assert.equal(state.cycles.length, 1);
    assert.equal(state.cycles[0].score, 'A');
    assert.equal(state.cycles[0].issueCount, 0);
    assert.equal(state.cycles[0].synopsis, 'No actionable implementation tasks were returned.');
    assert.deepEqual(state.cycles[0].implementationTasks, []);
    assert.deepEqual(state.cycles[0].implementationBatches, []);
    assert.equal(state.cycles[0].implementation, 'No implementation tasks were returned.');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles records partial implementations before rethrowing implementation failure', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = await tempDir();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const provider = { id: 'claude', command: path.join(cwd, 'claude') };
  const payload = (text) => JSON.stringify({ text });
  const plan = ['```json', JSON.stringify({ tasks: [
    { id: 'task-one', title: 'First completed batch', files: ['src/shared.txt'], instructions: 'Complete the first batch.' },
    { id: 'task-two', title: 'Second failing batch', files: ['src/shared.txt'], instructions: 'Fail the second batch.' },
  ] }), '```'].join('\n');
  await fs.writeFile(provider.command, [
    '#!/bin/sh',
    'prompt=$(cat)',
    `if printf '%s' "$prompt" | grep -q '"kind":"implementation-plan"'; then printf '%s\\n' '${payload(plan)}'; exit 0; fi`,
    `if printf '%s' "$prompt" | grep -q 'First completed batch'; then printf '%s\\n' '${payload('batch one implementation complete')}'; exit 0; fi`,
    'if printf \'%s\' "$prompt" | grep -q \'Second failing batch\'; then echo \'batch two failed intentionally\' >&2; exit 9; fi',
    `printf '%s\\n' '${payload('clean assessment output')}'`,
  ].join('\n'), 'utf8');
  await fs.chmod(provider.command, 0o755);
  const state = testState(cwd, {
    providers: [provider],
    primaryProvider: provider,
    fix: true,
    maxCycles: 1,
    options: {
      maxImplementers: 2,
      serial: false,
      testCommand: 'node -e "process.stdout.write(\'partial cycle validation failed\'); process.exit(6)"',
    },
  });
  state.store.writeJson = async function writeJson(name, content) {
    this.writes.push({ name, content });
    return path.join(this.dir, name);
  };

  await assert.rejects(
    runAssessmentCycles(state, createFakeAdapter({ outputIssueCount: 1, synthesisIssueCount: 1 })),
    /fake implementation batch 2 failed:.*batch two failed intentionally/,
  );
  const cycleRecord = state.cycles[0];
  const runState = state.store.writes.filter((write) => write.name === 'run-state.json').at(-1).content;
  assert.deepEqual(cycleRecord.implementationBatches, [['task-one'], ['task-two']]);
  assert.deepEqual(cycleRecord.implementations.map((item) => item.task.id), ['task-one']);
  assert.match(cycleRecord.implementation, /batch one implementation complete/);
  assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 6 });
  assert.match(state.priorFindings, /partial cycle validation failed/);
  assert.deepEqual(runState.cycles[0].implementations.map((item) => item.task.id), ['task-one']);
  assert.deepEqual(runState.cycles[0].test, { ok: false, exitCode: 6 });
});
test('runAssessmentCycles refreshes lifecycle hook context after recording the cycle', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd, { fix: false });
    const initialContext = state.context;
    const adapter = createFakeAdapter({ includeOptionalHooks: true, calls });

    await runAssessmentCycles(state, adapter);

    const startCall = calls.find((call) => call.hook === 'logCycleStart');
    const afterCall = calls.find((call) => call.hook === 'afterCycle');

    assert.equal(startCall.args.context, initialContext);
    assert.equal(startCall.args.runContext.context, startCall.args.context);
    assert.equal(startCall.args.runContext.priorFindings, '');
    assert.equal(afterCall.args.context, startCall.args.context);
    assert.equal(afterCall.args.runContext.context, afterCall.args.context);
    assert.notEqual(afterCall.args.runContext, startCall.args.runContext);
    assert.equal(afterCall.args.runContext.priorFindings, state.priorFindings);
    assert.match(afterCall.args.runContext.priorFindings, /^## Synthesis/);
    assert.equal(afterCall.args.cycleRecord, state.cycles[0]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles uses post-implementation context for the next cycle', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd, { fix: true, maxCycles: 2 });
    const initialContext = state.context;
    const adapter = createFakeAdapter({
      outputIssueCount: 1,
      synthesisIssueCount: 1,
      includeOptionalHooks: true,
      calls,
      hasFixableIssues: ({ cycleRecord }) => cycleRecord.cycle === 1,
    });

    await runAssessmentCycles(state, adapter);

    const startCalls = calls.filter((call) => call.hook === 'logCycleStart');
    const fixabilityCalls = calls.filter((call) => call.hook === 'hasFixableIssues');
    const implementationCalls = calls.filter((call) => call.hook === 'implementation');

    assert.equal(state.cycles.length, 2);
    assert.equal(startCalls.length, 2);
    assert.equal(startCalls[0].args.context, initialContext);
    assert.equal(fixabilityCalls.length, 2);
    assert.equal(fixabilityCalls[0].args.context, initialContext);
    assert.equal(fixabilityCalls[0].args.runContext.context, initialContext);
    assert.match(fixabilityCalls[0].args.runContext.priorFindings, /^## Synthesis/);
    assert.equal(implementationCalls.length, 1);
    assert.equal(implementationCalls[0].args.context, fixabilityCalls[0].args.context);
    assert.equal(implementationCalls[0].args.runContext, fixabilityCalls[0].args.runContext);
    assert.notEqual(startCalls[1].args.context, fixabilityCalls[0].args.context);
    assert.notEqual(startCalls[1].args.context, initialContext);
    assert.equal(startCalls[1].args.context, state.context);
    assert.equal(startCalls[1].args.runContext.context, state.context);
    assert.equal(startCalls[1].args.context.isGit, false);
    assert.match(startCalls[1].args.runContext.priorFindings, /^## Synthesis/);
    assert.equal(fixabilityCalls[1].args.context, state.context);
    assert.match(state.cycles[0].implementation, /Mock implementer/);
    assert.equal(state.cycles[1].implementation, undefined);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles stops repeated progress unless stall detection is disabled', async () => {
  for (const item of [
    { stallCycles: 1, cycles: 2, stopReason: 'stalled', implementations: 1 },
    { stallCycles: 0, cycles: 3, stopReason: '', implementations: 3 },
  ]) {
    const cwd = await tempDir();
    try {
      const calls = [];
      const state = testState(cwd, { fix: true, maxCycles: 3, options: { stallCycles: item.stallCycles } });
      const adapter = createFakeAdapter({
        outputIssueCount: 2,
        synthesisIssueCount: 2,
        calls,
        hasFixableIssues: () => true,
      });

      await runAssessmentCycles(state, adapter);

      assert.equal(state.cycles.length, item.cycles);
      assert.equal(state.stopReason, item.stopReason);
      assert.equal(calls.filter((call) => call.hook === 'implementation').length, item.implementations);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test('runAssessmentCycles supports optional start and after-cycle hooks', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const stateWithHooks = testState(cwd, { fix: false });
    const adapterWithHooks = createFakeAdapter({ includeOptionalHooks: true, calls });

    await runAssessmentCycles(stateWithHooks, adapterWithHooks);

    const hookCalls = calls.filter((call) => ['logCycleStart', 'afterCycle'].includes(call.hook));
    assert.deepEqual(hookCalls.map((call) => call.hook), ['logCycleStart', 'afterCycle']);
    assert.equal(hookCalls[0].args.cycle, 1);
    assert.equal(hookCalls[0].args.runContext.kind, 'fake');
    assert.equal(hookCalls[0].args.runContext.context, stateWithHooks.context);
    assert.equal(hookCalls[0].args.runContext.options, stateWithHooks.options);
    assert.equal(Object.hasOwn(hookCalls[0].args, 'state'), false);
    assert.equal(hookCalls[1].args.cycleRecord, stateWithHooks.cycles[0]);
    assert.match(hookCalls[1].args.runContext.priorFindings, /^## Synthesis/);
    assert.equal(hookCalls[1].args.outputSummary.source, 'outputs');
    assert.equal(hookCalls[1].args.cycleSummary.source, 'outputs');

    const stateWithoutHooks = testState(cwd, { fix: false });
    await runAssessmentCycles(stateWithoutHooks, createFakeAdapter());
    assert.equal(stateWithoutHooks.cycles.length, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
