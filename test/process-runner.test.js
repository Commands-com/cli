import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { PROCESS_FORCE_SETTLE_GRACE_MS, runProcess } from '../src/process-runner.js';
import { PROCESS_KILL_GRACE_MS } from '../src/provider-limits.js';

let mockedProcessRunnerImportId = 0;

function createMockChild({ kill } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = kill || (() => true);
  return child;
}

async function importProcessRunnerWithMockedSpawn(t, spawn) {
  const mockedSpawn = t.mock.method(childProcess, 'spawn', spawn);
  syncBuiltinESMExports();
  t.after(() => {
    mockedSpawn.mock.restore();
    syncBuiltinESMExports();
  });

  mockedProcessRunnerImportId += 1;
  return import(`../src/process-runner.js?mocked-spawn=${mockedProcessRunnerImportId}`);
}

test('runProcess resolves successful commands with captured stdout and stderr', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err");',
    ],
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test('runProcess writes stdin to the child process', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout);'],
    stdin: 'hello from stdin',
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hello from stdin');
  assert.equal(result.stderr, '');
});

test('runProcess enables a stdin pipe when stdio would otherwise ignore input', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      '-e',
      [
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => process.exit(input === "pipe me" ? 0 : 9));',
      ].join(' '),
    ],
    stdin: 'pipe me',
    stdio: 'ignore',
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.code, 0);
});

test('runProcess resolves non-zero exits as failures without throwing', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      '-e',
      'process.stdout.write("partial"); process.stderr.write("bad"); process.exit(7);',
    ],
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'partial');
  assert.equal(result.stderr, 'bad');
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test('runProcess maps incomplete child closes to a generic failure exit code', async (t) => {
  const child = createMockChild();
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 5_000,
  });
  child.emit('close', undefined, null);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.code, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test('runProcess retains the timeout kill timer after resolving on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 10,
    resolveOnTimeout: true,
  });
  t.mock.timers.tick(10);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ['SIGTERM']);

  t.mock.timers.runAll();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('runProcess detaches data listeners after a timeout-resolve settle so post-settle output is not captured', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const child = createMockChild();
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 10,
    resolveOnTimeout: true,
  });

  child.stdout.write('captured-out');
  child.stderr.write('captured-err');

  t.mock.timers.tick(10);
  const result = await resultPromise;

  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'captured-out');
  assert.equal(result.stderr, 'captured-err');

  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);

  assert.doesNotThrow(() => {
    child.stdout.write('post-settle-out');
    child.stderr.write('post-settle-err');
  });

  assert.equal(result.stdout, 'captured-out');
  assert.equal(result.stderr, 'captured-err');
});

test('runProcess defers timeout settle until child close when waitForCloseOnTimeout is set', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 10,
    resolveOnTimeout: true,
    waitForCloseOnTimeout: true,
  });

  let settled = false;
  resultPromise.then(() => { settled = true; }, () => { settled = true; });

  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);

  t.mock.timers.tick(PROCESS_KILL_GRACE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);

  child.emit('close', null, 'SIGKILL');
  const result = await resultPromise;

  assert.equal(settled, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.signal, 'SIGKILL');
});

test('runProcess force-settles waitForCloseOnTimeout when child close never fires after SIGKILL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 10,
    resolveOnTimeout: true,
    waitForCloseOnTimeout: true,
  });

  let settled = false;
  resultPromise.then(() => { settled = true; }, () => { settled = true; });

  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);

  t.mock.timers.tick(PROCESS_KILL_GRACE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);

  t.mock.timers.tick(PROCESS_FORCE_SETTLE_GRACE_MS);
  const result = await resultPromise;

  assert.equal(settled, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
});

test('runProcess clears a retained timeout kill timer when the child later closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const signals = [];
  const child = createMockChild({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  });
  const { runProcess: runMockedProcess } = await importProcessRunnerWithMockedSpawn(t, () => child);

  const resultPromise = runMockedProcess({
    command: 'mocked-command',
    timeoutMs: 10,
    resolveOnTimeout: true,
  });
  t.mock.timers.tick(10);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.deepEqual(signals, ['SIGTERM']);

  child.emit('close', null, 'SIGTERM');
  t.mock.timers.runAll();
  assert.deepEqual(signals, ['SIGTERM']);
});

test('runProcess can resolve a normalized timeout result immediately', { skip: process.platform === 'win32' }, async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    timeoutMs: 25,
    resolveOnTimeout: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.code, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, true);
  assert.equal(result.error, null);
});

test('runProcess gives timeout exit code precedence over later numeric exits', { skip: process.platform === 'win32' }, async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => process.exit(7)); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 250,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.error, null);
});

test('runProcess maps signal-only exits to the signal failure code', { skip: process.platform === 'win32' }, async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.kill(process.pid, "SIGTERM");'],
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 128);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test('runProcess reports spawn errors as failures with stderr details', async () => {
  const result = await runProcess({
    command: 'commands-com-missing-executable-for-test',
    args: [],
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.code, undefined);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /commands-com-missing-executable-for-test|ENOENT/);
  assert.equal(result.timedOut, false);
  assert.ok(result.error instanceof Error);
});

test('runProcess marks capped output as truncated', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("abcdef");'],
    maxOutputBytes: 3,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
});
