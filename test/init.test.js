import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { runInitCommand } from '../src/init.js';
import { createLogger } from '../src/logger.js';
import { tempDir } from './support/cli.js';

function parsed(flags = {}) {
  return { flags: new Map(Object.entries(flags)) };
}

function captureLogger(options = {}) {
  const stdout = [];
  const stderr = [];
  const logger = createLogger({
    ...options,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { logger, stdout, stderr };
}

test('runInitCommand writes config and text output for supplied options', async () => {
  const cwd = await tempDir('commands-com-init-test-');
  try {
    const { logger, stdout, stderr } = captureLogger();
    const result = await runInitCommand(parsed({
      provider: 'mock',
      providers: 'codex,claude',
      model: 'gpt-test',
    }), { cwd, logger });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failed, false);
    assert.deepEqual(await loadConfig(cwd), {
      provider: 'mock',
      providers: 'codex,claude',
      model: 'gpt-test',
    });
    const output = stdout.join('\n');
    const configPath = path.join(cwd, '.commands-com', 'config.json');
    assert.match(output, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(output, /^provider: mock$/m);
    assert.match(output, /^providers: codex,claude$/m);
    assert.match(output, /^model: gpt-test$/m);
    assert.deepEqual(stderr, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runInitCommand emits completion payload in json mode', async () => {
  const cwd = await tempDir('commands-com-init-test-');
  try {
    const { logger, stdout, stderr } = captureLogger({ json: true });
    const result = await runInitCommand(parsed({ provider: 'mock' }), { cwd, logger });

    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    const payload = JSON.parse(stdout[0]);
    assert.equal(payload.type, 'init.completed');
    assert.equal(payload.configPath, path.join(cwd, '.commands-com', 'config.json'));
    assert.deepEqual(payload.config, { provider: 'mock' });
    assert.deepEqual(stderr, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runInitCommand merges with existing config and ignores empty option values', async () => {
  const cwd = await tempDir('commands-com-init-test-');
  try {
    await runInitCommand(parsed({ provider: 'mock', model: 'gpt-test' }), {
      cwd,
      logger: captureLogger().logger,
    });
    await runInitCommand(parsed({ provider: '', providers: 'all' }), {
      cwd,
      logger: captureLogger().logger,
    });

    assert.deepEqual(await loadConfig(cwd), {
      provider: 'mock',
      providers: 'all',
      model: 'gpt-test',
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runInitCommand requires a logger', async () => {
  await assert.rejects(
    runInitCommand(parsed({ provider: 'mock' }), { cwd: process.cwd() }),
    /runInitCommand requires logger/,
  );
});
