import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRun } from '../src/run-store.js';
import { runRunsCommand } from '../src/runs.js';
import { tempDir } from './support/cli.js';

async function writeRunMetadata(cwd, runId, metadata = {}) {
  const dir = path.join(cwd, '.commands-com', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    kind: 'review',
    ...metadata,
  }), 'utf8');
}

function captureLogger({ jsonMode = true } = {}) {
  const records = [];
  const lines = [];
  return {
    records,
    lines,
    jsonMode,
    json(value) {
      records.push(value);
    },
    line(value) {
      lines.push(value);
    },
  };
}

async function runRunsWithLogger(cwd, positionals, { flags = new Map(), jsonMode = true } = {}) {
  const logger = captureLogger({ jsonMode });
  await runRunsCommand({ positionals, flags }, { cwd, logger });
  return logger;
}

async function runRunsJson(cwd, positionals, flags) {
  const logger = await runRunsWithLogger(cwd, positionals, { flags });
  return logger.records[0];
}

function runRuns(cwd, positionals) {
  return runRunsCommand({ positionals, flags: new Map() }, { cwd, logger: captureLogger() });
}

test('listRuns writes sorted JSON output and excludes invalid run directories', async () => {
  const cwd = await tempDir();
  try {
    const olderRunId = '20260101-010101-review-alpha-111111';
    const middleRunId = '20260101-020202-quality-beta-222222';
    const newerRunId = '20260102-010101-review-gamma-333333';
    await writeRunMetadata(cwd, olderRunId, {
      objective: 'older',
      provider: 'codex',
      createdAt: '2026-01-01T01:01:01.000Z',
    });
    await writeRunMetadata(cwd, newerRunId, {
      objective: 'newer',
      provider: 'mock',
      createdAt: '2026-01-02T01:01:01.000Z',
    });
    await writeRunMetadata(cwd, middleRunId, {
      kind: 'quality',
      objective: 'middle',
      provider: 'claude',
      createdAt: '2026-01-01T02:02:02.000Z',
    });
    await writeRunMetadata(cwd, 'not-a-run', { objective: 'invalid' });
    await writeRunMetadata(cwd, '20260102-010101-review-gamma-zzzzzz', { objective: 'invalid' });

    const payload = await runRunsJson(cwd, ['list']);

    assert.equal(payload.type, 'runs.list');
    assert.deepEqual(payload.runs.map((run) => run.runId), [
      newerRunId,
      middleRunId,
      olderRunId,
    ]);
    assert.deepEqual(payload.runs.map((run) => run.objective), ['newer', 'middle', 'older']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns orders same-second runs by metadata.createdAt, not run ID label/suffix', async () => {
  const cwd = await tempDir();
  try {
    // Run IDs only timestamp to seconds; both share 20260101-010101. Pure string
    // sort would put bravo-ffffff first, but createdAt says alpha-aaaaaa is newer.
    const earlierRunId = '20260101-010101-review-bravo-ffffff';
    const laterRunId = '20260101-010101-review-alpha-aaaaaa';
    await writeRunMetadata(cwd, earlierRunId, {
      objective: 'earlier',
      createdAt: '2026-01-01T01:01:01.001Z',
    });
    await writeRunMetadata(cwd, laterRunId, {
      objective: 'later',
      createdAt: '2026-01-01T01:01:01.999Z',
    });

    const payload = await runRunsJson(cwd, ['list']);

    assert.deepEqual(payload.runs.map((run) => run.runId), [laterRunId, earlierRunId]);
    assert.deepEqual(payload.runs.map((run) => run.objective), ['later', 'earlier']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns honors --limit after sorting', async () => {
  const cwd = await tempDir();
  try {
    await writeRunMetadata(cwd, '20260101-010101-review-alpha-111111');
    await writeRunMetadata(cwd, '20260102-010101-review-beta-222222');
    await writeRunMetadata(cwd, '20260103-010101-review-gamma-333333');

    const payload = await runRunsJson(cwd, ['list'], new Map([['limit', '2']]));

    assert.deepEqual(payload.runs.map((run) => run.runId), [
      '20260103-010101-review-gamma-333333',
      '20260102-010101-review-beta-222222',
    ]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns writes human output rows', async () => {
  const cwd = await tempDir();
  try {
    const olderRunId = '20260101-010101-review-alpha-111111';
    const newerRunId = '20260102-010101-quality-beta-222222';
    await writeRunMetadata(cwd, olderRunId, {
      objective: 'audit architecture',
      provider: 'codex',
    });
    await writeRunMetadata(cwd, newerRunId, {
      kind: 'quality',
      objective: 'audit correctness',
      provider: 'mock',
    });

    const logger = await runRunsWithLogger(cwd, ['list'], { jsonMode: false });

    assert.deepEqual(logger.records, []);
    assert.deepEqual(logger.lines, [
      `${newerRunId}  quality  mock  audit correctness`,
      `${olderRunId}  review  codex  audit architecture`,
    ]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns renders runs missing metadata.json as empty rows', async () => {
  const cwd = await tempDir();
  try {
    const runId = '20260101-010101-review-no-meta-444444';
    await fs.mkdir(path.join(cwd, '.commands-com', 'runs', runId), { recursive: true });

    const payload = await runRunsJson(cwd, ['list']);
    const logger = await runRunsWithLogger(cwd, ['list'], { jsonMode: false });

    assert.equal(payload.runs.length, 1);
    const run = /** @type {any} */ (payload.runs[0]);
    assert.deepEqual(run, {
      runId,
      dir: path.join(cwd, '.commands-com', 'runs', runId),
      kind: '',
      objective: '',
      provider: '',
      createdAt: '',
    });
    assert.equal(Reflect.get(run, 'metadataError'), undefined);
    assert.deepEqual(logger.lines, [runId]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns surfaces corrupt metadata.json as a marked error row', async () => {
  const cwd = await tempDir();
  try {
    const corruptRunId = '20260101-010101-review-corrupt-555555';
    const healthyRunId = '20260102-020202-review-healthy-666666';
    await writeRunMetadata(cwd, healthyRunId, {
      objective: 'healthy',
      provider: 'mock',
    });
    const corruptDir = path.join(cwd, '.commands-com', 'runs', corruptRunId);
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, 'metadata.json'), '{not json', 'utf8');

    const payload = await runRunsJson(cwd, ['list']);
    const corruptRow = payload.runs.find((run) => run.runId === corruptRunId);
    const healthyRow = payload.runs.find((run) => run.runId === healthyRunId);

    assert.ok(corruptRow, 'corrupt run should appear in list');
    assert.ok(typeof corruptRow.metadataError === 'string' && corruptRow.metadataError.length > 0);
    assert.equal(corruptRow.kind, '');
    assert.equal(corruptRow.provider, '');
    assert.equal(corruptRow.objective, '');
    assert.equal(healthyRow.metadataError, undefined);
    assert.equal(healthyRow.provider, 'mock');

    const logger = await runRunsWithLogger(cwd, ['list'], { jsonMode: false });
    const corruptLine = logger.lines.find((line) => line.startsWith(corruptRunId));
    assert.ok(corruptLine, 'corrupt run should render a row');
    assert.match(corruptLine, /\[metadata error:/);
    const healthyLine = logger.lines.find((line) => line.startsWith(healthyRunId));
    assert.ok(healthyLine && !healthyLine.includes('[metadata error:'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns surfaces unreadable metadata.json as a marked error row', async () => {
  const cwd = await tempDir();
  try {
    const unreadableRunId = '20260101-010101-review-unreadable-777777';
    const dir = path.join(cwd, '.commands-com', 'runs', unreadableRunId);
    await fs.mkdir(path.join(dir, 'metadata.json'), { recursive: true });

    const payload = await runRunsJson(cwd, ['list']);

    assert.equal(payload.runs.length, 1);
    const row = payload.runs[0];
    assert.equal(row.runId, unreadableRunId);
    assert.ok(typeof row.metadataError === 'string' && row.metadataError.length > 0);
    assert.equal(row.kind, '');
    assert.equal(row.provider, '');
    assert.equal(row.objective, '');

    const logger = await runRunsWithLogger(cwd, ['list'], { jsonMode: false });
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], new RegExp(`^${unreadableRunId}\\s+\\[metadata error:`));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('listRuns handles a missing runs root', async () => {
  const cwd = await tempDir();
  try {
    const payload = await runRunsJson(cwd, ['list']);
    const logger = await runRunsWithLogger(cwd, ['list'], { jsonMode: false });

    assert.deepEqual(payload, { type: 'runs.list', runs: [] });
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], /no .+ runs found/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runRunsCommand rejects unknown subcommands', async () => {
  const cwd = await tempDir();
  try {
    await assert.rejects(
      runRuns(cwd, ['archive']),
      (error) => error.name === 'UsageError' && error.message === 'unknown runs subcommand: archive',
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun accepts timestamped run ids created by the run store', async () => {
  const cwd = await tempDir();
  try {
    const { store } = await prepareRun(cwd, {
      kind: 'review',
      label: 'valid existing run',
      writeSetupArtifacts: false,
    });
    await store.writeJson('metadata.json', { kind: 'review', provider: 'mock' });
    await store.write('nested/output.md', '# Output');

    const shown = (await runRunsJson(cwd, ['show', store.runId])).run;

    assert.equal(shown.runId, store.runId);
    assert.equal(shown.metadata.provider, 'mock');
    assert.ok(shown.files.includes('nested/output.md'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun surfaces corrupt metadata.json without leaking a raw SyntaxError', async () => {
  const cwd = await tempDir();
  try {
    const runId = '20260101-010101-review-corrupt-show-555555';
    const dir = path.join(cwd, '.commands-com', 'runs', runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'metadata.json'), '{not json', 'utf8');
    await fs.writeFile(path.join(dir, 'output.md'), '# Output', 'utf8');

    const payload = await runRunsJson(cwd, ['show', runId]);
    assert.equal(payload.type, 'runs.show');
    assert.equal(payload.run.runId, runId);
    assert.ok(
      typeof payload.run.metadataError === 'string' && payload.run.metadataError.length > 0,
      'metadataError should be a non-empty string',
    );
    assert.ok(payload.run.files.includes('metadata.json'));
    assert.ok(payload.run.files.includes('output.md'));

    const logger = await runRunsWithLogger(cwd, ['show', runId], { jsonMode: false });
    const errorLine = logger.lines.find((line) => line.startsWith('metadata error:'));
    assert.ok(errorLine, 'human output should include a metadata error line');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runs list and runs show expose the same metadataError key for a corrupt-metadata fixture', async () => {
  const cwd = await tempDir();
  try {
    const runId = '20260101-010101-review-symmetric-bad-999999';
    const dir = path.join(cwd, '.commands-com', 'runs', runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'metadata.json'), '{not json', 'utf8');

    const listPayload = await runRunsJson(cwd, ['list']);
    const showPayload = await runRunsJson(cwd, ['show', runId]);

    const listed = listPayload.runs.find((run) => run.runId === runId);
    assert.ok(listed, 'corrupt run should appear in list');
    assert.ok(
      typeof listed.metadataError === 'string' && listed.metadataError.length > 0,
      'list row should expose metadataError as a non-empty string',
    );
    assert.ok(
      typeof showPayload.run.metadataError === 'string' && showPayload.run.metadataError.length > 0,
      'show payload should expose metadataError as a non-empty string',
    );
    assert.equal(listed.metadataError, showPayload.run.metadataError);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun renders a run dir with no metadata.json as an empty-metadata record symmetric with listRuns', async () => {
  const cwd = await tempDir();
  try {
    const runId = '20260101-010101-review-no-meta-show-888888';
    const dir = path.join(cwd, '.commands-com', 'runs', runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'output.md'), '# Output', 'utf8');

    const payload = await runRunsJson(cwd, ['show', runId]);
    assert.equal(payload.type, 'runs.show');
    assert.equal(payload.run.runId, runId);
    assert.equal(payload.run.metadata, null);
    assert.equal(payload.run.metadataError, undefined);
    assert.ok(payload.run.files.includes('output.md'));

    const logger = await runRunsWithLogger(cwd, ['show', runId], { jsonMode: false });
    assert.ok(
      logger.lines.some((line) => line === 'metadata not found'),
      'human output should include a "metadata not found" diagnostic',
    );
    assert.ok(
      !logger.lines.some((line) => line.startsWith('metadata error:')),
      'absent metadata should not render as an error',
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun still rejects ids whose run dir does not exist', async () => {
  const cwd = await tempDir();
  try {
    await fs.mkdir(path.join(cwd, '.commands-com', 'runs'), { recursive: true });
    const missingRunId = '20260101-010101-review-no-dir-aaaaaa';
    await assert.rejects(
      runRuns(cwd, ['show', missingRunId]),
      (error) => error.name === 'UsageError' && error.message === `run not found: ${missingRunId}`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun surfaces unreadable metadata.json without leaking a raw EISDIR error', async () => {
  const cwd = await tempDir();
  try {
    const runId = '20260101-010101-review-unread-show-666666';
    const dir = path.join(cwd, '.commands-com', 'runs', runId);
    await fs.mkdir(path.join(dir, 'metadata.json'), { recursive: true });

    const payload = await runRunsJson(cwd, ['show', runId]);
    assert.equal(payload.run.runId, runId);
    assert.ok(
      typeof payload.run.metadataError === 'string' && payload.run.metadataError.length > 0,
      'metadataError should be a non-empty string',
    );

    const logger = await runRunsWithLogger(cwd, ['show', runId], { jsonMode: false });
    assert.ok(
      logger.lines.some((line) => line.startsWith('metadata error:')),
      'human output should include a metadata error line',
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('showRun rejects ids outside the timestamped run-id contract', async () => {
  const cwd = await tempDir();
  try {
    const invalidPatternRunIds = [
      '20260101-010101-review-valid-existing-run-abcde',
      '20260101-010101-review-valid-existing-run-abcdef-',
    ];

    for (const runId of invalidPatternRunIds) {
      await writeRunMetadata(cwd, runId);
      await assert.rejects(
        runRuns(cwd, ['show', runId]),
        (error) => error.name === 'UsageError' && error.message === `run not found: ${runId}`,
      );
    }

    const plainRunId = 'not-a-run';
    await writeRunMetadata(cwd, plainRunId);

    await assert.rejects(
      runRuns(cwd, ['show', plainRunId]),
      (error) => error.name === 'UsageError' && error.message === `run not found: ${plainRunId}`,
    );

    const unicodeSeparator = String.fromCharCode(0x2215);
    const unicodeRunId = `20260101-010101-review-a${unicodeSeparator}b-abcdef`;
    await writeRunMetadata(cwd, unicodeRunId);

    await assert.rejects(
      runRuns(cwd, ['show', unicodeRunId]),
      (error) => error.name === 'UsageError' && error.message === `run not found: ${unicodeRunId}`,
    );

    await assert.rejects(runRuns(cwd, ['show', '../outside']), /run id is required/);
    await assert.rejects(runRuns(cwd, ['show', '20260101-010101-review-a\\b-abcdef']), /run id is required/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
