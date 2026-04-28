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
import {
  recordStoreWrite,
  shSingleQuote,
  writeExecutable,
} from './support/provider-item-fixtures.js';

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
      artifacts: /** @type {any} */ ({ writeOutput() {} }),
    }),
    /runProviderItem requires artifacts\.writePrompt/,
  );
  await assert.rejects(
    runProviderItem({
      ...baseArgs,
      artifacts: /** @type {any} */ ({ writePrompt() {} }),
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
        path: outputPath,
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
