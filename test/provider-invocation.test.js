import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderInvocation } from '../src/provider-invocation.js';
import {
  adapterRunsDirectly,
  adapterSupportsPathLookup,
  getProviderAdapter,
  providerAdapters,
} from '../src/provider-adapters.js';
import { buildSpawnTarget } from '../src/provider-os-shell.js';
import { extractProviderTextForAdapter } from '../src/provider-output.js';

const EXPECTED_PROVIDER_IDS = ['codex', 'claude', 'gemini', 'mock'];

const INVOCATION_CASES = [
  {
    id: 'codex',
    options: { prompt: 'hello', model: 'test-model', allowTools: false, resumeSessionId: '' },
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'test-model',
      '--sandbox',
      'read-only',
      '--config',
      'mcp_servers={}',
      '-',
    ],
  },
  {
    id: 'codex',
    options: { prompt: 'hello', model: '', allowTools: true, resumeSessionId: 'thread-123' },
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--config',
      'mcp_servers={}',
      'resume',
      'thread-123',
      '-',
    ],
  },
  {
    id: 'claude',
    options: { prompt: 'hello', model: 'test-model', allowTools: false },
    args: [
      '--print',
      '--output-format',
      'json',
      '--model',
      'test-model',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,LS',
    ],
  },
  {
    id: 'claude',
    options: { prompt: 'hello', model: '', allowTools: true, resumeSessionId: 'claude-session-123' },
    args: [
      '--print',
      '--output-format',
      'json',
      '--resume',
      'claude-session-123',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ],
  },
  {
    id: 'gemini',
    options: { prompt: 'hello', model: 'test-model', allowTools: false },
    args: [
      '--output-format',
      'json',
      '--prompt',
      '',
      '--model',
      'test-model',
      '--approval-mode',
      'plan',
    ],
  },
  {
    id: 'gemini',
    options: { prompt: 'hello', model: '', allowTools: true, resumeSessionId: 'gemini-session-123' },
    args: [
      '--output-format',
      'json',
      '--prompt',
      '',
      '--resume',
      'gemini-session-123',
      '--yolo',
    ],
  },
];

test('provider adapters define the real provider contract', () => {
  assert.deepEqual(providerAdapters().map((adapter) => adapter.id), EXPECTED_PROVIDER_IDS);

  for (const adapter of providerAdapters()) {
    assert.equal(getProviderAdapter(adapter.id), adapter);
    assert.equal(Object.isFrozen(adapter), true);
    assert.equal(Object.isFrozen(adapter.capabilities), true);
    assert.equal(Object.hasOwn(adapter, 'builtIn'), false);
    assert.equal(typeof adapter.output, 'string');

    if (adapterRunsDirectly(adapter)) {
      assert.equal(adapter.commandName, undefined);
      assert.equal(typeof adapter.run, 'function');
      assert.equal(adapter.path, 'built-in');
      assert.equal(adapterSupportsPathLookup(adapter), false);
    } else {
      assert.equal(adapterSupportsPathLookup(adapter), true);
      assert.equal(adapter.commandName, adapter.id);
      assert.equal(adapter.run, undefined);
      assert.equal(typeof adapter.invocation, 'string');
    }
  }

  assert.equal(getProviderAdapter('CODEX').id, 'codex');
  assert.equal(getProviderAdapter('MOCK').id, 'mock');
});

function stdoutForOutputContract(output) {
  if (output === 'codex-jsonl') {
    return [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'draft output' } }),
      JSON.stringify({ type: 'turn.completed', result: 'adapter output' }),
    ].join('\n');
  }
  if (output === 'generic') {
    return JSON.stringify({ text: 'adapter output' });
  }
  throw new Error(`missing output contract sample for '${output}'`);
}

test('provider adapter capabilities resolve to invocation and output behavior', () => {
  for (const adapter of providerAdapters()) {
    assert.equal(
      extractProviderTextForAdapter(adapter, stdoutForOutputContract(adapter.output)),
      'adapter output',
      `${adapter.id} output descriptor must resolve to extraction behavior`,
    );

    if (adapterSupportsPathLookup(adapter)) {
      const invocation = buildProviderInvocation(
        { id: adapter.id, command: `/providers/${adapter.id}` },
        { prompt: 'contract prompt', model: '', allowTools: false },
      );

      assert.equal(invocation.command, `/providers/${adapter.id}`);
      assert.equal(invocation.stdin, 'contract prompt');
      assert.ok(invocation.args.length > 0, `${adapter.id} invocation descriptor must resolve to args`);
      continue;
    }

    assert.equal(adapterRunsDirectly(adapter), true);
    assert.equal(typeof adapter.run, 'function');
  }
});

test('provider adapters build stable invocation arguments', () => {
  for (const { id, options, args } of INVOCATION_CASES) {
    const provider = { id, command: `/providers/${id}` };
    const invocation = buildProviderInvocation(provider, options);

    assert.equal(invocation.command, provider.command);
    assert.deepEqual(invocation.args, args);
    assert.equal(invocation.stdin, options.prompt);
  }
});

test('provider invocation keeps Windows shim quoting behavior intact', () => {
  const invocation = buildProviderInvocation(
    { id: 'gemini', command: 'C:\\npm\\gemini.cmd' },
    { prompt: 'hello', model: '', allowTools: false },
  );
  const target = buildSpawnTarget(invocation, 'win32');

  assert.equal(target.windowsVerbatimArguments, true);
  assert.deepEqual(target.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(target.args[4], /^C:\\npm\\gemini\.cmd /);
  assert.match(target.args[4], /--prompt ""/);
  assert.match(target.args[4], /--approval-mode plan/);
});

test('buildSpawnTarget doubles trailing backslashes before a closing quote', () => {
  const target = buildSpawnTarget({
    command: 'C:\\npm\\npx.cmd',
    args: ['--first', 'C:\\Program Files\\Commands\\', '--second', 'C:\\tmp\\space dir\\'],
  }, 'win32');

  assert.equal(
    target.args[4],
    'C:\\npm\\npx.cmd --first "C:\\Program Files\\Commands\\\\" --second "C:\\tmp\\space dir\\\\"',
  );
});

test('buildSpawnTarget escapes quotes after a backslash run without dropping the backslashes', () => {
  const target = buildSpawnTarget({
    command: 'C:\\npm\\npx.cmd',
    args: ['--message', 'a\\"b'],
  }, 'win32');

  assert.equal(target.args[4], 'C:\\npm\\npx.cmd --message "a\\\\\\"b"');
});

test('buildSpawnTarget quotes Windows shim arguments containing cmd edge characters', () => {
  for (const char of ['&', '|', '<', '>', '^', '%', '!', ',', ';', '=']) {
    const target = buildSpawnTarget({
      command: 'C:\\npm\\npx.cmd',
      args: ['--literal', `left${char}right`],
    }, 'win32');

    assert.equal(target.args[4], `C:\\npm\\npx.cmd --literal "left${char}right"`);
  }
});

test('buildSpawnTarget quotes Windows shim commands and arguments with trailing backslashes', () => {
  const target = buildSpawnTarget({
    command: 'C:\\Program Files\\nodejs\\npx.cmd',
    args: ['--prompt', '', '--path', 'C:\\tmp\\space dir\\'],
  }, 'win32');

  assert.equal(target.windowsVerbatimArguments, true);
  assert.equal(
    target.args[4],
    '""C:\\Program Files\\nodejs\\npx.cmd" --prompt "" --path "C:\\tmp\\space dir\\\\""',
  );
});

test('buildSpawnTarget keeps Windows shim edge characters inside quoted arguments', () => {
  const target = buildSpawnTarget({
    command: 'C:\\Program Files\\nodejs\\npx.cmd',
    args: ['--literal', 'a&b|c<d>e^f%g!h,i;j=k', '--empty', ''],
  }, 'win32');

  assert.equal(target.windowsVerbatimArguments, true);
  assert.equal(
    target.args[4],
    '""C:\\Program Files\\nodejs\\npx.cmd" --literal "a&b|c<d>e^f%g!h,i;j=k" --empty """',
  );
});

test('buildSpawnTarget preserves Windows shim boundaries around quotes and trailing backslashes', () => {
  const target = buildSpawnTarget({
    command: 'C:\\Program Files\\nodejs\\npx.cmd',
    args: ['--message', 'say "hello"', '--path', 'C:\\tmp\\quoted "dir"\\', '--empty', ''],
  }, 'win32');

  assert.equal(target.windowsVerbatimArguments, true);
  assert.equal(
    target.args[4],
    '""C:\\Program Files\\nodejs\\npx.cmd" --message "say \\"hello\\"" --path "C:\\tmp\\quoted \\"dir\\"\\\\" --empty """',
  );
});

test('provider invocation still rejects unsupported provider ids', () => {
  assert.throws(
    () => buildProviderInvocation(
      { id: 'custom', command: 'custom' },
      { prompt: 'hello', model: '', allowTools: false },
    ),
    /unsupported provider: custom/,
  );
});
