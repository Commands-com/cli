import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createProviderItemRunArtifacts,
  runProviderItem,
} from '../src/provider-item-workflow.js';
import { tempDir } from './support/cli.js';
import { memoryStore } from './support/memory-store.js';

function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function writeExecutable(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeTransientCodexBin({ dir, successText }) {
  const bin = path.join(dir, 'codex');
  await writeExecutable(bin, [
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
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'stream disconnected before completion',
    }))}`,
    '  exit 1',
    'fi',
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: successText },
    }))}`,
  ]);
  return bin;
}

function memoryArtifacts(events = []) {
  return {
    promptPath: 'prompt.md',
    outputPath: 'output.md',
    async writePrompt(prompt) {
      events.push({ method: 'writePrompt', text: prompt });
    },
    async writeOutput(text) {
      events.push({ method: 'writeOutput', text });
    },
  };
}

function recordStoreWrite(events) {
  return ({ name, value }) => {
    events.push({ method: 'store.write', path: name, text: value });
  };
}

test('runProviderItem validates required artifact writers', async () => {
  const provider = { id: 'mock', command: '' };
  const baseArgs = {
    provider,
    label: 'maintainability',
    prompt: 'prompt',
    cwd: process.cwd(),
    retry: {
      retries: 0,
    },
  };

  await assert.rejects(
    runProviderItem({
      ...baseArgs,
      artifacts: { writeOutput() {} },
    }),
    /runProviderItem requires artifacts\.writePrompt/,
  );
  await assert.rejects(
    runProviderItem({
      ...baseArgs,
      artifacts: { writePrompt() {} },
    }),
    /runProviderItem requires artifacts\.writeOutput/,
  );
});

test('runProviderItem writes the prompt before provider execution and output after success', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const prompt = 'prompt artifact text';
    const promptPath = path.join(dir, 'prompt.md');
    const outputPath = path.join(dir, 'output.md');
    const eventsPath = path.join(dir, 'events.log');
    const bin = path.join(dir, 'codex');
    const providerText = 'provider output text';

    await writeExecutable(bin, [
      '#!/bin/sh',
      `if [ "$(cat ${shSingleQuote(promptPath)} 2>/dev/null)" != ${shSingleQuote(prompt)} ]; then`,
      `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
        type: 'error',
        message: 'prompt artifact missing before provider execution',
      }))}`,
      '  exit 1',
      'fi',
      `printf '%s\\n' provider >> ${shSingleQuote(eventsPath)}`,
      `printf '%s\\n' ${shSingleQuote(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: providerText },
      }))}`,
    ]);

    const result = await runProviderItem({
      provider: { id: 'codex', command: bin },
      label: 'maintainability',
      prompt,
      artifacts: {
        promptPath,
        outputPath,
        async writePrompt(value) {
          await fs.writeFile(promptPath, value, 'utf8');
          await fs.appendFile(eventsPath, 'prompt\n', 'utf8');
        },
        async writeOutput(value) {
          await fs.writeFile(outputPath, value, 'utf8');
          await fs.appendFile(eventsPath, 'output\n', 'utf8');
        },
      },
      cwd: dir,
      timeoutMs: 5_000,
      retry: {
        retries: 0,
      },
    });

    assert.equal(result.text, providerText);
    assert.equal(await fs.readFile(outputPath, 'utf8'), providerText);
    assert.deepEqual(
      (await fs.readFile(eventsPath, 'utf8')).trim().split('\n'),
      ['prompt', 'provider', 'output'],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runProviderItem writes failure artifacts through artifactPolicy.writeFailure', async () => {
  const events = [];
  const store = memoryStore({ onWrite: recordStoreWrite(events) });
  const artifacts = createProviderItemRunArtifacts({
    store,
    promptPath: 'prompt.md',
    outputPath: 'output.md',
  });
  const failureCalls = [];

  await assert.rejects(
    runProviderItem({
      provider: { id: 'unsupported-test-provider', command: '' },
      label: 'maintainability',
      prompt: 'prompt',
      artifacts,
      cwd: process.cwd(),
      retry: {
        retries: 0,
      },
      artifactPolicy: {
        writeFailure: async (args) => {
          failureCalls.push(args);
          await store.write('failure.md', args.error.message);
        },
      },
    }),
    /unsupported provider: unsupported-test-provider/,
  );

  assert.deepEqual(
    store.writes.map((write) => write.name),
    ['prompt.md', 'failure.md'],
  );
  assert.equal(store.writes[0].value, 'prompt');
  assert.match(store.writes[1].value, /unsupported provider: unsupported-test-provider/);
  assert.deepEqual(events.map((event) => event.path), ['prompt.md', 'failure.md']);
  assert.equal(events[0].text, 'prompt');
  assert.match(events[1].text, /unsupported provider: unsupported-test-provider/);
  assert.equal(failureCalls.length, 1);
  assert.equal(failureCalls[0].provider.id, 'unsupported-test-provider');
  assert.equal(failureCalls[0].label, 'maintainability');
  assert.equal(failureCalls[0].artifact, artifacts);
  assert.match(failureCalls[0].error.message, /unsupported provider: unsupported-test-provider/);
});

test('runProviderItem rejects blank provider output through writeFailure', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const bin = path.join(dir, 'codex');
    await writeExecutable(bin, [
      '#!/bin/sh',
      `printf '%s\\n' ${shSingleQuote(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '   \n\t  ' },
      }))}`,
    ]);
    const events = [];
    const store = memoryStore({ onWrite: recordStoreWrite(events) });
    const artifacts = createProviderItemRunArtifacts({
      store,
      promptPath: 'prompt.md',
      outputPath: 'output.md',
    });
    const failureCalls = [];

    await assert.rejects(
      runProviderItem({
        provider: { id: 'codex', command: bin },
        label: 'maintainability',
        prompt: 'prompt',
        artifacts,
        cwd: dir,
        timeoutMs: 5_000,
        retry: { retries: 0 },
        artifactPolicy: {
          writeFailure: async (args) => {
            failureCalls.push(args);
            await store.write('failure.md', args.error.message);
          },
        },
      }),
      /codex\/maintainability: provider returned empty output/,
    );

    // The output artifact is never written for empty provider text — only
    // the prompt and the failure artifact are persisted.
    assert.deepEqual(
      store.writes.map((write) => write.name),
      ['prompt.md', 'failure.md'],
    );
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0].provider.id, 'codex');
    assert.equal(failureCalls[0].label, 'maintainability');
    assert.match(failureCalls[0].error.message, /provider returned empty output/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runProviderItem logs default retry messages', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const bin = await writeTransientCodexBin({ dir, successText: 'retry succeeded' });
    const messages = [];

    const result = await runProviderItem({
      provider: { id: 'codex', command: bin },
      label: 'maintainability',
      prompt: 'prompt',
      artifacts: memoryArtifacts(),
      cwd: dir,
      timeoutMs: 5_000,
      retry: {
        retries: 1,
        delayMs: 0,
      },
      logger: {
        info(message) {
          messages.push(message);
        },
      },
    });

    assert.equal(result.text, 'retry succeeded');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /codex/);
    assert.match(messages[0], /maintainability/);
    assert.match(messages[0], /retry 1\/1/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runProviderItem uses retry policy logMessage output when provided', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const bin = await writeTransientCodexBin({ dir, successText: 'custom retry succeeded' });
    const messages = [];

    const result = await runProviderItem({
      provider: { id: 'codex', command: bin },
      label: 'synthesis',
      prompt: 'prompt',
      artifacts: memoryArtifacts(),
      cwd: dir,
      timeoutMs: 5_000,
      retry: {
        retries: 1,
        delayMs: 0,
        logMessage: ({ provider, label, retry, retries }) => (
          `${label}:${provider.id}:${retry}/${retries}`
        ),
      },
      logger: {
        info(message) {
          messages.push(message);
        },
      },
    });

    assert.equal(result.text, 'custom retry succeeded');
    assert.deepEqual(messages, ['synthesis:codex:1/1']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runProviderItem writes retry artifacts through artifactPolicy.writeRetry before retry logging', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  try {
    const bin = await writeTransientCodexBin({ dir, successText: 'retry artifact succeeded' });
    const events = [];
    const store = memoryStore({ onWrite: recordStoreWrite(events) });
    const artifacts = createProviderItemRunArtifacts({
      store,
      promptPath: 'prompt.md',
      outputPath: 'output.md',
    });
    const retryCalls = [];

    const result = await runProviderItem({
      provider: { id: 'codex', command: bin },
      label: 'implementation',
      prompt: 'prompt',
      artifacts,
      cwd: dir,
      timeoutMs: 5_000,
      retry: {
        retries: 1,
        delayMs: 0,
      },
      logger: {
        info(message) {
          events.push({ method: 'log', text: message });
        },
      },
      artifactPolicy: {
        writeRetry: async (args) => {
          retryCalls.push(args);
          await store.write(`attempt-${args.retry}-error.md`, args.error.message);
        },
      },
    });

    assert.equal(result.text, 'retry artifact succeeded');
    assert.deepEqual(
      events.map((event) => (event.method === 'log' ? event.method : event.path)),
      ['prompt.md', 'attempt-1-error.md', 'log', 'output.md'],
    );
    assert.equal(store.writes[0].value, 'prompt');
    assert.match(store.writes[1].value, /stream disconnected/);
    assert.equal(store.writes[2].value, 'retry artifact succeeded');
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0].provider.id, 'codex');
    assert.equal(retryCalls[0].label, 'implementation');
    assert.equal(retryCalls[0].artifact, artifacts);
    assert.equal(retryCalls[0].retry, 1);
    assert.equal(retryCalls[0].retries, 1);
    assert.match(retryCalls[0].error.message, /stream disconnected/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
