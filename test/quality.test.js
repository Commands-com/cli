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
        calls.metadataAreas = options.metadata?.areas;
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

async function captureResolvedAreas(commandParsed) {
  const { metadataAreas } = await captureResolved(commandParsed);
  return metadataAreas;
}

test('runQualityCommand collapses areas that share a normalized artifact path key', async () => {
  const areas = await captureResolvedAreas(parsed([], {
    area: 'Correctness,correctness',
    json: 'true',
  }));
  assert.deepEqual(areas, ['Correctness']);
});

test('runQualityCommand collapses mixed-punctuation duplicates that map to the same path segment', async () => {
  const areas = await captureResolvedAreas(parsed([], {
    area: 'foo bar,foo-bar,FOO__BAR',
    json: 'true',
  }));
  assert.deepEqual(areas, ['foo bar']);
});

test('runQualityCommand preserves first-seen labels for unique areas interleaved with duplicates', async () => {
  const areas = await captureResolvedAreas(parsed([], {
    area: 'architecture,correctness,Architecture,tests',
    json: 'true',
  }));
  assert.deepEqual(areas, ['architecture', 'correctness', 'tests']);
});

test('runQualityCommand collapses areas whose descriptor path segments collide via fallback', async () => {
  const areas = await captureResolvedAreas(parsed([], {
    area: 'area,!!!',
    json: 'true',
  }));
  assert.deepEqual(areas, ['area']);
});

test('runQualityCommand keeps non-colliding areas even when one falls back to the default path segment', async () => {
  const areas = await captureResolvedAreas(parsed([], {
    area: 'item,!!!',
    json: 'true',
  }));
  assert.deepEqual(areas, ['item', '!!!']);
});

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
