import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadRunState,
  openResumeStore,
  RUN_STATE_VERSION,
  serializeCycleOptions,
  serializeProvider,
  writeRunState,
} from '../src/run-state.js';
import { tempDir } from './support/cli.js';
import { memoryStore } from './support/memory-store.js';

async function writeRunStateFile(dir, payload) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run-state.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('loadRunState rejects mismatched versions instead of restamping', async () => {
  const cwd = await tempDir();
  try {
    const runDir = path.join(cwd, 'mismatched-run');
    await writeRunStateFile(runDir, {
      version: RUN_STATE_VERSION + 1,
      status: 'running',
    });

    await assert.rejects(
      loadRunState(cwd, runDir),
      /unsupported run-state version: 2 \(expected 1\)/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('loadRunState treats pre-versioned state as version 1 when shape is valid', async () => {
  const cwd = await tempDir();
  try {
    const runDir = path.join(cwd, 'legacy-run');
    await writeRunStateFile(runDir, {
      status: 'running',
      kind: 'review',
      cycles: [{ cycle: 1, score: 'B' }],
    });

    const loaded = await loadRunState(cwd, runDir);

    assert.equal(loaded.state.version, RUN_STATE_VERSION);
    assert.equal(loaded.state.status, 'running');
    assert.equal(loaded.state.kind, 'review');
    assert.deepEqual(loaded.state.cycles, [{ cycle: 1, score: 'B' }]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('loadRunState normalizes status and clamps stalledCycles', async () => {
  const cwd = await tempDir();
  try {
    const runDir = path.join(cwd, 'normalization-run');
    await writeRunStateFile(runDir, {
      version: RUN_STATE_VERSION,
      status: 0,
      kind: 'quality',
      runId: 123,
      storeDir: null,
      workspace: 'invalid',
      context: { repoRoot: '/repo' },
      options: 'invalid',
      cycles: 'invalid',
      providerSessions: {
        'codex/areas/all-areas': 'thread-123',
        empty: '',
      },
      priorFindings: false,
      hasUnresolvedTestFailure: 1,
      stalledCycles: -4,
      stopReason: 0,
    });

    const loaded = await loadRunState(cwd, runDir);

    assert.equal(loaded.dir, runDir);
    assert.equal(loaded.runId, 'normalization-run');
    assert.deepEqual(loaded.state, {
      version: RUN_STATE_VERSION,
      status: '0',
      kind: 'quality',
      runId: '123',
      storeDir: '',
      workspace: {},
      context: { repoRoot: '/repo' },
      options: {},
      cycles: [],
      providerSessions: {
        'codex/areas/all-areas': 'thread-123',
      },
      priorFindings: 'false',
      hasUnresolvedTestFailure: true,
      stalledCycles: 0,
      stopReason: '0',
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('loadRunState treats non-number stalledCycles as invalid', async () => {
  const cwd = await tempDir();
  try {
    const runDir = path.join(cwd, 'string-stalled-run');
    await writeRunStateFile(runDir, {
      version: RUN_STATE_VERSION,
      stalledCycles: '4',
    });

    const loaded = await loadRunState(cwd, runDir);

    assert.equal(loaded.state.stalledCycles, 0);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('serializeProvider keeps JSON-safe provider fields only', () => {
  const provider = {
    id: 'codex',
    label: 'Codex',
    retries: 0,
    enabled: false,
    value: null,
    args: ['--json'],
    metadata: { tier: 'local' },
    run() {},
    missing: undefined,
    token: Symbol('provider-token'),
    apiKey: 'secret-api-key',
    accessToken: 'secret-access-token',
    clientSecret: 'secret-client',
    env: {
      OPENAI_API_KEY: 'secret-env-key',
      SAFE_PROVIDER_MODE: 'json',
    },
  };

  assert.deepEqual(serializeProvider(provider), {
    id: 'codex',
    label: 'Codex',
    retries: 0,
    enabled: false,
    value: null,
    args: ['--json'],
    metadata: { tier: 'local' },
    env: {
      SAFE_PROVIDER_MODE: 'json',
    },
  });
  assert.equal(serializeProvider('mock'), 'mock');
  assert.equal(serializeProvider(null), null);
});

test('serializeProvider filters provider class instances without passing them through', () => {
  class Connection {
    constructor(name) {
      this.name = name;
    }
  }

  class ProviderCandidate {
    constructor() {
      this.id = 'custom';
      this.label = 'Custom';
      this.retries = 1;
      this.args = ['--json', new Connection('socket'), { safe: true, nested: new Connection('nested') }];
      this.metadata = { tier: 'local', connection: new Connection('metadata') };
      this.connection = new Connection('root');
      this.token = 'secret-token';
      this.apiKey = 'secret-api-key';
      this.headers = {
        authorization: 'Bearer secret-token',
        accept: 'application/json',
      };
    }

    run() {}
  }

  const provider = new ProviderCandidate();
  const serialized = serializeProvider(provider);

  assert.notEqual(serialized, provider);
  assert.deepEqual(serialized, {
    id: 'custom',
    label: 'Custom',
    retries: 1,
    args: ['--json', { safe: true }],
    metadata: { tier: 'local' },
    headers: { accept: 'application/json' },
  });
});

test('serializeCycleOptions serializes provider selections', () => {
  const primaryProvider = {
    id: 'mock',
    label: 'Mock',
    adapter() {},
  };
  const fallbackProvider = {
    id: 'codex',
    model: 'gpt-test',
    metadata: { supportsJson: true },
    invoke() {},
  };

  assert.deepEqual(serializeCycleOptions({
    providers: [primaryProvider, fallbackProvider],
    primaryProvider,
    providerIds: ['mock', 'codex'],
    model: 'gpt-test',
    customOption: 'preserved',
  }), {
    providers: [
      { id: 'mock', label: 'Mock' },
      { id: 'codex', model: 'gpt-test', metadata: { supportsJson: true } },
    ],
    primaryProvider: { id: 'mock', label: 'Mock' },
    providerIds: ['mock', 'codex'],
    model: 'gpt-test',
    customOption: 'preserved',
  });

  assert.deepEqual(serializeCycleOptions(null), {
    providers: [],
    primaryProvider: undefined,
  });
});

test('writeRunState writes a normalized run-state payload', async () => {
  const store = memoryStore({ dir: '/tmp/run-1' });
  const provider = {
    id: 'mock',
    label: 'Mock',
    execute() {},
  };

  const writtenPath = await writeRunState({
    kind: 'review',
    store,
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main' },
    options: {
      providers: [provider],
      primaryProvider: provider,
      maxCycles: 2,
    },
    cycles: [{ cycle: 1, score: 'B' }],
    providerSessions: {
      'mock/reviewers/01-correctness': 'mock-session-1',
    },
    priorFindings: 'existing findings',
    hasUnresolvedTestFailure: true,
    stalledCycles: -1,
    stopReason: '',
  }, {
    status: 'failed',
    error: new Error('validation failed'),
  });

  assert.equal(writtenPath, '/tmp/run-1/run-state.json');
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].name, 'run-state.json');

  const payload = store.writes[0].value;
  assert.equal(payload.version, RUN_STATE_VERSION);
  assert.equal(payload.status, 'failed');
  assert.equal(Number.isNaN(Date.parse(payload.updatedAt)), false);
  assert.equal(payload.kind, 'review');
  assert.equal(payload.runId, 'run-1');
  assert.equal(payload.storeDir, '/tmp/run-1');
  assert.deepEqual(payload.workspace, { mode: 'current', cwd: '/repo' });
  assert.deepEqual(payload.context, { repoRoot: '/repo', branch: 'main' });
  assert.deepEqual(payload.options, {
    providers: [{ id: 'mock', label: 'Mock' }],
    primaryProvider: { id: 'mock', label: 'Mock' },
    maxCycles: 2,
  });
  assert.deepEqual(payload.cycles, [{ cycle: 1, score: 'B' }]);
  assert.deepEqual(payload.providerSessions, {
    'mock/reviewers/01-correctness': 'mock-session-1',
  });
  assert.equal(payload.priorFindings, 'existing findings');
  assert.equal(payload.hasUnresolvedTestFailure, true);
  assert.equal(payload.stalledCycles, 0);
  assert.equal(payload.stopReason, '');
  assert.equal(payload.error, 'validation failed');

  assert.equal(await writeRunState({}, { status: 'completed' }), '');
});

test('openResumeStore opens a writable store for an existing run directory', async () => {
  const cwd = await tempDir();
  try {
    const runDir = path.join(cwd, 'resume-run');
    await fs.mkdir(runDir, { recursive: true });

    const store = await openResumeStore(cwd, runDir);
    const writtenPath = await store.writeJson('nested/state.json', { ok: true });

    assert.equal(store.runId, 'resume-run');
    assert.equal(store.dir, runDir);
    assert.equal(writtenPath, path.join(runDir, 'nested/state.json'));
    assert.deepEqual(
      JSON.parse(await fs.readFile(writtenPath, 'utf8')),
      { ok: true },
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
