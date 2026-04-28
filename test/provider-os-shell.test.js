import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnTarget } from '../src/provider-os-shell.js';

test('buildSpawnTarget spawns non-Windows commands directly', () => {
  const args = ['--model', 'provider-pro', '--prompt', 'hello'];
  const target = buildSpawnTarget({
    command: '/usr/local/bin/provider',
    args,
  }, 'linux');

  assert.deepEqual(target, {
    command: '/usr/local/bin/provider',
    args,
    windowsVerbatimArguments: false,
  });
});

test('buildSpawnTarget routes Windows cmd and bat shims through cmd.exe', () => {
  for (const command of ['C:\\npm\\provider.cmd', 'C:\\npm\\provider.CMD', 'C:\\npm\\provider.bat']) {
    const target = buildSpawnTarget({ command, args: ['--version'] }, 'win32');

    assert.match(target.command, /cmd\.exe$/i);
    assert.deepEqual(target.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.equal(target.args[4], `${command} --version`);
    assert.equal(target.windowsVerbatimArguments, true);
  }
});

test('buildSpawnTarget does not shell non-shim commands or non-Windows cmd files', () => {
  /** @type {Array<{ command: string, platform: NodeJS.Platform }>} */
  const cases = [
    { command: 'C:\\npm\\provider.exe', platform: 'win32' },
    { command: 'C:\\npm\\provider', platform: 'win32' },
    { command: '/usr/local/bin/provider.cmd', platform: 'darwin' },
  ];
  for (const { command, platform } of cases) {
    const target = buildSpawnTarget({ command, args: [] }, platform);

    assert.equal(target.command, command);
    assert.deepEqual(target.args, []);
    assert.equal(target.windowsVerbatimArguments, false);
  }
});

test('buildSpawnTarget quotes Windows shim arguments without collapsing boundaries', () => {
  const target = buildSpawnTarget({
    command: 'C:\\Program Files\\nodejs\\provider.cmd',
    args: [
      '--empty',
      '',
      '--space',
      'two words',
      '--meta',
      'left&right',
      '--quote',
      'say "hello"',
      '--path',
      'C:\\tmp\\space dir\\',
    ],
  }, 'win32');

  assert.equal(target.windowsVerbatimArguments, true);
  assert.equal(
    target.args[4],
    '""C:\\Program Files\\nodejs\\provider.cmd" --empty "" --space "two words" --meta "left&right" --quote "say \\"hello\\"" --path "C:\\tmp\\space dir\\\\""',
  );
});

test('buildSpawnTarget preserves Windows shim argument edge cases', () => {
  const cases = [
    {
      name: 'literal percent expansion',
      args: ['--literal', '%TEMP%'],
      expectedLine: 'C:\\npm\\provider.cmd --literal ^%TEMP^%',
    },
    {
      name: 'percent-encoded literals',
      args: ['--literal', 'encoded%20and%2F'],
      expectedLine: 'C:\\npm\\provider.cmd --literal encoded^%20and^%2F',
    },
    {
      name: 'delayed expansion marker',
      args: ['--literal', '!VAR!'],
      expectedLine: 'C:\\npm\\provider.cmd --literal "!VAR!"',
    },
    {
      name: 'quoted string',
      args: ['--literal', 'say "hello"'],
      expectedLine: 'C:\\npm\\provider.cmd --literal "say \\"hello\\""',
    },
    {
      name: 'metacharacters',
      args: ['--literal', 'left&right|next<in>out^caret'],
      expectedLine: 'C:\\npm\\provider.cmd --literal "left&right|next<in>out^caret"',
    },
    {
      name: 'trailing backslash after spaces',
      args: ['--literal', 'C:\\tmp\\space dir\\'],
      expectedLine: 'C:\\npm\\provider.cmd --literal "C:\\tmp\\space dir\\\\"',
    },
  ];

  for (const { name, args, expectedLine } of cases) {
    const target = buildSpawnTarget({
      command: 'C:\\npm\\provider.cmd',
      args,
    }, 'win32');

    assert.deepEqual(target.args.slice(0, 4), ['/d', '/s', '/v:off', '/c'], name);
    assert.equal(target.args[4], expectedLine, name);
    assert.equal(target.windowsVerbatimArguments, true, name);
  }
});

test('buildSpawnTarget round-trips Windows cmd shim argv through cmd.exe', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'commands-provider-shell-'));
  try {
    const fixtureDir = join(root, 'fixture with spaces');
    await mkdir(fixtureDir);
    const recorderPath = join(fixtureDir, 'record-argv.mjs');
    const commandPath = join(fixtureDir, 'provider.cmd');
    await writeFile(recorderPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    await writeFile(
      commandPath,
      `@echo off\r\n"${batchLiteral(process.execPath)}" "${batchLiteral(recorderPath)}" %*\r\n`,
    );

    const expectedArgv = [
      '%TEMP%',
      'encoded%20and%2F',
      'left^right',
      'say "hello"',
      'two words',
    ];
    const target = buildSpawnTarget({
      command: commandPath,
      args: expectedArgv,
    }, 'win32');

    assert.deepEqual(await spawnJson(target, { cwd: root }), expectedArgv);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function batchLiteral(value) {
  return value.replaceAll('%', '%%');
}

async function spawnJson(target, { cwd }) {
  const { stdout } = await spawnAndCollect(target, { cwd });
  return JSON.parse(stdout);
}

async function spawnAndCollect(target, { cwd }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`provider.cmd exited with code ${code} signal ${signal || 'none'}: ${stderr}`));
    });
  });
}
