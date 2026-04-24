import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectProviders,
  resolveProvider,
  resolveProviders,
} from '../src/provider-registry.js';
import {
  adapterRunsDirectly,
  adapterSupportsPathLookup,
  providerAdapters,
} from '../src/provider-adapters.js';

const EXPECTED_PROVIDER_IDS = ['codex', 'claude', 'gemini', 'mock'];
const EXPECTED_EXECUTABLE_PROVIDER_IDS = ['codex', 'claude', 'gemini'];

test('provider adapters expose a valid capability shape', () => {
  assert.deepEqual(providerAdapters().map((adapter) => adapter.id), EXPECTED_PROVIDER_IDS);

  for (const adapter of providerAdapters()) {
    assert.equal(Object.isFrozen(adapter), true, `${adapter.id} adapter must be frozen`);
    assert.equal(Object.isFrozen(adapter.capabilities), true, `${adapter.id} capabilities must be frozen`);
    assert.equal(typeof adapter.capabilities.directRun, 'boolean', `${adapter.id} directRun capability`);
    assert.equal(typeof adapter.capabilities.pathLookup, 'boolean', `${adapter.id} pathLookup capability`);
    assert.notEqual(
      adapter.capabilities.directRun,
      adapter.capabilities.pathLookup,
      `${adapter.id} must choose exactly one execution capability`,
    );
    assert.equal(adapterRunsDirectly(adapter), adapter.capabilities.directRun);
    assert.equal(adapterSupportsPathLookup(adapter), adapter.capabilities.pathLookup);
    assert.equal(typeof adapter.output, 'string', `${adapter.id} output descriptor`);
    assert.notEqual(adapter.output.trim(), '', `${adapter.id} output descriptor`);

    if (adapterRunsDirectly(adapter)) {
      assert.equal(adapter.commandName, undefined, `${adapter.id} direct adapter commandName`);
      assert.equal(adapter.invocation, undefined, `${adapter.id} direct adapter invocation`);
      assert.equal(typeof adapter.run, 'function', `${adapter.id} direct adapter run`);
      assert.equal(typeof adapter.path, 'string', `${adapter.id} direct adapter path`);
      continue;
    }

    assert.equal(typeof adapter.commandName, 'string', `${adapter.id} path adapter commandName`);
    assert.notEqual(adapter.commandName.trim(), '', `${adapter.id} path adapter commandName`);
    assert.equal(typeof adapter.invocation, 'string', `${adapter.id} path adapter invocation`);
    assert.notEqual(adapter.invocation.trim(), '', `${adapter.id} path adapter invocation`);
    assert.equal(adapter.run, undefined, `${adapter.id} path adapter run`);
  }
});

function replaceProviderPath(value) {
  const originalPath = process.env.PATH;
  const originalWindowsPath = process.env.Path;
  process.env.PATH = value;
  process.env.Path = value;
  return () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalWindowsPath === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = originalWindowsPath;
    }
  };
}

test('provider registry availability follows adapter order', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-adapters-'));
  const originalPath = process.env.PATH;
  try {
    for (const id of ['gemini', 'codex', 'claude']) {
      const bin = path.join(tmp, id);
      await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
      await fs.chmod(bin, 0o755);
    }
    process.env.PATH = tmp;

    const detected = await detectProviders();
    assert.deepEqual(detected.map((row) => row.id), EXPECTED_PROVIDER_IDS);
    assert.deepEqual(detected.map((row) => row.available), [true, true, true, true]);

    const resolved = await resolveProviders('all');
    assert.deepEqual(resolved.map((provider) => provider.id), EXPECTED_EXECUTABLE_PROVIDER_IDS);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('every provider adapter id is a valid explicit selector', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-selector-adapters-'));
  const restorePath = replaceProviderPath(tmp);
  try {
    const adapters = providerAdapters();
    for (const adapter of adapters.filter(adapterSupportsPathLookup)) {
      const bin = path.join(tmp, adapter.commandName);
      await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
      await fs.chmod(bin, 0o755);
    }

    const resolved = await resolveProviders(adapters.map((adapter) => adapter.id).join(','));
    assert.deepEqual(resolved.map((provider) => provider.id), adapters.map((adapter) => adapter.id));
  } finally {
    restorePath();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProvider rejects unsupported provider ids before PATH lookup', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-unsupported-'));
  const restorePath = replaceProviderPath(tmp);
  try {
    const unsupported = path.join(tmp, 'unsupported-provider');
    await fs.writeFile(unsupported, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(unsupported, 0o755);

    await assert.rejects(
      resolveProvider('unsupported-provider'),
      /unsupported provider: unsupported-provider/,
    );
  } finally {
    restorePath();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProvider reports missing registered provider CLIs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-missing-'));
  const restorePath = replaceProviderPath(tmp);
  try {
    await assert.rejects(
      resolveProvider('codex'),
      /provider 'codex' was not found on PATH/,
    );
  } finally {
    restorePath();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProviders validates explicit list names before resolving registered CLIs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-list-validation-'));
  const restorePath = replaceProviderPath(tmp);
  try {
    await assert.rejects(
      resolveProviders('codex,unsupported-provider'),
      /unsupported provider: unsupported-provider/,
    );
  } finally {
    restorePath();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveProviders all deduplicates explicit providers and allows mock after real providers', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-all-mock-'));
  const originalPath = process.env.PATH;
  try {
    const codex = path.join(tmp, 'codex');
    await fs.writeFile(codex, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(codex, 0o755);
    process.env.PATH = tmp;

    const resolved = await resolveProviders('all,codex,mock,codex,mock');
    assert.deepEqual(resolved.map((provider) => provider.id), ['codex', 'mock']);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
