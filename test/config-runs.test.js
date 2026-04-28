import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initConfig, loadConfig, localRunsPath } from '../src/config.js';
import { UsageError } from '../src/errors.js';
import { prepareRun } from '../src/run-store.js';
import { runRunsCommand } from '../src/runs.js';
import { tempDir } from './support/cli.js';

function jsonLogger() {
  const records = [];
  return {
    records,
    jsonMode: true,
    json(value) {
      records.push(value);
    },
    line() {},
  };
}

async function runRunsJson(cwd, positionals) {
  const logger = jsonLogger();
  await runRunsCommand({ positionals, flags: new Map() }, { cwd, logger });
  return logger.records[0];
}

test('loadConfig surfaces invalid JSON as a UsageError', async () => {
  const cwd = await tempDir('commands-com-test-');
  const configDir = path.join(cwd, '.commands-com');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), '{ not json', 'utf8');
  await assert.rejects(loadConfig(cwd), (error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.exitCode, 2);
    return true;
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('loadConfig rejects non-string/array providers as a UsageError', async () => {
  const cwd = await tempDir('commands-com-test-');
  const configDir = path.join(cwd, '.commands-com');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ providers: { primary: 'mock' } }),
    'utf8',
  );
  await assert.rejects(loadConfig(cwd), (error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /providers must be a string or array/);
    return true;
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('loadConfig rejects non-string provider as a UsageError', async () => {
  const cwd = await tempDir('commands-com-test-');
  const configDir = path.join(cwd, '.commands-com');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ provider: ['claude', 'codex'] }),
    'utf8',
  );
  await assert.rejects(loadConfig(cwd), (error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /provider must be a string/);
    return true;
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('loadConfig rejects non-string model as a UsageError', async () => {
  const cwd = await tempDir('commands-com-test-');
  const configDir = path.join(cwd, '.commands-com');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ model: { name: 'gpt' } }),
    'utf8',
  );
  await assert.rejects(loadConfig(cwd), (error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /model must be a string/);
    return true;
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('initConfig writes and merges local config', async () => {
  const cwd = await tempDir('commands-com-test-');
  const first = await initConfig(cwd, { provider: 'mock' });
  assert.equal(first.filePath, path.join(cwd, '.commands-com', 'config.json'));
  const second = await initConfig(cwd, { model: 'test-model' });
  assert.deepEqual(await loadConfig(cwd), {
    provider: 'mock',
    model: 'test-model',
  });
  await fs.rm(cwd, { recursive: true, force: true });
});

test('listRuns and showRun read local run metadata', async () => {
  const cwd = await tempDir('commands-com-test-');
  const { store } = await prepareRun(cwd, {
    kind: 'review',
    label: 'hello',
    writeSetupArtifacts: false,
  });
  await store.writeJson('metadata.json', {
    kind: 'review',
    objective: 'hello',
    provider: 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await store.write('review-cycle.md', '# Report');

  const list = await runRunsJson(cwd, ['list']);
  const runs = list.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, store.runId);
  assert.equal(runs[0].kind, 'review');

  const shown = (await runRunsJson(cwd, ['show', store.runId])).run;
  assert.equal(shown.metadata.provider, 'mock');
  assert.ok(shown.files.includes('review-cycle.md'));
  await fs.rm(cwd, { recursive: true, force: true });
});

test('run store refuses path traversal writes', async () => {
  const cwd = await tempDir('commands-com-test-');
  const { store } = await prepareRun(cwd, {
    kind: 'review',
    label: 'hello',
    writeSetupArtifacts: false,
  });
  await assert.rejects(store.write('../outside.md', 'nope'), /outside run directory/);
  await assert.rejects(fs.stat(localRunsPath(cwd, 'outside.md')), /ENOENT/);
  await fs.rm(cwd, { recursive: true, force: true });
});
