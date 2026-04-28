import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualityCommand } from '../src/quality.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

async function captureAdapter(commandParsed) {
  const calls = {};
  await runQualityCommand(commandParsed, {
    cwd: '/unit/repo',
    dependencies: {
      runCycleWorkflow: async (_actualParsed, options) => {
        calls.adapter = options.adapter;
        const fanout = options.adapter.fanout({
          runContext: { options: {}, logger: { info: () => {} }, priorFindings: '' },
          cycle: 1,
        });
        calls.auditItems = fanout.items;
        throw new Error('halt-after-resolve');
      },
    },
  }).catch((error) => {
    if (error.message !== 'halt-after-resolve') throw error;
  });
  return calls;
}

test('runQualityCommand emits a single combined audit item with array value and joined label', async () => {
  const { auditItems } = await captureAdapter(parsed([], {
    area: 'architecture,correctness',
    json: 'true',
  }));
  assert.equal(auditItems.length, 1);
  assert.deepEqual(auditItems[0].value, ['architecture', 'correctness']);
  assert.equal(auditItems[0].label, 'architecture, correctness');
  assert.equal(auditItems[0].pathSegment, 'all-areas');
});

test('runQualityCommand preserves the derived pathSegment when only one area is supplied', async () => {
  const { auditItems } = await captureAdapter(parsed([], {
    area: 'correctness',
    json: 'true',
  }));
  assert.deepEqual(auditItems[0].value, ['correctness']);
  assert.equal(auditItems[0].pathSegment, 'correctness');
});

test('runQualityCommand summarizes outputs as combined provider audits even for a single area', async () => {
  const { adapter } = await captureAdapter(parsed([], {
    area: 'correctness',
    json: 'true',
  }));
  const summary = adapter.summarizeOutputs({
    outputs: [{
      provider: 'unit',
      area: 'correctness',
      areas: ['correctness'],
      score: 'B',
      issueCount: 1,
      synopsis: 'one issue',
    }],
  });
  assert.match(summary.synopsis, /1 provider audit/);
  assert.match(summary.synopsis, /unit: correctness/);
});
