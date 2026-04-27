import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyImplementationPartialMergePolicy,
  integrationPatchForBatch,
} from '../src/implementation-task-merge.js';
import { runImplementationTask } from '../src/implementation-task-attempt.js';
import { writeTaskState } from '../src/implementation-task-artifacts.js';
import { createImplementationTaskRunContext } from '../src/implementation-task-context.js';
import { runGit } from '../src/git.js';
import {
  applyGitPatch,
  captureGitPatch,
  createTaskWorktree,
  prepareTaskWorktreeBaseline,
  removeTaskWorktree,
} from '../src/task-worktrees.js';
import { writeFakeProvider } from './support/fake-provider.js';
import {
  fileStore,
  gitStateSnapshot,
  initGitRepo,
  readTaskStatus,
} from './support/git.js';

const noopLogger = { info() {} };
const skipOnWin32 = { skip: process.platform === 'win32' };

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function withTempDir(prefix, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `commands-com-${prefix}-`));
  const cleanups = [];
  try {
    return await fn({ tmp, defer: (task) => cleanups.unshift(task) });
  } finally {
    for (const task of cleanups) {
      try { await task(); } catch { /* best-effort cleanup */ }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function createTaskMergeRunContext({
  store, cycle = 1, context, workspace,
  provider = { id: 'mock-provider' }, assignment = {},
}) {
  return createImplementationTaskRunContext({
    execution: { provider, timeoutMs: 5_000, logger: noopLogger },
    taskWorkspace: { store, cycle, context, workspace },
    assignment,
  });
}

async function commitFiles(repo, message, files) {
  await runGit(['add', ...files], repo);
  await runGit([
    '-c', 'user.email=test@example.com', '-c', 'user.name=Test User',
    'commit', '-m', message,
  ], repo);
}

function makeSuccess(task, worktree, overrides = {}) {
  return {
    task,
    worktree,
    provider: 'mock-provider',
    text: `implemented ${task.id}`,
    attempt: 1,
    baseline: { baselineRef: `baseline-${task.id}`, baselineSha: `baseline-sha-${task.id}` },
    patch: '',
    diffStat: '',
    changedFiles: [],
    ...overrides,
  };
}

function mergedRecord(success) {
  return {
    task: success.task,
    provider: success.provider,
    text: success.text,
    attempt: success.attempt,
    worktree: success.worktree.cwd,
    diffStat: success.diffStat,
    changedFiles: success.changedFiles,
    state: 'merged',
  };
}

test('integration patches carry untracked files from earlier batches into later task worktrees', skipOnWin32, async () => {
  await withTempDir('implementation-multi-batch', async ({ tmp, defer }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);

    const context = { isGit: true, gitRoot: repoRoot, repoRoot };
    const taskRunContext = createTaskMergeRunContext({
      store: fileStore(storeRoot, 'unit-multi-batch-run'),
      context,
      workspace: { mode: 'current', cwd: repoRoot },
    });

    const firstWorktree = await createTaskWorktree({
      integrationCwd: repoRoot, context, taskRoot: tmp,
      runId: 'unit-multi-batch-run', cycle: 1, taskId: 'task-creates-file',
    });
    defer(() => removeTaskWorktree(firstWorktree));
    await fs.mkdir(path.join(firstWorktree.cwd, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(firstWorktree.cwd, 'src', 'generated.js'),
      'export const generated = 1;\n',
      'utf8',
    );

    const firstPatch = await captureGitPatch(firstWorktree.cwd, {
      baseRef: 'HEAD', includeUntracked: true,
    });
    assert.equal(firstPatch.ok, true);
    assert.deepEqual(firstPatch.files, ['src/generated.js']);

    const applied = await applyGitPatch(repoRoot, firstPatch.patch, { threeWay: true });
    assert.equal(applied.ok, true);

    const integrationPatch = await integrationPatchForBatch(taskRunContext, { useTaskWorktrees: true });
    assert.equal(integrationPatch.ok, true);
    assert.deepEqual(integrationPatch.files, ['src/generated.js']);
    assert.match(integrationPatch.patch, /diff --git a\/src\/generated\.js b\/src\/generated\.js/);

    const secondWorktree = await createTaskWorktree({
      integrationCwd: repoRoot, context, taskRoot: tmp,
      runId: 'unit-multi-batch-run', cycle: 1, taskId: 'task-uses-file',
    });
    defer(() => removeTaskWorktree(secondWorktree));
    const baseline = await prepareTaskWorktreeBaseline(secondWorktree, integrationPatch.patch);

    assert.equal(baseline.committed, true);
    assert.equal(
      await fs.readFile(path.join(secondWorktree.cwd, 'src', 'generated.js'), 'utf8'),
      'export const generated = 1;\n',
    );
  });
});

test('runImplementationTask rejects edits outside a scoped task worktree root', skipOnWin32, async () => {
  await withTempDir('scoped-task-outside', async ({ tmp, defer }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    const appRoot = path.join(repoRoot, 'packages', 'app');

    await fs.mkdir(appRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await fs.writeFile(path.join(appRoot, 'README.md'), '# app\n', 'utf8');
    await commitFiles(repoRoot, 'init app', ['packages/app/README.md']);

    const provider = await writeFakeProvider(path.join(tmp, 'bin'), 'codex', [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.mkdirSync(path.join(process.cwd(), '..', 'sibling'), { recursive: true });",
      "fs.writeFileSync(path.join(process.cwd(), '..', 'sibling', 'outside-scope.js'), 'export const outside = true;\\n', 'utf8');",
      "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'wrote outside scope' } }));",
    ]);

    const taskRunContext = createTaskMergeRunContext({
      store: fileStore(storeRoot, 'unit-scoped-outside-run'),
      cycle: 2,
      context: {
        isGit: true, gitRoot: repoRoot, repoRoot: appRoot,
        branch: 'main', head: 'abc123', status: '', diffStat: '', diff: '',
      },
      workspace: { mode: 'current', cwd: appRoot, originalRepoRoot: tmp },
      provider: { id: 'codex', command: provider },
      assignment: { objective: 'detect outside edits', findings: '', testCommand: 'npm test' },
    });

    let failureWorktree;
    await assert.rejects(
      async () => {
        try {
          await runImplementationTask(taskRunContext, {
            task: { id: 'scoped-task', title: 'Scoped task', files: ['README.md'] },
            integrationPatch: '',
            useTaskWorktrees: true,
          });
        } catch (error) {
          failureWorktree = error.metadata?.workspace?.worktree;
          throw error;
        }
      },
      /patch validation failed: task scoped-task changed file outside assigned scope: \.\.\/sibling\/outside-scope\.js/,
    );
    if (failureWorktree) defer(() => removeTaskWorktree(failureWorktree));

    const failedStatus = await readTaskStatus(storeRoot, 'scoped-task', 2);
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /outside assigned scope: \.\.\/sibling\/outside-scope\.js/);
  });
});

test('captureGitPatch keeps sibling edits visible and scoped merge rejects them', async () => {
  await withTempDir('scoped-task-capture', async ({ tmp }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    const appRoot = path.join(repoRoot, 'packages', 'app');
    const siblingRoot = path.join(repoRoot, 'packages', 'sibling');

    await fs.mkdir(appRoot, { recursive: true });
    await fs.mkdir(siblingRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await fs.writeFile(path.join(appRoot, 'README.md'), '# app\n', 'utf8');
    await fs.writeFile(path.join(siblingRoot, 'README.md'), '# sibling\n', 'utf8');
    await commitFiles(repoRoot, 'init packages', [
      'packages/app/README.md', 'packages/sibling/README.md',
    ]);

    await fs.appendFile(path.join(appRoot, 'README.md'), 'in scope\n', 'utf8');
    await fs.appendFile(path.join(siblingRoot, 'README.md'), 'outside scope\n', 'utf8');

    const patchInfo = await captureGitPatch(appRoot, {
      baseRef: 'HEAD', includeUntracked: true, repoRelativePath: 'packages/app',
    });

    assert.equal(patchInfo.ok, true, patchInfo.error);
    assert.deepEqual(patchInfo.files, ['README.md', '../sibling/README.md']);
    assert.match(patchInfo.patch, /diff --git a\/packages\/app\/README\.md b\/packages\/app\/README\.md/);
    assert.match(patchInfo.patch, /diff --git a\/packages\/sibling\/README\.md b\/packages\/sibling\/README\.md/);
    assert.match(patchInfo.status, /^ ?M README\.md/m);
    assert.match(patchInfo.status, /^ ?M \.\.\/sibling\/README\.md/m);
    await fs.writeFile(path.join(appRoot, 'README.md'), '# app\n', 'utf8');
    await fs.writeFile(path.join(siblingRoot, 'README.md'), '# sibling\n', 'utf8');

    const taskRunContext = createTaskMergeRunContext({
      store: fileStore(storeRoot, 'unit-scoped-merge-run'),
      cycle: 5,
      context: { isGit: true, gitRoot: repoRoot, repoRoot: appRoot },
      workspace: { mode: 'current', cwd: appRoot },
    });
    const mergeResult = await applyImplementationPartialMergePolicy({
      taskRunContext,
      useTaskWorktrees: true,
      successes: [makeSuccess(
        { id: 'scoped-merge', title: 'Scoped merge', files: ['README.md'] },
        { cwd: path.join(tmp, 'missing-worktree') },
        {
          text: 'patched scoped repo',
          baseline: { baselineRef: 'HEAD', baselineSha: '' },
          patch: patchInfo.patch,
          diffStat: patchInfo.diffStat,
          changedFiles: patchInfo.files,
        },
      )],
    });

    assert.deepEqual(mergeResult.merged, []);
    assert.equal(mergeResult.failures.length, 1);
    assert.match(mergeResult.failures[0].message, /merge validation failed: task scoped-merge changed file outside assigned scope: \.\.\/sibling\/README\.md/);
    assert.equal(await fs.readFile(path.join(appRoot, 'README.md'), 'utf8'), '# app\n');
    assert.equal(await fs.readFile(path.join(siblingRoot, 'README.md'), 'utf8'), '# sibling\n');
  });
});

test('captureGitPatch includes untracked files without changing git status', async () => {
  await withTempDir('patch-status', async ({ tmp }) => {
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.appendFile(path.join(repoRoot, 'README.md'), 'dirty\n', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'src', 'new-file.js'), 'export const value = 1;\n', 'utf8');

    const before = await gitStateSnapshot(repoRoot);
    assert.match(before.status, / M README\.md/);
    assert.match(before.status, /\?\? src\//);

    const patchInfo = await captureGitPatch(repoRoot, {
      baseRef: 'HEAD', includeUntracked: true,
    });

    const after = await gitStateSnapshot(repoRoot);
    assert.deepEqual(after, before);
    assert.equal(patchInfo.ok, true, patchInfo.error);
    assert.deepEqual(patchInfo.files, ['README.md', 'src/new-file.js']);
    assert.match(patchInfo.patch, /diff --git a\/src\/new-file\.js b\/src\/new-file\.js/);
    assert.doesNotMatch(after.status, / A src\/new-file\.js/);
  });
});

test('applyImplementationPartialMergePolicy stops after first merge failure and writes conflict payload', async () => {
  await withTempDir('implementation-merge', async ({ tmp }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);

    const store = fileStore(storeRoot);
    const taskRunContext = createTaskMergeRunContext({
      store, cycle: 3,
      context: { repoRoot },
      workspace: { mode: 'current', cwd: repoRoot },
    });

    const successTask = { id: 'task-a', title: 'Successful task', files: ['README.md'] };
    const secondSuccessTask = { id: 'task-a2', title: 'Second successful task', files: ['README.md'] };
    const conflictTask = { id: 'task-b', title: 'Conflicting task', files: ['README.md', 'src/conflict.js'] };
    const skippedTask = { id: 'task-c', title: 'Skipped after conflict', files: ['README.md'] };

    const successWorktree = { cwd: path.join(tmp, 'task-a') };
    const secondSuccessWorktree = { cwd: path.join(tmp, 'task-a2') };
    const conflictWorktree = {
      cwd: path.join(tmp, 'task-b', 'repo'),
      path: path.join(tmp, 'task-b'),
      baseSha: 'base-b',
    };
    const skippedWorktree = { cwd: path.join(tmp, 'task-c') };
    const conflictBaseline = { baselineRef: 'baseline-b', baselineSha: 'baseline-sha-b' };

    const successes = [
      makeSuccess(successTask, successWorktree),
      makeSuccess(secondSuccessTask, secondSuccessWorktree),
      makeSuccess(conflictTask, conflictWorktree, {
        attempt: 2,
        baseline: conflictBaseline,
        patch: 'this is not a git patch\n',
        diffStat: 'README.md | 1 +',
        changedFiles: ['README.md'],
      }),
      makeSuccess(skippedTask, skippedWorktree),
    ];

    const result = await applyImplementationPartialMergePolicy({
      taskRunContext, useTaskWorktrees: true, successes,
    });

    assert.deepEqual(result.merged, [
      mergedRecord(successes[0]),
      mergedRecord(successes[1]),
    ]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /^implementer task-b merge-conflict: /);

    const successStatus = await readTaskStatus(storeRoot, 'task-a', 3);
    assert.equal(successStatus.state, 'merged');
    assert.deepEqual(successStatus.worktree, successWorktree);
    assert.equal(successStatus.worktreePath, successWorktree.cwd);
    assert.equal(successStatus.baselineSha, 'baseline-sha-task-a');
    assert.deepEqual(successStatus.cleanup, {
      ok: false, error: 'missing_task_worktree_metadata',
    });

    const secondSuccessStatus = await readTaskStatus(storeRoot, 'task-a2', 3);
    assert.equal(secondSuccessStatus.state, 'merged');
    assert.deepEqual(secondSuccessStatus.worktree, secondSuccessWorktree);
    assert.equal(secondSuccessStatus.worktreePath, secondSuccessWorktree.cwd);
    assert.equal(secondSuccessStatus.baselineSha, 'baseline-sha-task-a2');

    const conflictStatus = await readTaskStatus(storeRoot, 'task-b', 3);
    assert.match(conflictStatus.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(conflictStatus, {
      id: 'task-b',
      title: 'Conflicting task',
      state: 'merge-conflict',
      attempt: 2,
      provider: 'mock-provider',
      files: ['README.md', 'src/conflict.js'],
      worktree: conflictWorktree,
      worktreePath: conflictWorktree.cwd,
      worktreeRoot: conflictWorktree.path,
      baseSha: conflictWorktree.baseSha,
      baseline: conflictBaseline,
      baselineRef: conflictBaseline.baselineRef,
      baselineSha: conflictBaseline.baselineSha,
      changedFiles: ['README.md'],
      diffStat: 'README.md | 1 +',
      cleanup: null,
      error: result.failures[0].message,
      updatedAt: conflictStatus.updatedAt,
    });

    assert.deepEqual(
      store.writes.filter((file) => file.includes('/task-c/')),
      [],
      'policy should not write artifacts for results after the first merge failure',
    );
    assert.equal(
      await pathExists(path.join(storeRoot, 'cycle-3', 'tasks', 'task-c', 'status.json')),
      false,
    );
  });
});

test('applyImplementationPartialMergePolicy removes worktrees of unmerged successes after a merge failure', skipOnWin32, async () => {
  await withTempDir('merge-cleanup', async ({ tmp }) => {
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);

    const context = { isGit: true, gitRoot: repoRoot, repoRoot };
    const worktrees = [];
    for (let i = 1; i <= 4; i += 1) {
      worktrees.push(await createTaskWorktree({
        integrationCwd: repoRoot, context, taskRoot: tmp,
        runId: 'merge-cleanup-run', cycle: 1, taskId: `task-${i}`,
      }));
    }
    const taskRunContext = createTaskMergeRunContext({
      store: fileStore(path.join(tmp, 'store'), 'merge-cleanup-run'),
      context, workspace: { mode: 'current', cwd: repoRoot },
    });
    const successes = worktrees.map((worktree, i) => makeSuccess(
      { id: `task-${i + 1}`, title: `Task ${i + 1}`, files: ['README.md'] },
      worktree,
      {
        provider: 'mock', text: '',
        baseline: { baselineRef: 'HEAD', baselineSha: worktree.baseSha },
        patch: i === 1 ? 'this is not a git patch\n' : '',
      },
    ));
    const result = await applyImplementationPartialMergePolicy({
      taskRunContext, useTaskWorktrees: true, successes,
    });
    assert.equal(result.merged.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /^implementer task-2 merge-conflict: /);
    assert.equal(await pathExists(worktrees[0].path), false);
    assert.equal(await pathExists(worktrees[1].path), true);
    assert.equal(await pathExists(worktrees[2].path), false);
    assert.equal(await pathExists(worktrees[3].path), false);
  });
});

test('writeTaskState writes task and attempt status artifacts', async () => {
  await withTempDir('attempt-state', async ({ tmp }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });

    const store = fileStore(storeRoot);
    const taskRunContext = createTaskMergeRunContext({
      store, cycle: 2,
      context: { repoRoot },
      workspace: { mode: 'current', cwd: repoRoot },
    });
    const task = { id: 'status-task', title: 'Status task', files: ['src/status.js'] };
    const worktree = {
      cwd: path.join(tmp, 'task-worktree', 'repo'),
      path: path.join(tmp, 'task-worktree'),
      baseSha: 'base-sha',
    };
    const baseline = { baselineRef: 'baseline-ref', baselineSha: 'baseline-sha' };

    await writeTaskState(taskRunContext, {
      task, attempt: 2, state: 'succeeded',
      workspace: { cwd: path.join(tmp, 'task-worktree'), worktree, baseline },
      patchInfo: { files: ['src/status.js'], diffStat: 'src/status.js | 1 +' },
      writeAttemptStatus: true,
    });

    const status = await readTaskStatus(storeRoot, task.id, 2);
    const attemptStatus = JSON.parse(await fs.readFile(
      path.join(storeRoot, 'cycle-2', 'tasks', task.id, 'attempts', '2', 'status.json'),
      'utf8',
    ));
    assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(attemptStatus, status);
    assert.deepEqual(status, {
      id: 'status-task',
      title: 'Status task',
      state: 'succeeded',
      attempt: 2,
      provider: 'mock-provider',
      files: ['src/status.js'],
      worktree,
      worktreePath: worktree.cwd,
      worktreeRoot: worktree.path,
      baseSha: 'base-sha',
      baseline,
      baselineRef: 'baseline-ref',
      baselineSha: 'baseline-sha',
      changedFiles: ['src/status.js'],
      diffStat: 'src/status.js | 1 +',
      cleanup: null,
      error: '',
      updatedAt: status.updatedAt,
    });
  });
});

test('runImplementationTask creates worktree and records status through the public task runner', async () => {
  await withTempDir('attempt-workspace', async ({ tmp }) => {
    const storeRoot = path.join(tmp, 'store');
    const repoRoot = path.join(tmp, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);

    const store = fileStore(storeRoot, 'unit-workspace-run');
    const taskRunContext = createTaskMergeRunContext({
      store, cycle: 4,
      provider: { id: 'mock' },
      context: { isGit: true, gitRoot: repoRoot, repoRoot },
      workspace: { mode: 'current', cwd: repoRoot, originalRepoRoot: tmp },
    });
    const task = { id: 'setup-task', title: 'Setup task', files: ['README.md'] };

    const result = await runImplementationTask(taskRunContext, {
      task, integrationPatch: '', useTaskWorktrees: true,
    });

    const workspace = {
      cwd: result.worktree?.cwd,
      worktree: result.worktree,
      baseline: result.baseline,
    };
    assert.equal(workspace.cwd, workspace.worktree.cwd);
    assert.equal(workspace.worktree.attempt, 1);
    assert.equal(workspace.worktree.baseRef, 'HEAD');
    assert.match(workspace.worktree.baseSha, /^[a-f0-9]{40}$/);
    assert.equal(workspace.baseline.baselineRef, 'HEAD');
    assert.equal(workspace.baseline.baselineSha, workspace.worktree.baseSha);
    assert.equal(workspace.baseline.committed, false);
    assert.equal(
      await fs.readFile(path.join(storeRoot, 'cycle-4', 'tasks', task.id, 'worktree-path.txt'), 'utf8'),
      `${workspace.cwd}\n`,
    );

    const status = await readTaskStatus(storeRoot, task.id, 4);
    assert.deepEqual(status, {
      id: 'setup-task',
      title: 'Setup task',
      state: 'succeeded',
      attempt: 1,
      provider: 'mock',
      files: ['README.md'],
      worktree: workspace.worktree,
      worktreePath: workspace.worktree.cwd,
      worktreeRoot: workspace.worktree.path,
      baseSha: workspace.worktree.baseSha,
      baseline: workspace.baseline,
      baselineRef: 'HEAD',
      baselineSha: workspace.worktree.baseSha,
      changedFiles: [],
      diffStat: '',
      cleanup: null,
      error: '',
      updatedAt: status.updatedAt,
    });
  });
});
