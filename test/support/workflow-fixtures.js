import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../src/git.js';
import { tempDir } from './cli.js';

export async function tempRunDir(prefix = 'commands-com-workflow-') {
  return tempDir(prefix);
}

export async function withTempRun(fn, { prefix = 'commands-com-workflow-' } = {}) {
  const cwd = await tempRunDir(prefix);
  try {
    return await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

export async function mustRunGit(args, cwd) {
  const result = await runGit(args, cwd);
  assert.equal(result.ok, true, result.stderr || result.stdout || `git ${args.join(' ')}`);
  return result;
}

export async function initWorkflowSafetyRepo(cwd) {
  await mustRunGit(['init'], cwd);
  await mustRunGit(['config', 'core.quotePath', 'true'], cwd);
  await fs.writeFile(path.join(cwd, 'README.md'), '# Test\n', 'utf8');
  await fs.mkdir(path.join(cwd, '.commands-com'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.commands-com', '.keep'), '', 'utf8');
  await mustRunGit(['add', 'README.md', '.commands-com/.keep'], cwd);
  await mustRunGit([
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test User',
    'commit',
    '-m',
    'init',
  ], cwd);
}

function joinConsoleArgs(args) {
  return args.join(' ');
}

function stringifyConsoleArgs(args) {
  return args.map(String).join(' ');
}

function firstConsoleArg(args) {
  return String(args.length > 0 ? args[0] : '');
}

async function captureConsoleInvocation(fn, {
  captureExitCode = true,
  captureStderr = false,
  env = {},
  formatStdoutArgs = joinConsoleArgs,
  formatStderrArgs = formatStdoutArgs,
} = {}) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  let result;
  let error = null;
  let exitCode;

  console.log = (...args) => stdout.push(formatStdoutArgs(args));
  if (captureStderr) {
    console.error = (...args) => stderr.push(formatStderrArgs(args));
  }
  if (captureExitCode) {
    process.exitCode = undefined;
  }

  try {
    result = await withEnv(env, fn);
  } catch (caught) {
    error = caught;
  } finally {
    exitCode = process.exitCode;
    console.log = originalLog;
    if (captureStderr) {
      console.error = originalError;
    }
    if (captureExitCode) {
      process.exitCode = originalExitCode;
    }
  }

  return { result, error, stdout, stderr, exitCode };
}

function throwCapturedError(outcome) {
  if (outcome.error) {
    throw outcome.error;
  }
  return outcome;
}

export async function captureConsoleLogs(fn) {
  const { stdout } = throwCapturedError(await captureConsoleInvocation(fn, {
    captureExitCode: false,
  }));
  return stdout;
}

export async function captureConsoleOutcome(fn) {
  const { stdout, result, error } = await captureConsoleInvocation(fn, {
    captureExitCode: false,
  });
  return { logs: stdout, result: error ? null : result, error };
}

export async function captureCommandResultLogs(fn) {
  const {
    result: commandResult,
    stdout,
    exitCode,
  } = throwCapturedError(await captureConsoleInvocation(fn, {
    formatStdoutArgs: stringifyConsoleArgs,
  }));

  return {
    stdout: stdout.join('\n'),
    exitCode: commandResult?.exitCode ?? exitCode ?? 0,
    commandResult,
  };
}

export async function captureConsoleIO(fn) {
  const {
    result,
    stdout,
    stderr,
    exitCode,
  } = throwCapturedError(await captureConsoleInvocation(fn, {
    captureStderr: true,
    formatStdoutArgs: firstConsoleArg,
    formatStderrArgs: firstConsoleArg,
  }));

  return { result, stdout, stderr, exitCode };
}

export async function captureWorkflowCommand(fn, commandParsed, cwd, { env = {} } = {}) {
  const {
    result,
    stdout,
    exitCode,
  } = throwCapturedError(await captureConsoleInvocation(
    () => fn(commandParsed, { cwd }),
    {
      env,
      formatStdoutArgs: stringifyConsoleArgs,
    },
  ));

  return {
    stdout: stdout.join('\n'),
    exitCode: result?.exitCode ?? exitCode ?? 0,
  };
}

export async function captureWorkflowCommandFailure(fn, commandParsed, cwd, { env = {} } = {}) {
  const {
    error,
    stdout,
    exitCode,
  } = await captureConsoleInvocation(
    () => fn(commandParsed, { cwd }),
    {
      env,
      formatStdoutArgs: stringifyConsoleArgs,
    },
  );

  if (!error) {
    assert.fail('Expected command to fail');
  }

  return {
    error,
    stdout: stdout.join('\n'),
    exitCode: exitCode || 0,
  };
}

export async function withEnv(env, fn) {
  const original = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function prependPathEntry(entry, existingPath = process.env.PATH || '') {
  return existingPath ? `${entry}${path.delimiter}${existingPath}` : entry;
}

export async function readSingleWorkflowRun(cwd) {
  const runsRoot = path.join(cwd, '.commands-com', 'runs');
  const runIds = await fs.readdir(runsRoot);
  const [runId] = runIds;
  return {
    runsRoot,
    runIds,
    runId,
    runDir: runId ? path.join(runsRoot, runId) : '',
  };
}
