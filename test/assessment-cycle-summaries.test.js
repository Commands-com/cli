import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAssessmentCycles } from '../src/assessment-cycle.js';
import { createCycleState } from '../src/cycle-state.js';
import { tempDir } from './support/cli.js';
import { memoryStore } from './support/memory-store.js';

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

async function writeGenericProviderText(binDir, commandName, text) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, commandName);
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ text })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
  return provider;
}

/** @param {any} options @returns {any} */
function createFakeAdapter({
  outputIssueCount = 0,
  synthesisIssueCount = outputIssueCount,
  items = ['fake-area'],
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
        items: items.map((item) => ({
          value: item,
          label: String(item),
          pathSegment: String(item),
        })),
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

test('runAssessmentCycles calls output and synthesis summary hooks separately for multiple outputs', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd);
    const adapter = createFakeAdapter({
      outputIssueCount: 3,
      synthesisIssueCount: 0,
      items: ['fake-area', 'second-area'],
      calls,
    });

    await runAssessmentCycles(state, adapter);

    const summaryCalls = calls.filter((call) => ['summarizeOutputs', 'summarizeSynthesis'].includes(call.hook));
    assert.deepEqual(summaryCalls.map((call) => call.hook), ['summarizeOutputs', 'summarizeSynthesis']);
    assert.equal(summaryCalls[0].outputs.length, 2);
    assert.equal(summaryCalls[0].outputs[0].provider, 'mock');
    assert.equal(summaryCalls[1].outputSummary.issueCount, 3);
    assert.match(summaryCalls[1].synthesisText, /major_issue_count: 0/);
    assert.equal(state.cycles[0].source, 'synthesis');
    assert.equal(state.cycles[0].usedOutputSummary, false);
    assert.equal(state.cycles[0].issueCount, 0);
    assert.equal(state.cycles[0].outputIssueCount, 3);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles skips synthesis for a single assessment output', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd);
    const adapter = createFakeAdapter({
      outputIssueCount: 2,
      synthesisIssueCount: 0,
      calls,
    });

    await runAssessmentCycles(state, adapter);

    const summaryCalls = calls.filter((call) => ['summarizeOutputs', 'summarizeSynthesis'].includes(call.hook));
    assert.deepEqual(summaryCalls.map((call) => call.hook), ['summarizeOutputs']);
    assert.equal(state.cycles[0].source, 'outputs');
    assert.equal(state.cycles[0].usedOutputSummary, true);
    assert.equal(state.cycles[0].issueCount, 2);
    assert.equal(state.cycles[0].synthesisProvider, '');
    assert.equal(state.cycles[0].synthesis, '');
    assert.equal(state.cycles[0].synthesisError, '');
    assert.match(state.priorFindings, /^## Synthesis\n\(none\)/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles summarizes outputs once for each completed fan-out', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd, { fix: true, maxCycles: 2 });
    const adapter = createFakeAdapter({
      outputIssueCount: 1,
      synthesisIssueCount: 1,
      items: ['fake-area', 'second-area'],
      calls,
    });

    await runAssessmentCycles(state, adapter);

    const summaryCalls = calls.filter((call) => ['summarizeOutputs', 'summarizeSynthesis'].includes(call.hook));
    const outputSummaries = summaryCalls.filter((call) => call.hook === 'summarizeOutputs');
    assert.deepEqual(summaryCalls.map((call) => `${call.cycle}:${call.hook}`), [
      '1:summarizeOutputs',
      '1:summarizeSynthesis',
      '2:summarizeOutputs',
      '2:summarizeSynthesis',
    ]);
    assert.equal(outputSummaries.length, 2);
    assert.deepEqual(outputSummaries.map((call) => call.outputs.length), [2, 2]);
    assert.deepEqual(outputSummaries.map((call) => call.outputs[0].provider), ['mock', 'mock']);
    assert.equal(state.cycles.length, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles falls back to provider output summary when synthesis fails', async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const state = testState(cwd, {
      providers: [{ id: 'mock' }],
      primaryProvider: { id: 'codex', command: path.join(cwd, 'missing-codex') },
    });
    const adapter = createFakeAdapter({
      outputIssueCount: 0,
      synthesisIssueCount: 1,
      items: ['fake-area', 'second-area'],
      calls,
      summarizeOutputs: () => {
        calls.push({ hook: 'summarizeOutputs' });
        return {
          source: 'outputs',
          issueCount: 0,
          synopsis: 'output issue count 0',
        };
      },
      summarizeSynthesis: () => {
        assert.fail('summarizeSynthesis should not be called when synthesis fails');
      },
    });

    await runAssessmentCycles(state, adapter);

    assert.equal(state.cycles.length, 1);
    assert.equal(state.cycles[0].source, 'outputs');
    assert.equal(state.cycles[0].issueCount, 0);
    assert.equal(state.cycles[0].outputIssueCount, 0);
    assert.equal(state.cycles[0].usedOutputSummary, true);
    assert.equal(state.cycles[0].synthesisProvider, 'codex');
    assert.equal(state.cycles[0].synthesis, '');
    assert.match(state.cycles[0].synthesisError, /missing-codex|ENOENT/i);
    assert.match(state.priorFindings, /^## Synthesis\nSynthesis failed:/);
    assert.match(state.priorFindings, /## Fake provider outputs/);
    assert.deepEqual(
      calls.filter((call) => call.hook.startsWith('summarize')).map((call) => call.hook),
      ['summarizeOutputs'],
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentCycles falls back to provider output summary when synthesis output is blank', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const binDir = path.join(cwd, 'bin');
    const providerCommand = await writeGenericProviderText(binDir, 'claude', '');
    const state = testState(cwd, {
      primaryProvider: { id: 'claude', command: providerCommand },
    });
    const adapter = createFakeAdapter({
      outputIssueCount: 2,
      synthesisIssueCount: 0,
      items: ['fake-area', 'second-area'],
      calls,
    });

    await runAssessmentCycles(state, adapter);

    assert.equal(state.cycles.length, 1);
    assert.equal(state.cycles[0].source, 'outputs');
    assert.equal(state.cycles[0].issueCount, 2);
    assert.equal(state.cycles[0].outputIssueCount, 2);
    assert.equal(state.cycles[0].usedOutputSummary, true);
    assert.equal(state.cycles[0].synthesisProvider, 'claude');
    assert.equal(state.cycles[0].synthesis, '');
    assert.equal(state.cycles[0].synthesisError, '');
    assert.deepEqual(
      calls.filter((call) => call.hook.startsWith('summarize')).map((call) => call.hook),
      ['summarizeOutputs'],
    );
    assert.match(state.priorFindings, /^## Synthesis\n\(none\)/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
