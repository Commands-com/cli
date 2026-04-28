import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { extractProviderText, providerFailureDetails } from '../src/provider-output.js';
import { PROCESS_KILL_GRACE_MS } from '../src/provider-limits.js';
import { isTransientProviderError, runProviderWithRetry as runProviderWithRetryPolicy } from '../src/provider-retry.js';
import { runProvider, runProviderWithRetry } from '../src/providers.js';

/** @param {{ kill?: (signal?: string) => boolean }} [options] @returns {any} */
function createMockChild({ kill } = {}) {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = kill || (() => true);
  return child;
}

function mockSpawnReturning(t, child) {
  const mockedSpawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => {
    mockedSpawn.mock.restore();
    syncBuiltinESMExports();
  });
}

test('extractProviderText reads codex agent messages from JSONL', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
  ].join('\n');
  assert.equal(extractProviderText('codex', stdout), 'final');
});

test('providerFailureDetails preserves codex error events alongside progress messages', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'making progress' } }),
    JSON.stringify({ type: 'error', message: 'stream disconnected before completion' }),
  ].join('\n');
  const details = providerFailureDetails({ id: 'codex' }, stdout, '');
  assert.match(details, /stdout error: stream disconnected before completion/);
  assert.match(details, /stdout last message: making progress/);
});

test('runProvider includes stdout details when a provider exits nonzero', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-fail-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stdout failure detail' } })}'`,
      'exit 7',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  try {
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 5_000 },
      ),
      /codex exited with 7:[\s\S]*stdout failure detail/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProvider explains empty provider failures', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-empty-fail-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(bin, '#!/bin/sh\nexit 9\n', 'utf8');
  await fs.chmod(bin, 0o755);
  try {
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 5_000 },
      ),
      /codex exited with 9: no stderr\/stdout captured/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProvider reports provider timeouts explicitly', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-timeout-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(bin, '#!/bin/sh\nsleep 1\n', 'utf8');
  await fs.chmod(bin, 0o755);
  try {
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 20 },
      ),
      /codex timed out after 20ms/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProvider threads waitForCloseOnTimeout: true to runProcess when allowTools is truthy', { skip: process.platform === 'win32' }, async (t) => {
  // Verifies the call-site contract that write-capable runs (allowTools)
  // defer the timeout settle until the spawned child has actually closed,
  // so a retry/fallback never overlaps a still-running prior child.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  mockSpawnReturning(t, child);

  const promise = runProvider(
    { id: 'codex', command: '/bin/codex' },
    { cwd: '/', prompt: 'hello', model: '', allowTools: true, timeoutMs: 10 },
  );
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false, 'allowTools=true must hold the settle until child close');

  t.mock.timers.tick(PROCESS_KILL_GRACE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);

  child.emit('close', null, 'SIGKILL');
  await assert.rejects(promise, /codex timed out after 10ms \(ETIMEDOUT\)/);
});

test('runProvider threads waitForCloseOnTimeout: false to runProcess when allowTools is omitted', { skip: process.platform === 'win32' }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  mockSpawnReturning(t, child);

  const promise = runProvider(
    { id: 'codex', command: '/bin/codex' },
    { cwd: '/', prompt: 'hello', model: '', timeoutMs: 10 },
  );

  t.mock.timers.tick(10);
  // allowTools omitted → waitForCloseOnTimeout: false → settle on the
  // timeout tick, before any child 'close' event arrives.
  await assert.rejects(promise, /codex timed out after 10ms \(ETIMEDOUT\)/);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('runProvider tags timeout errors so isTransientProviderError treats them as retryable', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-timeout-tag-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(bin, '#!/bin/sh\nsleep 1\n', 'utf8');
  await fs.chmod(bin, 0o755);
  try {
    /** @type {any} */
    let captured;
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 20 },
      ),
      (error) => {
        captured = error;
        return true;
      },
    );
    assert.equal(captured.code, 'ETIMEDOUT');
    assert.match(captured.message, /ETIMEDOUT/);
    assert.equal(isTransientProviderError(captured), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProvider reports provider signal interruptions explicitly', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-signal-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(bin, '#!/bin/sh\nkill -TERM $$\nsleep 1\n', 'utf8');
  await fs.chmod(bin, 0o755);
  try {
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 5_000 },
      ),
      /codex interrupted by SIGTERM/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProvider includes diagnostics for provider signal interruptions', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-signal-diagnostics-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'signal stdout detail' } })}'`,
      'printf "%s\\n" "signal stderr detail" >&2',
      'kill -TERM $$',
      'sleep 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  try {
    await assert.rejects(
      runProvider(
        { id: 'codex', command: bin },
        { cwd: tmp, prompt: 'hello', model: '', allowTools: false, timeoutMs: 5_000 },
      ),
      /codex interrupted by SIGTERM:[\s\S]*stderr: signal stderr detail[\s\S]*stdout last message: signal stdout detail/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('isTransientProviderError detects retryable provider stream failures', () => {
  assert.equal(isTransientProviderError(new Error('stream disconnected before completion')), true);
  assert.equal(isTransientProviderError(new Error('Reconnecting... 4/5')), true);
  assert.equal(isTransientProviderError(new Error('codex timed out after 1800000ms')), false);
  assert.equal(isTransientProviderError(new Error('unsupported provider')), false);
});

test('runProviderWithRetry retries transient provider failures', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-retry-'));
  const bin = path.join(tmp, 'codex');
  const successText = 'retry succeeded';
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      'count_file="$0.count"',
      'if [ -f "$count_file" ]; then',
      '  read n < "$count_file"',
      'else',
      '  n=0',
      'fi',
      'n=$((n + 1))',
      'printf \'%s\\n\' "$n" > "$count_file"',
      'if [ "$n" -eq 1 ]; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: 'stream disconnected before completion' })}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: successText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  const retryEvents = [];
  try {
    const result = await runProviderWithRetry(
      { id: 'codex', command: bin },
      {
        cwd: tmp,
        prompt: 'hello',
        model: '',
        allowTools: false,
        timeoutMs: 5_000,
        retries: 1,
        retryDelayMs: 0,
        onRetry: (event) => retryEvents.push(event.retry),
      },
    );
    assert.equal(result.text, successText);
    assert.deepEqual(retryEvents, [1]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProviderWithRetry retries when codex emits progress before an error event', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-progress-error-retry-'));
  const bin = path.join(tmp, 'codex');
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      'count_file="$0.count"',
      'if [ -f "$count_file" ]; then',
      '  read n < "$count_file"',
      'else',
      '  n=0',
      'fi',
      'n=$((n + 1))',
      'printf \'%s\\n\' "$n" > "$count_file"',
      'if [ "$n" -eq 1 ]; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I am partway through the task.' } })}'`,
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: 'stream disconnected before completion' })}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'retry finished' } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  try {
    const result = await runProviderWithRetry(
      { id: 'codex', command: bin },
      {
        cwd: tmp,
        prompt: 'hello',
        model: '',
        allowTools: false,
        timeoutMs: 5_000,
        retries: 1,
        retryDelayMs: 0,
      },
    );
    assert.equal(result.text, 'retry finished');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runProviderWithRetry stops at the retry-count boundary', async () => {
  const provider = { id: 'codex', command: 'codex' };
  const retryEvents = [];
  let attempts = 0;

  await assert.rejects(
    runProviderWithRetryPolicy(
      provider,
      {
        retries: 2,
        retryDelayMs: 0,
        onRetry: (event) => retryEvents.push(event.retry),
      },
      async () => {
        attempts += 1;
        throw new Error('stream disconnected before completion');
      },
    ),
    /stream disconnected before completion/,
  );

  assert.equal(attempts, 3);
  assert.deepEqual(retryEvents, [1, 2]);
});

test('runProviderWithRetry applies linear retryDelayMs backoff progression', async () => {
  const provider = { id: 'codex', command: 'codex' };
  const delays = [];
  const retryEvents = [];
  let attempts = 0;

  const result = await runProviderWithRetryPolicy(
    provider,
    {
      retries: 3,
      retryDelayMs: 25,
      onRetry: (event) => retryEvents.push({ retry: event.retry, retries: event.retries }),
    },
    async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error('temporarily unavailable');
      return { text: 'ok' };
    },
    async (ms) => {
      delays.push(ms);
    },
  );

  assert.deepEqual(delays, [25, 50, 75]);
  assert.deepEqual(retryEvents, [
    { retry: 1, retries: 3 },
    { retry: 2, retries: 3 },
    { retry: 3, retries: 3 },
  ]);
  assert.equal(attempts, 4);
  assert.equal(result.text, 'ok');
});
