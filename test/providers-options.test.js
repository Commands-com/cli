import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderInvocation } from '../src/provider-invocation.js';
import { buildSpawnTarget } from '../src/provider-os-shell.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  resolveProviderLimits,
} from '../src/provider-limits.js';

test('resolveProviderLimits centralizes provider runtime defaults', () => {
  assert.deepEqual(resolveProviderLimits({}), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
  assert.deepEqual(resolveProviderLimits({ timeoutMs: 123, maxOutputBytes: 456 }), {
    timeoutMs: 123,
    maxOutputBytes: 456,
  });
  assert.deepEqual(resolveProviderLimits({ timeoutMs: Number.NaN, maxOutputBytes: Infinity }), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
});

test('codex invocation uses stdin and read-only sandbox without tools', () => {
  const invocation = buildProviderInvocation(
    { id: 'codex', command: 'codex' },
    { prompt: 'hello', model: 'gpt-test', allowTools: false },
  );
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args.slice(0, 2), ['exec', '--json']);
  assert.ok(invocation.args.includes('--sandbox'));
  assert.ok(invocation.args.includes('read-only'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdin, 'hello');
});

test('claude invocation allows read-only tools for review-only calls', () => {
  const invocation = buildProviderInvocation(
    { id: 'claude', command: 'claude' },
    { prompt: 'hello', model: '', allowTools: false },
  );
  assert.ok(invocation.args.includes('--permission-mode'));
  assert.ok(invocation.args.includes('dontAsk'));
  const toolsIdx = invocation.args.indexOf('--tools');
  assert.notEqual(toolsIdx, -1);
  assert.equal(invocation.args[toolsIdx + 1], 'Read,Grep,Glob,LS');
  assert.ok(!invocation.args.includes('Edit'));
  assert.ok(!invocation.args.includes('Write'));
});

test('gemini invocation uses yolo only when tools are allowed', () => {
  const review = buildProviderInvocation(
    { id: 'gemini', command: 'gemini' },
    { prompt: 'hello', model: '', allowTools: false },
  );
  const fix = buildProviderInvocation(
    { id: 'gemini', command: 'gemini' },
    { prompt: 'hello', model: '', allowTools: true },
  );
  assert.ok(review.args.includes('--approval-mode'));
  assert.ok(!review.args.includes('--yolo'));
  const promptIdx = review.args.indexOf('--prompt');
  assert.notEqual(promptIdx, -1, 'gemini must enter headless mode via --prompt');
  assert.equal(
    review.args[promptIdx + 1],
    '',
    'gemini --prompt value must be empty so the real prompt flows cleanly via stdin',
  );
  assert.equal(review.stdin, 'hello');
  assert.ok(fix.args.includes('--yolo'));
  assert.ok(fix.args.includes('--prompt'));
});

test('buildProviderInvocation rejects --model values that contain shell metacharacters', () => {
  const evil = 'foo & echo INJECTED';
  for (const id of ['codex', 'claude', 'gemini']) {
    assert.throws(
      () => buildProviderInvocation({ id, command: id }, { prompt: 'x', model: evil, allowTools: false }),
      /invalid --model value/,
      `${id} must reject shell metacharacters in --model`,
    );
  }
  // Control: a plausible real model name passes.
  assert.doesNotThrow(() => buildProviderInvocation(
    { id: 'claude', command: 'claude' },
    { prompt: 'x', model: 'claude-3-7-sonnet-20250219', allowTools: false },
  ));
});

test('buildSpawnTarget routes Windows .cmd/.bat shims through cmd.exe with quoted args and never passes user args under shell:true', () => {
  const invocation = {
    command: 'C:\\npm\\gemini.cmd',
    args: ['--output-format', 'json', '--prompt', '', '--model', 'gemini-pro'],
  };
  const target = buildSpawnTarget(invocation, 'win32');
  assert.match(String(target.command), /cmd\.exe$/i);
  assert.deepEqual(target.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.equal(target.windowsVerbatimArguments, true);
  const line = target.args[4];
  assert.ok(line.startsWith('C:\\npm\\gemini.cmd '), `unexpected shim line: ${line}`);
  // Empty `--prompt` arg must be passed as `""` so cmd.exe does not collapse it.
  assert.ok(line.includes('--prompt ""'), `empty prompt not preserved: ${line}`);
});

test('buildSpawnTarget spawns non-Windows providers directly with no shell metadata', () => {
  const invocation = { command: '/usr/local/bin/gemini', args: ['--model', 'gemini-pro'] };
  const target = buildSpawnTarget(invocation, 'linux');
  assert.equal(target.command, '/usr/local/bin/gemini');
  assert.deepEqual(target.args, ['--model', 'gemini-pro']);
  assert.equal(target.windowsVerbatimArguments, false);
});

test('buildSpawnTarget double-quotes arguments containing cmd.exe metacharacters', () => {
  const target = buildSpawnTarget({
    command: 'C:\\npm\\gemini.cmd',
    args: ['plain', '', 'a b', 'foo & echo X', 'a"b', 'a b\\'],
  }, 'win32');

  // Trailing backslash before the closing quote must be doubled per
  // CreateProcessW rules, otherwise it would escape the terminator.
  assert.equal(
    target.args[4],
    'C:\\npm\\gemini.cmd plain "" "a b" "foo & echo X" "a\\"b" "a b\\\\"',
  );
});

test('buildSpawnTarget shells out only for Windows .cmd/.bat shims', () => {
  for (const command of ['C:\\npm\\gemini.cmd', 'C:\\npm\\gemini.CMD', 'C:\\npm\\gemini.bat']) {
    const target = buildSpawnTarget({ command, args: [] }, 'win32');
    assert.match(String(target.command), /cmd\.exe$/i);
    assert.equal(target.windowsVerbatimArguments, true);
  }

  /** @type {Array<{ command: string, platform: NodeJS.Platform }>} */
  const cases = [
    { command: 'C:\\npm\\gemini.exe', platform: 'win32' },
    { command: 'C:\\npm\\gemini', platform: 'win32' },
    { command: '/usr/local/bin/gemini.cmd', platform: 'linux' },
    { command: '/usr/local/bin/gemini', platform: 'darwin' },
  ];
  for (const { command, platform } of cases) {
    const target = buildSpawnTarget({ command, args: [] }, platform);
    assert.equal(target.command, command);
    assert.equal(target.windowsVerbatimArguments, false);
  }
});
