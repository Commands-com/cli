import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runSynthesisWithFallback,
} from '../src/cycle-synthesis.js';
import { createCyclePhaseView } from '../src/cycle-state.js';
import { runCycleWorkflow } from '../src/cycle-workflow.js';
import { runShell, scopedWorktreeCwd } from '../src/workflow.js';
import { initGitRepo, run, tempDir } from './support/cli.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function nodeCommand(script) {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

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

const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

test('runShell resolves timeout results without rejecting', { skip: process.platform === 'win32' }, async () => {
  const result = await runShell(
    nodeCommand('setTimeout(() => {}, 1000);'),
    process.cwd(),
    { timeoutMs: 50 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 124);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
});

test('runShell caps stdout and stderr on UTF-8 boundaries', { skip: process.platform === 'win32' }, async () => {
  const faceExpr = 'String.fromCodePoint(0x1F600)';
  const result = await runShell(
    nodeCommand(`process.stdout.write('A' + ${faceExpr} + 'B'); process.stderr.write('E' + ${faceExpr} + 'F');`),
    process.cwd(),
    { timeoutMs: 5_000, maxOutputBytes: 5 },
  );
  const face = String.fromCodePoint(0x1F600);

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `A${face}`);
  assert.equal(result.stderr, `E${face}`);
  assert.ok(!result.stdout.includes('\uFFFD'));
  assert.ok(!result.stderr.includes('\uFFFD'));
});

test('runSynthesisWithFallback uses provider settings from state.options', async () => {
  const cwd = await tempDir('commands-com-workflow-');
  try {
    const storeDir = path.join(cwd, 'store');
    const prompt = [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","synthesisIssueCount":0} -->',
    ].join('\n');
    const state = {
      kind: 'review',
      primaryProvider: { id: 'stale-top-level-provider' },
      json: false,
      context: { repoRoot: cwd },
      store: localStore(storeDir),
      options: {
        primaryProvider: { id: 'mock' },
        json: true,
        model: '',
        timeoutMs: 30_000,
        providerRetries: 0,
      },
    };

    const result = await runSynthesisWithFallback(createCyclePhaseView(state), {
      cycle: 1,
      prompt,
      fallbackDescription: 'reviewer summaries',
    });

    assert.equal(result.synthesisProvider, 'mock');
    assert.equal(result.synthesisError, '');
    assert.match(result.synthesisText, /Mock synthesis/);
    assert.equal(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-1-synthesis-mock.md'), 'utf8'),
      prompt,
    );
    await assert.rejects(
      fs.readFile(path.join(storeDir, 'prompts/cycle-1-synthesis-stale-top-level-provider.md'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCycleWorkflow writes shared setup artifacts at stable top-level paths', async () => {
  const cwd = await tempDir('commands-com-workflow-');
  try {
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map([
        ['provider', 'mock'],
        ['max-cycles', '1'],
      ]),
    }, {
      cwd,
      kind: 'review',
      label: 'shared setup artifacts',
      metadata: {
        source: 'workflow-test',
      },
      logger: silentLogger,
      adapter: {},
      dependencies: { runAssessmentCycles: async () => {} },
    });

    const contextText = await fs.readFile(path.join(state.store.dir, 'context.md'), 'utf8');
    assert.match(contextText, new RegExp(`Repository: ${state.context.repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await assert.rejects(fs.stat(path.join(state.store.dir, 'context')), /ENOENT/);

    const metadata = JSON.parse(await fs.readFile(path.join(state.store.dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.kind, 'review');
    assert.equal(metadata.provider, 'mock');
    assert.deepEqual(metadata.providers, ['mock']);
    assert.equal(metadata.source, 'workflow-test');
    assert.equal(metadata.workspace.mode, 'current');
    assert.equal(Number.isNaN(Date.parse(metadata.createdAt)), false);
    await assert.rejects(fs.stat(path.join(state.store.dir, 'metadata-json')), /ENOENT/);

    const preflight = JSON.parse(await fs.readFile(path.join(state.store.dir, 'preflight.json'), 'utf8'));
    assert.equal(preflight.ok, true);
    const runState = JSON.parse(await fs.readFile(path.join(state.store.dir, 'run-state.json'), 'utf8'));
    assert.equal(runState.status, 'completed');
    assert.equal(runState.kind, 'review');
    assert.deepEqual(runState.cycles, []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('scopedWorktreeCwd keeps in-repo scopes that happen to start with dot-dot', () => {
  const volumeRoot = path.parse(process.cwd()).root;
  const gitRoot = path.join(volumeRoot, 'repo');
  const isolated = { path: path.join(volumeRoot, 'tmp', 'commands-worktree') };

  assert.equal(
    scopedWorktreeCwd(/** @type {any} */ ({ gitRoot, repoRoot: path.join(gitRoot, '..pkg') }), /** @type {any} */ (isolated)),
    path.join(isolated.path, '..pkg'),
  );
  assert.equal(
    scopedWorktreeCwd(/** @type {any} */ ({ gitRoot, repoRoot: path.join(gitRoot, 'packages', 'app') }), /** @type {any} */ (isolated)),
    path.join(isolated.path, 'packages', 'app'),
  );
  assert.equal(
    scopedWorktreeCwd(/** @type {any} */ ({ gitRoot, repoRoot: path.resolve(gitRoot, '..', 'outside-repo') }), /** @type {any} */ (isolated)),
    isolated.path,
  );
});

test('runCycleWorkflow prunes unchanged isolated worktrees when cycle execution fails', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = await tempDir('commands-com-workflow-');
  /** @type {any} */
  let workspace;
  try {
    await initGitRepo(cwd);
    const scopedDir = path.join(cwd, '..pkg');
    await fs.mkdir(scopedDir, { recursive: true });
    await fs.writeFile(path.join(scopedDir, 'index.js'), 'export const value = 1;\n', 'utf8');
    await run('git', ['add', '--', '..pkg/index.js'], cwd);
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'add scoped package'], cwd);

    await assert.rejects(
      runCycleWorkflow({
        positionals: [],
        flags: new Map([
          ['provider', 'mock'],
          ['worktree', 'true'],
          ['max-cycles', '1'],
        ]),
      }, {
        cwd: scopedDir,
        kind: 'review',
        label: 'teardown failure',
        logger: silentLogger,
        adapter: {},
        dependencies: {
          runAssessmentCycles: async (state) => {
            workspace = state.workspace;
            assert.equal(state.workspace.cwd, path.join(state.workspace.path, '..pkg'));
            throw new Error('cycle failed after worktree setup');
          },
        },
      }),
      /cycle failed after worktree setup/,
    );

    assert.ok(workspace);
    assert.equal(workspace.mode, 'worktree');
    assert.equal(workspace.diffStatus.hasChanges, false);
    assert.equal(workspace.prune.ok, true);
    await assert.rejects(fs.stat(workspace.path), /ENOENT/);

    const listed = await run('git', ['worktree', 'list', '--porcelain'], cwd);
    assert.doesNotMatch(listed.stdout, /\.commands-com\/worktrees/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
