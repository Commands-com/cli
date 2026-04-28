import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createRoomSynthesisArtifacts,
  runProviderSynthesisWithFallback,
  runSynthesisWithFallback,
} from '../src/cycle-synthesis.js';
import { DEFAULT_TIMEOUT_MS } from '../src/provider-limits.js';
import { tempDir } from './support/cli.js';

function localStore(dir) {
  return {
    async write(name, content) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(content || ''), 'utf8');
      return filePath;
    },
  };
}

function memoryLogger() {
  const messages = [];
  return {
    messages,
    info(message) {
      messages.push(message);
    },
  };
}

async function writeFailingProvider(binDir, commandName, message) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, commandName);
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      `printf '%s\\n' '${message}' >&2`,
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
  return provider;
}

test('runProviderSynthesisWithFallback writes prompt and synthesis artifacts on success', async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    const storeDir = path.join(cwd, 'store');
    const logger = memoryLogger();
    const prompt = [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","synthesisIssueCount":0} -->',
    ].join('\n');

    const result = await runProviderSynthesisWithFallback({
      providerCall: {
        provider: { id: 'mock', command: '' },
        model: '',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        providerRetries: 0,
        cwd,
      },
      artifacts: createRoomSynthesisArtifacts({
        store: localStore(storeDir),
        provider: { id: 'mock' },
      }),
      logging: {
        logger,
        complete: 'synthesis: complete',
      },
      prompt,
      fallbackDescription: 'source outputs',
    });

    assert.equal(result.synthesisProvider, 'mock');
    assert.equal(result.synthesisError, '');
    assert.match(result.synthesisText, /Mock synthesis/);
    assert.deepEqual(logger.messages, [
      'synthesis (mock)',
      'synthesis: complete',
    ]);
    assert.equal(await fs.readFile(path.join(storeDir, 'prompts/synthesis-mock.md'), 'utf8'), prompt);
    assert.equal(await fs.readFile(path.join(storeDir, 'synthesis.md'), 'utf8'), result.synthesisText);
    await assert.rejects(fs.stat(path.join(storeDir, 'synthesis-error.md')), /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runSynthesisWithFallback writes cycle error artifact and returns fallback state on failure', async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    const storeDir = path.join(cwd, 'store');
    const logger = memoryLogger();
    const prompt = 'Synthesize provider outputs.';

    const result = await runSynthesisWithFallback({
      context: { repoRoot: cwd },
      store: localStore(storeDir),
      logger,
      synthesisRuntimeOptions: {
        primaryProvider: { id: 'unsupported-test-provider', command: '' },
        model: '',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        providerRetries: 0,
      },
    }, {
      cycle: 2,
      prompt,
      fallbackDescription: 'provider outputs',
    });

    assert.equal(result.synthesisProvider, 'unsupported-test-provider');
    assert.equal(result.synthesisText, '');
    assert.match(result.synthesisError, /unsupported provider: unsupported-test-provider/);
    assert.deepEqual(logger.messages, [
      'cycle 2: synthesis (unsupported-test-provider)',
      'cycle 2: synthesis failed (unsupported-test-provider); using provider outputs',
    ]);
    assert.equal(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-2-synthesis-unsupported-test-provider.md'), 'utf8'),
      prompt,
    );
    assert.match(
      await fs.readFile(path.join(storeDir, 'cycle-2/synthesis-error.md'), 'utf8'),
      /unsupported provider: unsupported-test-provider/,
    );
    await assert.rejects(fs.stat(path.join(storeDir, 'cycle-2/synthesis.md')), /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runProviderSynthesisWithFallback preserves fallback text for non-Error failures', async () => {
  const logger = memoryLogger();
  const result = await runProviderSynthesisWithFallback({
    providerCall: {
      provider: { id: 'mock', command: '' },
      model: '',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      providerRetries: 0,
      cwd: process.cwd(),
    },
    artifacts: /** @type {any} */ ({
      writePrompt() {
        return Promise.reject('plain synthesis failure');
      },
      writeOutput() {
        throw new Error('writeOutput should not run');
      },
      writeError() {
        throw new Error('writeError should not run');
      },
    }),
    logging: {
      logger,
      prefix: 'cycle 4: ',
    },
    prompt: 'Synthesize provider outputs.',
    fallbackDescription: 'provider outputs',
  });

  assert.deepEqual(result, {
    synthesisProvider: 'mock',
    synthesisText: '',
    synthesisError: 'plain synthesis failure',
  });
  assert.deepEqual(logger.messages, [
    'cycle 4: synthesis (mock)',
    'cycle 4: synthesis failed (mock); using provider outputs',
  ]);
});

test('runSynthesisWithFallback accepts explicit synthesis dependencies', async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    const storeDir = path.join(cwd, 'store');
    const logger = memoryLogger();
    const prompt = [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","synthesisIssueCount":0} -->',
    ].join('\n');

    const result = await runSynthesisWithFallback({
      context: { repoRoot: cwd },
      store: localStore(storeDir),
      logger,
      synthesisRuntimeOptions: {
        primaryProvider: { id: 'mock' },
        model: '',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        providerRetries: 0,
      },
    }, {
      cycle: 3,
      prompt,
      fallbackDescription: 'reviewer summaries',
    });

    assert.equal(result.synthesisProvider, 'mock');
    assert.equal(result.synthesisError, '');
    assert.match(result.synthesisText, /Mock synthesis/);
    assert.deepEqual(logger.messages, [
      'cycle 3: synthesis (mock)',
    ]);
    assert.equal(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-3-synthesis-mock.md'), 'utf8'),
      prompt,
    );
    assert.equal(
      await fs.readFile(path.join(storeDir, 'cycle-3/synthesis.md'), 'utf8'),
      result.synthesisText,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runSynthesisWithFallback tries provider fallbacks for transient failures', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    const storeDir = path.join(cwd, 'store');
    const logger = memoryLogger();
    const failingClaude = await writeFailingProvider(path.join(cwd, 'bin'), 'claude', 'Selected model is at capacity');
    const prompt = [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","synthesisIssueCount":0} -->',
    ].join('\n');

    const result = await runSynthesisWithFallback({
      context: { repoRoot: cwd },
      store: localStore(storeDir),
      logger,
      synthesisRuntimeOptions: {
        providers: [{ id: 'claude', command: failingClaude }, { id: 'mock' }],
        primaryProvider: { id: 'claude', command: failingClaude },
        model: '',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        providerRetries: 0,
      },
    }, {
      cycle: 5,
      prompt,
      fallbackDescription: 'reviewer summaries',
    });

    assert.equal(result.synthesisProvider, 'mock');
    assert.equal(result.synthesisError, '');
    assert.match(result.synthesisText, /Mock synthesis/);
    assert.ok(logger.messages.includes('cycle 5: synthesis fallback claude -> mock'));
    assert.equal(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-5-synthesis-mock.md'), 'utf8'),
      prompt,
    );
    assert.match(
      await fs.readFile(path.join(storeDir, 'cycle-5/synthesis-errors/claude.md'), 'utf8'),
      /Selected model is at capacity/,
    );
    await assert.rejects(fs.stat(path.join(storeDir, 'cycle-5/synthesis-error.md')), /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runSynthesisWithFallback rejects dependencies without synthesisRuntimeOptions', async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    const synthesisRuntimeOptions = {
      primaryProvider: { id: 'mock' },
      model: '',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      providerRetries: 0,
    };

    await assert.rejects(
      runSynthesisWithFallback({
        context: { repoRoot: cwd },
        store: localStore(path.join(cwd, 'store')),
        logger: memoryLogger(),
        runtimeOptions: synthesisRuntimeOptions,
      }, {
        cycle: 4,
        prompt: 'Synthesize provider outputs.',
        fallbackDescription: 'provider outputs',
      }),
      /runSynthesisWithFallback requires dependencies\.synthesisRuntimeOptions/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runProviderSynthesisWithFallback requires structured artifact writers', async () => {
  const cwd = await tempDir('commands-com-cycle-synthesis-test-');
  try {
    await assert.rejects(
      runProviderSynthesisWithFallback({
        providerCall: {
          provider: { id: 'mock', command: '' },
          model: '',
          timeoutMs: DEFAULT_TIMEOUT_MS,
          providerRetries: 0,
          cwd,
        },
        artifacts: /** @type {any} */ ({
          store: localStore(path.join(cwd, 'store')),
          promptPath: 'prompts/synthesis-mock.md',
          outputPath: 'synthesis.md',
          errorPath: 'synthesis-error.md',
        }),
        prompt: 'Synthesize provider outputs.',
        fallbackDescription: 'provider outputs',
      }),
      /requires artifacts\.writePrompt/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
