import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderAdapter, providerAdapters } from '../src/provider-adapters.js';
import { createProviderItemRunArtifacts } from '../src/provider-item-workflow.js';
import {
  appendCapped,
  extractGenericProviderText,
  extractGenericProviderSessionId,
  extractProviderSessionId,
  extractProviderSessionIdForAdapter,
  extractProviderText,
  extractProviderTextForAdapter,
  providerFailureDetails,
} from '../src/provider-output.js';

function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

const OUTPUT_CASES = [
  {
    id: 'codex',
    stdout: jsonl([
      { type: 'item.completed', item: { type: 'agent_message', text: 'progress' } },
      { type: 'turn.completed', result: 'codex final' },
    ]),
    expected: 'codex final',
  },
  {
    id: 'claude',
    stdout: JSON.stringify({ result: 'claude result' }),
    expected: 'claude result',
  },
  {
    id: 'gemini',
    stdout: JSON.stringify({ response: 'gemini response' }),
    expected: 'gemini response',
  },
];

const OUTPUT_DESCRIPTOR_CONTRACTS = Object.freeze({
  'codex-jsonl': Object.freeze({
    stdout: jsonl([
      { type: 'item.completed', item: { type: 'agent_message', text: 'draft text' } },
      { type: 'turn.completed', result: 'descriptor result' },
    ]),
    expected: 'descriptor result',
  }),
  generic: Object.freeze({
    stdout: JSON.stringify({ text: 'descriptor text' }),
    expected: 'descriptor text',
  }),
});

test('provider output extraction follows adapter parser contracts', () => {
  for (const { id, stdout, expected } of OUTPUT_CASES) {
    const adapter = getProviderAdapter(id);
    assert.equal(extractProviderTextForAdapter(adapter, stdout), expected);
    assert.equal(extractProviderText(id, stdout), expected);
  }
});

test('provider session extraction follows adapter parser contracts', () => {
  assert.equal(
    extractProviderSessionId('codex', jsonl([
      { type: 'thread.started', thread_id: 'codex-thread-1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    ])),
    'codex-thread-1',
  );
  assert.equal(extractProviderSessionId('claude', JSON.stringify({ session_id: 'claude-session-1' })), 'claude-session-1');
  assert.equal(extractProviderSessionId('gemini', JSON.stringify({ sessionId: 'gemini-session-1' })), 'gemini-session-1');
  assert.equal(
    extractGenericProviderSessionId([
      'warning before json',
      JSON.stringify({ conversation_id: 'conversation-1', text: 'done' }),
    ].join('\n')),
    'conversation-1',
  );
  assert.equal(
    extractProviderSessionIdForAdapter(getProviderAdapter('mock'), JSON.stringify({ text: 'no session' })),
    '',
  );
});

test('every provider adapter output descriptor resolves to extraction behavior', () => {
  for (const adapter of providerAdapters()) {
    const contract = OUTPUT_DESCRIPTOR_CONTRACTS[adapter.output];
    assert.ok(contract, `${adapter.id} output descriptor '${adapter.output}' must have a contract sample`);
    assert.equal(
      extractProviderTextForAdapter(adapter, contract.stdout),
      contract.expected,
      `${adapter.id} output descriptor '${adapter.output}' must resolve`,
    );
  }
});

test('generic output extraction remains the fallback for unknown providers', () => {
  assert.equal(extractGenericProviderText(JSON.stringify({ text: 'custom text' })), 'custom text');
  assert.equal(extractProviderText('custom', JSON.stringify({ text: 'custom text' })), 'custom text');
  assert.equal(extractProviderText('custom', 'plain output'), 'plain output');
});

test('generic output extraction returns the trimmed text for non-object JSON payloads', () => {
  assert.equal(extractGenericProviderText('null'), 'null');
  assert.equal(extractGenericProviderText('"plain string"'), '"plain string"');
  assert.equal(extractGenericProviderText('42'), '42');
  assert.equal(extractGenericProviderText('[1,2,3]'), '[1,2,3]');
});

test('provider item artifact reserved keys override colliding metadata', async () => {
  const writes = [];
  const store = {
    write(path, text) {
      writes.push({ path, text });
    },
  };
  const metadataWritePrompt = () => {
    throw new Error('metadata writePrompt should not be used');
  };
  const metadataWriteOutput = () => {
    throw new Error('metadata writeOutput should not be used');
  };

  const artifacts = createProviderItemRunArtifacts({
    store,
    promptPath: 'prompts/provider-item.md',
    outputPath: 'outputs/provider-item.md',
    metadata: {
      promptPath: 'metadata/prompt.md',
      outputPath: 'metadata/output.md',
      path: 'metadata/path.md',
      writePrompt: metadataWritePrompt,
      writeOutput: metadataWriteOutput,
      providerId: 'codex',
    },
  });

  assert.equal(artifacts.promptPath, 'prompts/provider-item.md');
  assert.equal(artifacts.outputPath, 'outputs/provider-item.md');
  assert.equal(artifacts.path, 'outputs/provider-item.md');
  assert.notEqual(artifacts.writePrompt, metadataWritePrompt);
  assert.notEqual(artifacts.writeOutput, metadataWriteOutput);
  assert.equal(artifacts.providerId, 'codex');

  await artifacts.writePrompt('prompt text');
  await artifacts.writeOutput('output text');

  assert.deepEqual(writes, [
    { path: 'prompts/provider-item.md', text: 'prompt text' },
    { path: 'outputs/provider-item.md', text: 'output text' },
  ]);
});

test('provider output parsing handles malformed and partial payloads without throwing', () => {
  const rawObject = Object.create(null);
  const cases = [
    {
      label: 'malformed JSON',
      providerId: 'claude',
      stdout: '{"result":"unterminated"',
      expected: '{"result":"unterminated"',
    },
    {
      label: 'partial markdown JSON payload',
      providerId: 'gemini',
      stdout: [
        '```json',
        '{"response":"incomplete"',
      ].join('\n'),
      expected: [
        '```json',
        '{"response":"incomplete"',
      ].join('\n'),
    },
    {
      label: 'empty output',
      providerId: 'claude',
      stdout: '   ',
      expected: '',
    },
    {
      label: 'unexpected JSON object shape',
      providerId: 'gemini',
      stdout: JSON.stringify({ response: { text: 'nested' }, text: ['array'] }),
      expected: JSON.stringify({ response: { text: 'nested' }, text: ['array'] }),
    },
    {
      label: 'unexpected raw object shape',
      providerId: 'claude',
      stdout: rawObject,
      expected: '',
    },
    {
      label: 'unexpected codex raw object shape',
      providerId: 'codex',
      stdout: rawObject,
      expected: '',
    },
    {
      label: 'truncated codex JSONL',
      providerId: 'codex',
      stdout: jsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'last complete message' } },
        '{"type":"turn.completed","result":"truncated final',
      ]),
      expected: 'last complete message',
    },
    {
      label: 'fully truncated codex JSONL',
      providerId: 'codex',
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"partial',
      expected: '{"type":"item.completed","item":{"type":"agent_message","text":"partial',
    },
  ];

  for (const { label, providerId, stdout, expected } of cases) {
    let extracted = null;
    let details = null;

    assert.doesNotThrow(() => {
      extracted = extractProviderText(providerId, stdout);
    }, label);
    assert.equal(extracted, expected, label);

    assert.doesNotThrow(() => {
      details = providerFailureDetails({ id: providerId }, stdout, '', 200);
    }, `${label} diagnostics`);
    assert.equal(typeof details, 'string', label);
    assert.ok(details.length > 0, label);
  }
});

test('provider failure details tolerate missing provider and unusual stderr shapes', () => {
  const throwingStderr = {
    toString() {
      throw new Error('cannot stringify stderr');
    },
  };

  let details = null;
  assert.doesNotThrow(() => {
    details = providerFailureDetails(null, JSON.stringify({ text: 'fallback text' }), throwingStderr, 200);
  });

  assert.equal(details, 'stdout: fallback text');
});

test('codex output extraction keeps the last assistant message before a turn result', () => {
  const stdout = jsonl([
    { type: 'item.completed', item: { type: 'agent_message', text: 'first message' } },
    { type: 'item.completed', item: { type: 'message', text: 'second message' } },
  ]);

  assert.equal(extractProviderText('codex', stdout), 'second message');
});

test('codex output extraction reads assistant content block arrays', () => {
  const stdout = jsonl([
    {
      type: 'item.completed',
      item: {
        type: 'message',
        content: [
          { type: 'text', text: 'first block' },
          { type: 'reasoning', text: 'internal block' },
          { type: 'output_text', text: 'second block' },
        ],
      },
    },
  ]);

  assert.equal(extractProviderText('codex', stdout), 'first block\nsecond block');
});

test('codex turn.completed result takes precedence over assistant messages', () => {
  const stdout = jsonl([
    { type: 'item.completed', item: { type: 'agent_message', text: 'draft answer' } },
    { type: 'turn.completed', result: 'final answer' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'late stream fragment' } },
  ]);

  assert.equal(extractProviderText('codex', stdout), 'final answer');
});

test('codex output extraction ignores non-json lines and truncated partial jsonl', () => {
  const stdout = [
    'debug log before json',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'complete message' } }),
    '{"type":"item.completed","item":{"type":"agent_message","text":"truncated',
  ].join('\n');

  assert.equal(extractProviderText('codex', stdout), 'complete message');
});

test('provider failure details use adapter diagnostics only when provided', () => {
  const codexStdout = jsonl([
    { type: 'progress', message: 'tool call still running' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'making progress' } },
    { type: 'error', message: 'stream disconnected before completion' },
  ]);
  const codexDetails = providerFailureDetails({ id: 'codex' }, codexStdout, '', 1_000);
  assert.match(codexDetails, /stdout error: stream disconnected before completion/);
  assert.match(codexDetails, /stdout progress: tool call still running/);
  assert.match(codexDetails, /stdout last message: making progress/);

  const claudeDetails = providerFailureDetails(
    { id: 'claude' },
    JSON.stringify({ result: 'claude result' }),
    '',
    1_000,
  );
  assert.equal(claudeDetails, 'stdout: claude result');
});

test('provider failure details ignore truncated codex jsonl fragments', () => {
  const codexStdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last complete message' } }),
    JSON.stringify({ type: 'error', message: 'complete error' }),
    '{"type":"error","message":"partial error',
  ].join('\n');

  const codexDetails = providerFailureDetails({ id: 'codex' }, codexStdout, '', 1_000);
  assert.match(codexDetails, /stdout error: complete error/);
  assert.match(codexDetails, /stdout last message: last complete message/);
  assert.doesNotMatch(codexDetails, /partial error/);
});

test('appendCapped preserves UTF-8 boundaries when byte cap lands inside a 4-byte sequence', () => {
  const face = String.fromCodePoint(0x1F600);
  const chunk = Buffer.from(`A${face}B`, 'utf8');

  for (const cap of [2, 3, 4]) {
    const result = appendCapped('', chunk, cap);
    assert.equal(result.truncated, true);
    assert.equal(result.value, 'A');
    assert.ok(Buffer.byteLength(result.value, 'utf8') <= cap);
    assert.ok(!result.value.includes('\uFFFD'));
  }

  const exactBoundary = appendCapped('', chunk, 5);
  assert.equal(exactBoundary.truncated, true);
  assert.equal(exactBoundary.value, `A${face}`);
  assert.ok(!exactBoundary.value.includes('\uFFFD'));
});

test('appendCapped discards incomplete binary UTF-8 suffixes without emitting replacement characters', () => {
  const splitFourByteSuffix = Buffer.from([0x41, 0xF0, 0x9F, 0x98]);
  const result = appendCapped('', splitFourByteSuffix, 10);

  assert.equal(result.truncated, true);
  assert.equal(result.value, 'A');
  assert.ok(!result.value.includes('\uFFFD'));
});
