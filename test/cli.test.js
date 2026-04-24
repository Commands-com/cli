import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.js';
import {
  COMMAND_REGISTRY,
  commandForName,
  formatCommandHelpRows,
} from '../src/command-registry.js';
import { COMMAND_OPTIONS, OPTION_SCOPES } from '../src/command-option-schema.js';
import {
  captureConsoleIO as captureConsole,
  withEnv,
} from './support/workflow-fixtures.js';
import { tempDir } from './support/cli.js';

async function withWorkingDirectory(cwd, fn) {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

async function writeTransientClaudeProvider(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  const providerPath = path.join(binDir, 'claude');
  await fs.writeFile(providerPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const logPath = process.env.CLI_ROOM_PROVIDER_LOG;",
    "const countPath = path.join(path.dirname(process.argv[1]), 'participant.count');",
    "let count = 0;",
    "try { count = Number(fs.readFileSync(countPath, 'utf8')) || 0; } catch {}",
    "count += 1;",
    "fs.writeFileSync(countPath, String(count));",
    "if (logPath) fs.appendFileSync(logPath, 'participant\\n');",
    "if (count === 1) {",
    "  console.error('temporarily unavailable');",
    '  process.exit(7);',
    '}',
    "console.log(JSON.stringify({ text: 'Retried CLI room output' }));",
  ].join('\n'), 'utf8');
  await fs.chmod(providerPath, 0o755);
}

function commandBlock(helpText) {
  const start = helpText.indexOf('Commands:\n');
  assert.notEqual(start, -1);
  const bodyStart = start + 'Commands:\n'.length;
  const end = helpText.indexOf('\n\nExamples:', bodyStart);
  assert.notEqual(end, -1);
  return helpText.slice(bodyStart, end);
}

function assertHelpLayout(text) {
  assert.match(text, /^Usage: commands-com <command> \[options\]\n\nCommands:\n/);

  const commandLines = commandBlock(text).split('\n');
  assert.equal(commandLines.length, COMMAND_REGISTRY.length, 'one help row per registered command');
  COMMAND_REGISTRY.forEach((command, index) => {
    const line = commandLines[index];
    assert.ok(
      line.includes(command.helpUsage),
      `command ${command.name} should appear at row ${index} (got: ${line})`,
    );
    assert.ok(
      line.endsWith(command.helpDescription),
      `command ${command.name} description missing (got: ${line})`,
    );
  });

  assert.match(text, /\n\nExamples:\n/);

  let cursor = text.indexOf('Examples:');
  for (const scope of OPTION_SCOPES) {
    const title = `${scope.title}:\n`;
    const titleIndex = text.indexOf(title, cursor);
    assert.notEqual(titleIndex, -1, `${scope.title} section missing or out of order`);
    cursor = titleIndex + title.length;
  }

  for (const scope of OPTION_SCOPES) {
    const sectionStart = text.indexOf(`${scope.title}:\n`);
    const remainder = text.slice(sectionStart);
    const nextScopeStarts = OPTION_SCOPES
      .filter((other) => other !== scope)
      .map((other) => remainder.indexOf(`${other.title}:\n`))
      .filter((i) => i > 0);
    const sectionEnd = nextScopeStarts.length ? Math.min(...nextScopeStarts) : remainder.length;
    const sectionText = remainder.slice(0, sectionEnd);

    const scopedOptions = COMMAND_OPTIONS.filter((opt) => opt.scopes.includes(scope.name));
    assert.notEqual(scopedOptions.length, 0, `${scope.title} should declare at least one option`);

    let optionCursor = 0;
    for (const option of scopedOptions) {
      const flagToken = `--${option.name}`;
      const idx = sectionText.indexOf(flagToken, optionCursor);
      assert.notEqual(idx, -1, `${scope.title} should include --${option.name} in declared order`);
      optionCursor = idx + flagToken.length;
    }
  }
}

test('command registry exposes a frozen list of named runnable entries', () => {
  assert.equal(Object.isFrozen(COMMAND_REGISTRY), true);
  assert.ok(COMMAND_REGISTRY.length > 0, 'command registry should not be empty');

  const names = COMMAND_REGISTRY.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, 'command names should be unique');

  for (const command of COMMAND_REGISTRY) {
    assert.equal(Object.isFrozen(command), true, `${command.name} metadata should be frozen`);
    assert.equal(typeof command.name, 'string');
    assert.ok(command.name.length > 0, 'command name should be non-empty');
    assert.ok(Array.isArray(command.aliases), `${command.name} aliases should be an array`);
    assert.equal(Object.isFrozen(command.aliases), true, `${command.name} aliases should be frozen`);
    assert.equal(typeof command.run, 'function', `${command.name} should define a runner`);
    assert.equal(typeof command.helpUsage, 'string', `${command.name} should declare helpUsage`);
    assert.equal(typeof command.helpDescription, 'string', `${command.name} should declare helpDescription`);
  }
});

test('help command rows are generated from the registry', async () => {
  const { stdout } = await captureConsole(() => main(['node', 'cli', 'help']));

  assert.equal(commandBlock(stdout[0]), formatCommandHelpRows());
});

test('help aliases resolve to the help command', () => {
  const help = commandForName('help');

  assert.equal(commandForName('--help'), help);
  assert.equal(commandForName('-h'), help);
});

test('main dispatches help aliases through the registry', async () => {
  const { result, stdout, stderr, exitCode } = await captureConsole(() => main(['node', 'cli', '-h']));

  assert.equal(result.exitCode, 0);
  assert.equal(exitCode, undefined);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  assertHelpLayout(stdout[0]);
});

test('main preserves unknown command exit behavior', async () => {
  const { result, stdout, stderr, exitCode } = await captureConsole(() => main(['node', 'cli', 'nope']));

  assert.equal(result.exitCode, 1);
  assert.equal(exitCode, 1);
  assert.deepEqual(stderr, ['Unknown command: nope']);
  assert.equal(stdout.length, 1);
  assertHelpLayout(stdout[0]);
});

test('main accepts room --retries through CLI validation and applies it', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir('commands-com-cli-test-');
  try {
    const binDir = path.join(cwd, 'bin');
    const providerLog = path.join(cwd, 'provider.log');
    await writeTransientClaudeProvider(binDir);

    const { result, stdout, stderr, exitCode } = await withEnv({
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      CLI_ROOM_PROVIDER_LOG: providerLog,
    }, () => captureConsole(() => main([
      'node',
      'cli',
      'room',
      'security',
      'retry through cli',
      '--cwd',
      cwd,
      '--provider',
      'claude',
      '--participants',
      '1',
      '--retries',
      '1',
    ])));

    assert.equal(result.exitCode, 0);
    assert.equal(exitCode, undefined);
    assert.deepEqual(stderr, []);
    // The retry contract is human-only (the room JSON payload doesn't expose
    // retry counts), so narrow the log assertion to the single most stable
    // substring instead of matching the full prefixed log line.
    assert.ok(
      stdout.some((line) => typeof line === 'string' && line.includes('retry 1/1 after transient provider failure')),
      `expected retry log line, got: ${JSON.stringify(stdout)}`,
    );
    assert.deepEqual((await fs.readFile(providerLog, 'utf8')).trim().split('\n'), [
      'participant',
      'participant',
    ]);

    const runsRoot = path.join(cwd, '.commands-com', 'runs');
    const [runId] = await fs.readdir(runsRoot);
    const runDir = path.join(runsRoot, runId);
    const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.providerRetries, 1);
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'claude', 'threat-modeler.md'), 'utf8'),
      /Retried CLI room output/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('main rejects missing --cwd paths with resolved path detail', async () => {
  const cwd = await tempDir('commands-com-cli-test-');
  try {
    await assert.rejects(
      () => withWorkingDirectory(cwd, () => main(['node', 'cli', 'help', '--cwd', 'missing'])),
      (error) => isCwdPathError(error, '--cwd path does not exist:', 'missing'),
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('main rejects non-directory --cwd paths with resolved path detail', async () => {
  const cwd = await tempDir('commands-com-cli-test-');
  try {
    await fs.writeFile(path.join(cwd, 'file.txt'), 'not a directory\n', 'utf8');

    await assert.rejects(
      () => withWorkingDirectory(cwd, () => main(['node', 'cli', 'help', '--cwd', 'file.txt'])),
      (error) => isCwdPathError(error, '--cwd must be a directory:', 'file.txt'),
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function isCwdPathError(error, prefix, leafName) {
  if (error.name !== 'UsageError' || !error.message.startsWith(`${prefix} `)) {
    return false;
  }
  const detail = error.message.slice(prefix.length + 1);
  return path.isAbsolute(detail)
    && (detail.endsWith(`${path.sep}${leafName}`)
      || detail.endsWith(`/${leafName}`)
      || detail.endsWith(`\\${leafName}`));
}
