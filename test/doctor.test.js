import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDoctorCommand } from '../src/doctor.js';
import { createCommandLogger } from '../src/logger.js';
import { PROVIDER_PING_MARKER } from '../src/mock-provider.js';
import { tempDir } from './support/cli.js';
import { emitClaudeResult, emitCodexMessage, writeFakeProvider } from './support/fake-provider.js';

const PROVIDER_TEST_TIMEOUT_MS = '5000';

function parsed(flags = {}) {
  return {
    positionals: [],
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

function loggerFor(commandParsed) {
  const stdout = [];
  const stderr = [];
  return {
    logger: createCommandLogger(commandParsed, {
      kind: 'doctor',
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
    stdout,
    stderr,
  };
}

function replaceProviderPath(binDir) {
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  return () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('runDoctorCommand pings providers requested through doctor options', async () => {
  const cwd = await tempDir();
  try {
    const commandParsed = parsed({
      json: 'true',
      ping: 'true',
      providers: 'mock',
      provider: 'missing-provider',
      'timeout-ms': PROVIDER_TEST_TIMEOUT_MS,
    });
    const { logger, stdout, stderr } = loggerFor(commandParsed);

    const result = await runDoctorCommand(commandParsed, { cwd, logger });
    const payload = JSON.parse(stdout.join('\n'));

    assert.equal(result.exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(payload.type, 'doctor');
    assert.equal(payload.providers.some((provider) => provider.id === 'mock' && provider.available), true);
    assert.equal(payload.pings.length, 1);
    assert.equal(payload.pings[0].id, 'mock');
    assert.equal(payload.pings[0].ok, true);
    assert.equal(payload.pings[0].text, `${PROVIDER_PING_MARKER} mock`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runDoctorCommand fails ping rows when provider output omits the requested marker', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  const binDir = path.join(cwd, 'bin');
  const restorePath = replaceProviderPath(binDir);
  try {
    await writeFakeProvider(binDir, 'claude', emitClaudeResult('provider is reachable but did not confirm health'));
    const commandParsed = parsed({
      json: 'true',
      ping: 'true',
      providers: 'claude',
      'timeout-ms': PROVIDER_TEST_TIMEOUT_MS,
    });
    const { logger, stdout, stderr } = loggerFor(commandParsed);

    const result = await runDoctorCommand(commandParsed, { cwd, logger });
    const payload = JSON.parse(stdout.join('\n'));

    assert.equal(result.exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(payload.pings.length, 1);
    assert.equal(payload.pings[0].id, 'claude');
    assert.equal(payload.pings[0].ok, false);
    assert.equal(payload.pings[0].text, 'provider is reachable but did not confirm health');
  } finally {
    restorePath();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runDoctorCommand records provider failure rows during ping', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  const binDir = path.join(cwd, 'bin');
  const restorePath = replaceProviderPath(binDir);
  try {
    await writeFakeProvider(binDir, 'claude', [
      '#!/bin/sh',
      "printf '%s\\n' 'provider unavailable' >&2",
      'exit 23',
    ]);
    const commandParsed = parsed({
      json: 'true',
      ping: 'true',
      providers: 'claude',
      'timeout-ms': PROVIDER_TEST_TIMEOUT_MS,
    });
    const { logger, stdout, stderr } = loggerFor(commandParsed);

    const result = await runDoctorCommand(commandParsed, { cwd, logger });
    const payload = JSON.parse(stdout.join('\n'));

    assert.equal(result.exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(payload.pings.length, 1);
    assert.equal(payload.pings[0].id, 'claude');
    assert.equal(payload.pings[0].ok, false);
    assert.match(payload.pings[0].error, /claude exited with 23/);
    assert.match(payload.pings[0].error, /provider unavailable/);
  } finally {
    restorePath();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runDoctorCommand renders human-readable ping responses and missing repository state', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  const binDir = path.join(cwd, 'bin');
  const restorePath = replaceProviderPath(binDir);
  try {
    await writeFakeProvider(binDir, 'codex', emitCodexMessage(`${PROVIDER_PING_MARKER} from codex`));
    await writeFakeProvider(binDir, 'claude', [
      '#!/bin/sh',
      "printf '%s\\n' 'provider unavailable' >&2",
      'exit 7',
    ]);
    const commandParsed = parsed({
      ping: 'true',
      providers: 'codex,claude',
      'timeout-ms': PROVIDER_TEST_TIMEOUT_MS,
    });
    const { logger, stdout, stderr } = loggerFor(commandParsed);

    const result = await runDoctorCommand(commandParsed, { cwd, logger });
    const output = stdout.join('\n');

    assert.equal(result.exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.match(output, /^Repository: not a git repository$/m);
    assert.match(output, /^Provider Responses$/m);
    assert.match(
      output,
      new RegExp(`^- codex: ok \\(\\d+ms\\) - ${escapeRegExp(PROVIDER_PING_MARKER)} from codex$`, 'm'),
    );
    assert.match(output, /^- claude: failed \(\d+ms\) - claude exited with 7: stderr: provider unavailable$/m);
  } finally {
    restorePath();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
