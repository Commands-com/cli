import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractProviderText } from '../src/provider-output.js';
import { resolveProvider, resolveProviders } from '../src/provider-registry.js';

test('resolveProvider skips non-executable shadows and finds the real executable later on PATH', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-path-'));
  const shadowDir = path.join(tmp, 'shadow');
  const realDir = path.join(tmp, 'real');
  await fs.mkdir(shadowDir);
  await fs.mkdir(realDir);
  const binName = 'codex';
  const shadow = path.join(shadowDir, binName);
  const real = path.join(realDir, binName);
  await fs.writeFile(shadow, '#!/bin/sh\necho shadow\n', 'utf8');
  await fs.chmod(shadow, 0o644); // non-executable
  await fs.writeFile(real, '#!/bin/sh\necho real\n', 'utf8');
  await fs.chmod(real, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shadowDir}${path.delimiter}${realDir}`;
  try {
    const provider = await resolveProvider(binName);
    assert.deepEqual(provider, { id: binName, command: real, path: real });
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProvider rejects names that contain path separators', async () => {
  await assert.rejects(resolveProvider('../bin/custom'), /must not contain path separators/);
  await assert.rejects(resolveProvider('subdir\\evil'), /must not contain path separators/);
});

test('resolveProvider rejects unsupported provider names before command lookup', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-unsupported-'));
  const originalPath = process.env.PATH;
  try {
    const provider = path.join(tmp, 'custom-provider');
    await fs.writeFile(provider, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(provider, 0o755);
    process.env.PATH = tmp;

    await assert.rejects(
      resolveProvider('custom-provider'),
      /unsupported provider: custom-provider/,
    );
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProviders all returns every real provider found and excludes mock by default', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-providers-'));
  const originalPath = process.env.PATH;
  try {
    for (const name of ['codex', 'claude']) {
      const bin = path.join(tmp, name);
      await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
      await fs.chmod(bin, 0o755);
    }
    process.env.PATH = tmp;
    const providers = await resolveProviders('all');
    assert.deepEqual(providers.map((provider) => provider.id), ['codex', 'claude']);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProviders supports explicit mixed provider lists', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-providers-'));
  const originalPath = process.env.PATH;
  try {
    const codex = path.join(tmp, 'codex');
    await fs.writeFile(codex, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(codex, 0o755);
    process.env.PATH = tmp;
    const providers = await resolveProviders('codex,mock,codex');
    assert.deepEqual(providers.map((provider) => provider.id), ['codex', 'mock']);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('extractProviderText reads common Claude and Gemini JSON shapes', () => {
  assert.equal(extractProviderText('claude', JSON.stringify({ result: 'claude result' })), 'claude result');
  assert.equal(extractProviderText('gemini', JSON.stringify({ response: 'gemini response' })), 'gemini response');
  assert.equal(extractProviderText('gemini', JSON.stringify({ text: 'plain text' })), 'plain text');
});
