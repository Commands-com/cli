import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualityCommand } from '../src/quality.js';

function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

async function captureResolved(commandParsed) {
  const calls = {};
  await runQualityCommand(commandParsed, {
    cwd: '/unit/repo',
    dependencies: {
      runCycleWorkflow: async (_actualParsed, options) => {
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

test('runQualityCommand emits a single combined audit item with array value across multiple areas', async () => {
  const { auditItems } = await captureResolved(parsed([], {
    area: 'architecture,correctness',
    json: 'true',
  }));
  assert.equal(auditItems.length, 1);
  assert.deepEqual(auditItems[0].value, ['architecture', 'correctness']);
  assert.equal(auditItems[0].label, 'architecture, correctness');
  assert.equal(auditItems[0].pathSegment, 'all-areas');
});

test('runQualityCommand wraps a single area in array value while preserving its path segment', async () => {
  const { auditItems } = await captureResolved(parsed([], {
    area: 'correctness',
    json: 'true',
  }));
  assert.equal(auditItems.length, 1);
  assert.deepEqual(auditItems[0].value, ['correctness']);
  assert.equal(auditItems[0].label, 'correctness');
  assert.equal(auditItems[0].pathSegment, 'correctness');
});
