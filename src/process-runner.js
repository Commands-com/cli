import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, PROCESS_KILL_GRACE_MS } from './provider-limits.js';
import { appendCapped } from './provider-output.js';

// Outer fail-safe interval for `waitForCloseOnTimeout`. After SIGTERM and the
// `PROCESS_KILL_GRACE_MS` SIGKILL grace, if the child's `close` event still
// has not fired (e.g., a grandchild kept stdio inherited and open), force a
// settle so the returned promise cannot hang forever.
export const PROCESS_FORCE_SETTLE_GRACE_MS = 2_000;

/**
 * @typedef {import('node:child_process').ChildProcess} ChildProcess
 * @typedef {import('node:child_process').StdioOptions} StdioOptions
 *
 * @typedef {object} RunProcessOptions
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {*} [stdin]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean | string} [shell]
 * @property {StdioOptions} [stdio]
 * @property {number} [timeoutMs]
 * @property {number} [maxOutputBytes]
 * @property {boolean} [windowsVerbatimArguments]
 * @property {boolean} [resolveOnTimeout]
 * @property {boolean} [waitForCloseOnTimeout] When `resolveOnTimeout` is set,
 *   defer the timeout settle until the child's 'close' event (after SIGTERM
 *   then SIGKILL) so callers can be sure the previous child is no longer
 *   running before they spawn a successor. Used for write-capable provider
 *   invocations to prevent overlapping retries.
 *
 * @typedef {object} RunProcessResult
 * @property {boolean} ok
 * @property {number} exitCode
 * @property {number | null | undefined} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} stdoutTruncated
 * @property {boolean} stderrTruncated
 * @property {boolean} timedOut
 * @property {Error | null} error
 */

function appendOutput(current, chunk, maxOutputBytes) {
  const appended = appendCapped(current.value, chunk, maxOutputBytes);
  current.value = appended.value;
  current.truncated ||= appended.truncated;
}

function createCapturedOutput(maxOutputBytes) {
  const stdout = { value: '', truncated: false };
  const stderr = { value: '', truncated: false };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let attached = null;

  const appendStdout = (chunk) => {
    appendOutput(stdout, stdoutDecoder.write(chunk), maxOutputBytes);
  };
  const appendStderr = (chunk) => {
    appendOutput(stderr, stderrDecoder.write(chunk), maxOutputBytes);
  };

  return {
    attach(child) {
      attached = child;
      child.stdout?.on('data', appendStdout);
      child.stderr?.on('data', appendStderr);
    },
    flush() {
      if (attached) {
        attached.stdout?.removeListener('data', appendStdout);
        attached.stderr?.removeListener('data', appendStderr);
        attached = null;
      }
      appendOutput(stdout, stdoutDecoder.end(), maxOutputBytes);
      appendOutput(stderr, stderrDecoder.end(), maxOutputBytes);
    },
    appendError(error) {
      appendOutput(stderr, `${stderr.value ? '\n' : ''}${error.message || error}`, maxOutputBytes);
    },
    snapshot() {
      return {
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    },
  };
}

function exitCodeFor({ code, signal, timedOut }) {
  if (timedOut) return 124;
  if (typeof code === 'number') return code;
  if (signal) return 128;
  return 1;
}

function normalizeProcessResult({
  code,
  signal,
  timedOut,
  error,
  capturedOutput,
}) {
  const exitCode = exitCodeFor({ code, signal, timedOut });

  return {
    ok: exitCode === 0 && !timedOut && !error,
    exitCode,
    code,
    signal,
    ...capturedOutput,
    timedOut,
    error,
  };
}

function stdioForInput(stdio, stdin) {
  if (stdin === undefined || stdin === null) return stdio;
  if (!Array.isArray(stdio)) return stdio === 'ignore' ? ['pipe', 'ignore', 'ignore'] : stdio;
  const next = [...stdio];
  if (next[0] === undefined || next[0] === 'ignore') next[0] = 'pipe';
  return next;
}

function spawnProcess({
  command,
  args,
  cwd,
  stdin,
  env,
  shell,
  stdio,
  windowsVerbatimArguments,
}) {
  return spawn(command, args, {
    cwd,
    shell,
    stdio: stdioForInput(stdio, stdin),
    env,
    windowsVerbatimArguments,
  });
}

function stopChild(child) {
  try { child.kill('SIGTERM'); } catch {}
}

function forceStopChild(child) {
  try { child.kill('SIGKILL'); } catch {}
}

function effectiveTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_TIMEOUT_MS;
}

function createTimeoutController({
  child,
  timeoutMs,
  resolveOnTimeout,
  waitForCloseOnTimeout,
  onTimeout,
  settle,
}) {
  let killTimer = null;
  let forceSettleTimer = null;
  const timer = setTimeout(() => {
    onTimeout();
    stopChild(child);
    killTimer = setTimeout(() => {
      forceStopChild(child);
      // Outer fail-safe: if waitForCloseOnTimeout is set and `close` still
      // hasn't fired after SIGKILL, force a settle so the promise cannot
      // hang forever (e.g., grandchild keeps stdio inherited and open).
      if (resolveOnTimeout && waitForCloseOnTimeout) {
        forceSettleTimer = setTimeout(() => {
          settle({ code: null });
        }, PROCESS_FORCE_SETTLE_GRACE_MS);
        if (typeof forceSettleTimer.unref === 'function') forceSettleTimer.unref();
      }
    }, PROCESS_KILL_GRACE_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    // When waitForCloseOnTimeout is set, defer the resolve to the child's
    // actual 'close' event so callers cannot spawn a successor while a
    // write-capable child is still alive.
    if (resolveOnTimeout && !waitForCloseOnTimeout) {
      settle({ code: null }, { keepKillTimer: true });
    }
  }, effectiveTimeout(timeoutMs));

  return {
    clear({ keepKillTimer = false } = {}) {
      clearTimeout(timer);
      if (killTimer && !keepKillTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
    },
  };
}

function writeChildStdin(child, stdin) {
  child.stdin?.on('error', () => {
    // Absorb EPIPE and similar stdin write failures; the child's 'error' or
    // 'close' handler will settle the promise with the real reason.
  });
  child.stdin?.end(stdin);
}

/**
 * @param {RunProcessOptions} [options]
 * @returns {Promise<RunProcessResult>}
 */
export function runProcess({
  command,
  args = [],
  cwd,
  stdin,
  env,
  shell = false,
  stdio = ['ignore', 'pipe', 'pipe'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  windowsVerbatimArguments = false,
  resolveOnTimeout = false,
  waitForCloseOnTimeout = false,
} = {}) {
  return new Promise((resolve) => {
    const capturedOutput = createCapturedOutput(maxOutputBytes);
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    /** @type {{ clear(options?: { keepKillTimer?: boolean }): void }} */
    let timeoutController = { clear() {} };

    const settle = ({ code = undefined, signal = null, error = null } = {}, { keepKillTimer = false } = {}) => {
      if (settled) {
        if (!keepKillTimer) timeoutController.clear();
        return;
      }
      settled = true;
      timeoutController.clear({ keepKillTimer });
      capturedOutput.flush();
      const resultError = error || spawnError;
      if (resultError) {
        capturedOutput.appendError(resultError);
      }
      resolve(normalizeProcessResult({
        code,
        signal,
        timedOut,
        error: resultError,
        capturedOutput: capturedOutput.snapshot(),
      }));
    };

    let child;
    try {
      child = spawnProcess({
        command,
        args,
        cwd,
        stdin,
        env,
        shell,
        stdio,
        windowsVerbatimArguments,
      });
    } catch (error) {
      spawnError = error;
      settle({ error });
      return;
    }

    timeoutController = createTimeoutController({
      child,
      timeoutMs,
      resolveOnTimeout,
      waitForCloseOnTimeout,
      onTimeout() {
        timedOut = true;
      },
      settle,
    });
    capturedOutput.attach(child);
    child.on('error', (error) => {
      spawnError = error;
      settle({ error });
    });
    child.on('close', (code, signal) => {
      settle({ code, signal });
    });
    writeChildStdin(child, stdin);
  });
}
