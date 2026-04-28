import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runImplementationTask,
} from '../src/implementation-task-attempt.js';
import { createImplementationTaskRunContext } from '../src/implementation-task-context.js';
import { collectRepoContext } from '../src/git.js';
import { fileStore, initGitRepo } from './support/git.js';

/** @param {any} args @returns {any} */
function taskRunContext({
  provider = { id: 'mock' },
  store,
  repoRoot,
  context,
  workspace,
  cycle = 1,
  retries = 0,
  retryDelayMs = 0,
} = {}) {
  const repoContext = context || {
    repoRoot,
    branch: 'main',
    head: 'abc123',
    status: '(clean)',
    diffStat: '(none)',
    diff: '',
  };
  return createImplementationTaskRunContext({
    execution: {
      provider,
      model: '',
      timeoutMs: 5_000,
      retries,
      retryDelayMs,
      logger: { info() {} },
      logPrefix: 'test',
    },
    taskWorkspace: {
      store,
      cycle,
      context: repoContext,
      workspace: workspace || { mode: 'current', cwd: repoContext.repoRoot },
    },
    assignment: {
      objective: 'test implementation task attempts',
      findings: 'focused test findings',
      testCommand: 'npm test',
    },
  });
}

function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function writeExecutable(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('runImplementationTask records failure status with default workspace metadata', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-attempt-public-failure-'));
  const storeRoot = path.join(tmp, 'store');
  const task = {
    id: 'public-failure-task',
    title: 'Public failure task',
    files: ['src/public-failure.js'],
    instructions: 'Fail through the public implementation task runner.',
    order: 1,
  };

  try {
    await assert.rejects(
      () => runImplementationTask(taskRunContext({
        provider: { id: 'unsupported-test-provider' },
        store: fileStore(storeRoot, 'unit-public-failure-run'),
        repoRoot: tmp,
        cycle: 6,
      }), {
        task,
        integrationPatch: '',
        useTaskWorktrees: false,
      }),
      /unsupported provider: unsupported-test-provider/,
    );

    const failedStatus = await readJson(path.join(
      storeRoot,
      'cycle-6',
      'tasks',
      'public-failure-task',
      'status.json',
    ));
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /unsupported provider: unsupported-test-provider/);
    assert.equal(failedStatus.worktree, null);
    assert.equal(failedStatus.worktreePath, '');
    assert.equal(failedStatus.worktreeRoot, '');
    assert.deepEqual(failedStatus.baseline, { baselineRef: 'HEAD', baselineSha: '' });
    assert.equal(failedStatus.baselineRef, 'HEAD');
    assert.equal(failedStatus.baselineSha, '');

    const errorArtifact = await fs.readFile(path.join(
      storeRoot,
      'cycle-6',
      'tasks',
      'public-failure-task',
      'error.md',
    ), 'utf8');
    assert.match(errorArtifact, /unsupported provider: unsupported-test-provider/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask normalizes direct-workspace result and status shape', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-attempt-direct-'));
  const storeRoot = path.join(tmp, 'store');
  const task = {
    id: 'direct-task',
    title: 'Direct task',
    files: ['src/direct.js'],
    instructions: 'Return direct task output.',
    order: 1,
  };

  try {
    const store = fileStore(storeRoot, 'unit-direct-run');
    const result = await runImplementationTask(taskRunContext({
      store,
      repoRoot: tmp,
      cycle: 2,
    }), {
      task,
      integrationPatch: '',
      useTaskWorktrees: false,
    });

    assert.equal(result.state, 'succeeded');
    assert.equal(result.provider, 'mock');
    assert.equal(result.attempt, 1);
    assert.match(result.text, /Mock implementer/);
    assert.equal(result.worktree, null);
    assert.equal(result.worktreePath, '');
    assert.equal(result.worktreeRoot, '');
    assert.equal(result.baseSha, '');
    assert.deepEqual(result.baseline, { baselineRef: 'HEAD', baselineSha: '' });
    assert.equal(result.baselineRef, 'HEAD');
    assert.equal(result.baselineSha, '');
    assert.equal(result.patch, '');
    assert.equal(result.diffStat, '');
    assert.deepEqual(result.changedFiles, []);

    const latestStatus = await readJson(path.join(
      storeRoot,
      'cycle-2',
      'tasks',
      'direct-task',
      'status.json',
    ));
    assert.equal(latestStatus.state, 'succeeded');
    assert.equal(latestStatus.provider, 'mock');
    assert.equal(latestStatus.attempt, 1);
    assert.deepEqual(latestStatus.files, ['src/direct.js']);
    assert.equal(latestStatus.worktree, null);
    assert.equal(latestStatus.worktreePath, '');
    assert.equal(latestStatus.worktreeRoot, '');
    assert.equal(latestStatus.baseSha, '');
    assert.deepEqual(latestStatus.baseline, { baselineRef: 'HEAD', baselineSha: '' });
    assert.equal(latestStatus.baselineRef, 'HEAD');
    assert.equal(latestStatus.baselineSha, '');
    assert.deepEqual(latestStatus.changedFiles, []);
    assert.equal(latestStatus.diffStat, '');
    assert.equal(latestStatus.cleanup, null);
    assert.equal(latestStatus.error, '');
    assert.match(latestStatus.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(
      store.writes.filter((file) => file.endsWith('/status.json')),
      [
        'cycle-2/tasks/direct-task/status.json',
        'cycle-2/tasks/direct-task/status.json',
      ],
    );
    assert.equal(store.writes.some((file) => file.startsWith('cycle-2/tasks/direct-task/attempts/')), false);
    assert.equal(store.writes.includes('cycle-2/tasks/direct-task/worktree-path.txt'), false);
    assert.equal(store.writes.includes('cycle-2/tasks/direct-task/diff.patch'), false);
    assert.equal(store.writes.includes('cycle-2/tasks/direct-task/diff-stat.txt'), false);
    assert.equal(store.writes.includes('cycle-2/tasks/direct-task/changed-files.json'), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask records transient retry attempt artifacts', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-attempt-retry-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const task = {
    id: 'retry-task',
    title: 'Retry task',
    files: ['src/retry.js'],
    instructions: 'Retry after a transient provider failure.',
    order: 1,
  };

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
      item: { type: 'agent_message', text: 'implemented after retry' },
    }))}`,
  ]);

  try {
    const result = await runImplementationTask(taskRunContext({
      provider: { id: 'codex', command: bin },
      store: fileStore(storeRoot, 'unit-retry-run'),
      repoRoot: tmp,
      cycle: 3,
      retries: 1,
      retryDelayMs: 0,
    }), {
      task,
      integrationPatch: '',
      useTaskWorktrees: false,
    });

    assert.equal(result.state, 'succeeded');
    assert.equal(result.attempt, 2);
    assert.equal(result.text, 'implemented after retry');

    const attemptOneError = await fs.readFile(path.join(
      storeRoot,
      'cycle-3',
      'tasks',
      'retry-task',
      'attempts',
      '1',
      'error.md',
    ), 'utf8');
    assert.match(attemptOneError, /stream disconnected/);
    const retryingStatus = await readJson(path.join(
      storeRoot,
      'cycle-3',
      'tasks',
      'retry-task',
      'attempts',
      '1',
      'status.json',
    ));
    assert.equal(retryingStatus.state, 'retrying');
    assert.equal(retryingStatus.attempt, 1);
    assert.equal(retryingStatus.provider, 'codex');
    assert.equal(retryingStatus.worktree, null);
    assert.equal(retryingStatus.worktreePath, '');
    assert.equal(retryingStatus.worktreeRoot, '');
    assert.deepEqual(retryingStatus.baseline, { baselineRef: 'HEAD', baselineSha: '' });
    assert.equal(retryingStatus.baselineRef, 'HEAD');
    assert.equal(retryingStatus.baselineSha, '');
    assert.match(retryingStatus.error, /stream disconnected/);

    const succeededStatus = await readJson(path.join(
      storeRoot,
      'cycle-3',
      'tasks',
      'retry-task',
      'attempts',
      '2',
      'status.json',
    ));
    assert.equal(succeededStatus.state, 'succeeded');
    assert.equal(succeededStatus.attempt, 2);
    assert.equal(succeededStatus.error, '');

    const latestStatus = await readJson(path.join(storeRoot, 'cycle-3', 'tasks', 'retry-task', 'status.json'));
    assert.equal(latestStatus.state, 'succeeded');
    assert.equal(latestStatus.attempt, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask accepts a captured patch after expanding ownership for unassigned files', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-attempt-ownership-repair-'));
  const repoRoot = path.join(tmp, 'repo');
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const task = {
    id: 'ownership-repair',
    title: 'Ownership repair task',
    files: ['src/owned.js'],
    instructions: 'Update the owned implementation.',
    order: 1,
  };

  await fs.mkdir(repoRoot, { recursive: true });
  await initGitRepo(repoRoot);
  await writeExecutable(bin, [
    '#!/bin/sh',
    'count_file="$0.count"',
    'if [ -f "$count_file" ]; then read n < "$count_file"; else n=0; fi',
    'n=$((n + 1))',
    'printf \'%s\\n\' "$n" > "$count_file"',
    'cat >/dev/null',
    'mkdir -p src test',
    'printf \'%s\\n\' owned > src/owned.js',
    'printf \'%s\\n\' downstream > test/downstream.test.js',
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'ownership repair ok' },
    }))}`,
  ]);

  try {
    const store = fileStore(storeRoot, 'unit-ownership-repair-run');
    const context = await collectRepoContext(repoRoot);
    const result = await runImplementationTask(taskRunContext({
      provider: { id: 'codex', command: bin },
      store,
      context,
      cycle: 7,
      retries: 0,
      retryDelayMs: 0,
    }), {
      task,
      integrationPatch: '',
      useTaskWorktrees: true,
    });

    assert.equal(result.state, 'succeeded');
    assert.equal(result.attempt, 1);
    assert.deepEqual(result.task.files, ['src/owned.js', 'test/downstream.test.js']);
    assert.deepEqual([...result.changedFiles].sort(), ['src/owned.js', 'test/downstream.test.js']);
    assert.equal(await fs.readFile(`${bin}.count`, 'utf8'), '1\n');

    const latestStatus = await readJson(path.join(
      storeRoot,
      'cycle-7',
      'tasks',
      'ownership-repair',
      'status.json',
    ));
    assert.equal(latestStatus.state, 'succeeded');
    assert.equal(latestStatus.error, '');
    assert.deepEqual(latestStatus.files, ['src/owned.js', 'test/downstream.test.js']);
    assert.deepEqual([...latestStatus.changedFiles].sort(), ['src/owned.js', 'test/downstream.test.js']);

    await assert.rejects(() => fs.access(path.join(
      storeRoot,
      'cycle-7',
      'tasks',
      'ownership-repair',
      'attempts',
      '1',
      'status.json',
    )), { code: 'ENOENT' });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask preserves worktree error metadata on terminal failure', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-attempt-error-metadata-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const task = {
    id: 'error-metadata',
    title: 'Error metadata task',
    files: ['src/error-metadata.js'],
    instructions: 'Fail after task worktree setup.',
    order: 1,
  };

  await initGitRepo(tmp);
  await writeExecutable(bin, [
    '#!/bin/sh',
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'intentional task failure',
    }))}`,
    'exit 1',
  ]);

  try {
    const store = fileStore(storeRoot, 'unit-error-metadata-run');
    const context = await collectRepoContext(tmp);
    /** @type {any} */
    let failure;
    await assert.rejects(
      async () => {
        try {
          await runImplementationTask(taskRunContext({
            provider: { id: 'codex', command: bin },
            store,
            context,
            cycle: 4,
            retries: 0,
            retryDelayMs: 0,
          }), {
            task,
            integrationPatch: '',
            useTaskWorktrees: true,
          });
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      /intentional task failure/,
    );

    assert.equal(failure.name, 'ImplementationTaskAttemptError');
    assert.match(failure.originalError.message, /intentional task failure/);
    const failureWorkspace = failure.metadata.workspace;
    assert.ok(failureWorkspace.worktree);
    assert.equal(failureWorkspace.worktree.attempt, 1);
    assert.equal(failureWorkspace.worktree.managerCwd, context.repoRoot);
    assert.equal(failureWorkspace.baseline.baselineRef, 'HEAD');
    assert.equal(failureWorkspace.baseline.baselineSha, failureWorkspace.worktree.baseSha);

    const failedStatus = await readJson(path.join(
      storeRoot,
      'cycle-4',
      'tasks',
      'error-metadata',
      'status.json',
    ));
    assert.equal(failedStatus.state, 'failed');
    assert.equal(failedStatus.attempt, 1);
    assert.deepEqual(failedStatus.worktree, failureWorkspace.worktree);
    assert.equal(failedStatus.worktreePath, failureWorkspace.worktree.cwd);
    assert.equal(failedStatus.worktreeRoot, failureWorkspace.worktree.path);
    assert.equal(failedStatus.baseSha, failureWorkspace.worktree.baseSha);
    assert.deepEqual(failedStatus.baseline, failureWorkspace.baseline);
    assert.equal(failedStatus.baselineRef, 'HEAD');
    assert.equal(failedStatus.baselineSha, failureWorkspace.baseline.baselineSha);
    assert.match(failedStatus.error, /intentional task failure/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask points implementation prompts at the task worktree', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-prompt-context-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const task = {
    id: 'prompt-context',
    title: 'Prompt context task',
    files: ['README.md'],
    instructions: 'Verify the prompt repository path.',
    order: 1,
  };

  await initGitRepo(tmp);
  await writeExecutable(bin, [
    '#!/bin/sh',
    'prompt="$(cat)"',
    'case "$prompt" in',
    '  *"Repository: $PWD"*) ;;',
    '  *) printf \'%s\\n\' \'{"type":"error","message":"prompt did not use task worktree cwd"}\'; exit 9 ;;',
    'esac',
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'prompt context ok' },
    }))}`,
  ]);

  try {
    const store = fileStore(storeRoot, 'unit-prompt-context-run');
    const context = await collectRepoContext(tmp);
    const result = await runImplementationTask(taskRunContext({
      provider: { id: 'codex', command: bin },
      store,
      context,
      cycle: 5,
      retries: 0,
      retryDelayMs: 0,
    }), {
      task,
      integrationPatch: '',
      useTaskWorktrees: true,
    });

    assert.equal(result.state, 'succeeded');
    assert.deepEqual(result.changedFiles, []);
    const worktreePath = (await fs.readFile(path.join(
      storeRoot,
      'cycle-5',
      'tasks',
      'prompt-context',
      'worktree-path.txt',
    ), 'utf8')).trim();
    const prompt = await fs.readFile(path.join(
      storeRoot,
      'prompts',
      'cycle-5-task-prompt-context.md',
    ), 'utf8');
    assert.match(prompt, new RegExp(`^Repository: ${escapeRegExp(worktreePath)}$`, 'm'));
    assert.doesNotMatch(prompt, new RegExp(`^Repository: ${escapeRegExp(tmp)}$`, 'm'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationTask fails when a worktree implementer edits the integration workspace', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-leak-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const task = {
    id: 'workspace-leak',
    title: 'Workspace leak task',
    files: ['README.md'],
    instructions: 'Do not edit outside the task worktree.',
    order: 1,
  };

  await initGitRepo(tmp);
  await writeExecutable(bin, [
    '#!/bin/sh',
    `printf '%s\\n' leak > ${shSingleQuote(path.join(tmp, 'leaked.js'))}`,
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'leaked outside task worktree' },
    }))}`,
  ]);

  try {
    const store = fileStore(storeRoot, 'unit-workspace-leak-run');
    const context = await collectRepoContext(tmp);
    await assert.rejects(
      () => runImplementationTask(taskRunContext({
        provider: { id: 'codex', command: bin },
        store,
        context,
        cycle: 6,
        retries: 0,
        retryDelayMs: 0,
      }), {
        task,
        integrationPatch: '',
        useTaskWorktrees: true,
      }),
      /changed the integration workspace outside its task worktree/,
    );

    const failedStatus = await readJson(path.join(
      storeRoot,
      'cycle-6',
      'tasks',
      'workspace-leak',
      'status.json',
    ));
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /changed the integration workspace outside its task worktree/);
    assert.match(failedStatus.error, /leaked\.js/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
