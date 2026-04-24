import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskArtifacts,
  taskFailureErrorArtifacts,
  taskResultPayload,
  writeTaskErrorArtifacts,
  writeTaskState,
} from '../src/implementation-task-artifacts.js';

function taskRunContext({ provider = { id: 'slice-provider' }, store, cycle = 2 } = {}) {
  return {
    execution: { provider },
    taskWorkspace: { store, cycle },
  };
}

test('writeTaskErrorArtifacts writes formatted failure messages', async () => {
  const writes = [];
  const store = {
    async write(file, text) {
      writes.push({ file, text });
      return file;
    },
  };

  assert.equal(
    await writeTaskErrorArtifacts(store, ['tasks/error.md'], new Error('provider failed')),
    'provider failed',
  );
  assert.equal(
    await writeTaskErrorArtifacts(store, ['tasks/string-error.md'], 'provider exited'),
    'provider exited',
  );
  assert.deepEqual(writes, [
    { file: 'tasks/error.md', text: 'provider failed' },
    { file: 'tasks/string-error.md', text: 'provider exited' },
  ]);
});

test('task payloads read provider from the execution slice', async () => {
  const store = {
    async writeJson(file) {
      return file;
    },
  };
  const task = {
    id: 'artifact-task',
    title: 'Artifact task',
    files: ['src/example.js'],
  };
  const context = taskRunContext({ provider: { id: 'grouped-provider' }, store });

  assert.equal((await writeTaskState(context, {
    task,
    state: 'running',
    attempt: 1,
  })).provider, 'grouped-provider');
  assert.equal(taskResultPayload({
    taskRunContext: context,
    task,
    text: 'done',
    attempt: 1,
  }).provider, 'grouped-provider');
});

test('task artifact paths stay under the task artifact root', () => {
  const task = {
    id: 'Artifact Task',
    order: 7,
  };
  const artifacts = taskArtifacts(3, task);

  assert.deepEqual({
    prompt: artifacts.prompt,
    status: artifacts.status,
    output: artifacts.output,
    worktree: artifacts.worktree,
    diff: artifacts.diff,
    diffStat: artifacts.diffStat,
    changedFiles: artifacts.changedFiles,
    mergeLog: artifacts.mergeLog,
    error: artifacts.error,
    attemptStatus: artifacts.attemptStatus(2),
    attemptNotes: artifacts.attempts(2, 'attempt-notes'),
  }, {
    prompt: 'prompts/cycle-3-task-artifact-task.md',
    status: 'cycle-3/tasks/artifact-task/status.json',
    output: 'cycle-3/tasks/artifact-task/output.md',
    worktree: 'cycle-3/tasks/artifact-task/worktree-path.txt',
    diff: 'cycle-3/tasks/artifact-task/diff.patch',
    diffStat: 'cycle-3/tasks/artifact-task/diff-stat.txt',
    changedFiles: 'cycle-3/tasks/artifact-task/changed-files.json',
    mergeLog: 'cycle-3/tasks/artifact-task/merge.log',
    error: 'cycle-3/tasks/artifact-task/error.md',
    attemptStatus: 'cycle-3/tasks/artifact-task/attempts/2/status.json',
    attemptNotes: 'cycle-3/tasks/artifact-task/attempts/2/attempt-notes.md',
  });

  assert.deepEqual(taskFailureErrorArtifacts(3, task), [
    'cycle-3/tasks/artifact-task/error.md',
  ]);
});

test('writeTaskState writes the current task status schema', async () => {
  const store = {
    async writeJson(file) {
      return file;
    },
  };
  const task = {
    id: 'schema-task',
    title: 'Schema task',
    files: ['src/schema.js'],
  };
  const worktree = {
    cwd: '/tmp/tasks/schema/repo',
    path: '/tmp/tasks/schema',
    baseSha: 'base-sha',
  };
  const baseline = {
    baselineRef: 'baseline-ref',
    baselineSha: 'baseline-sha',
  };
  const patchInfo = {
    patch: 'diff --git a/src/schema.js b/src/schema.js',
    diffStat: 'src/schema.js | 1 +',
    files: ['src/schema.js'],
  };

  const status = await writeTaskState(taskRunContext({
    provider: { id: 'schema-provider' },
    store,
  }), {
    task,
    state: 'failed',
    attempt: 2,
    worktree,
    baseline,
    patchInfo,
    error: new Error('status failed'),
    cleanup: { removed: false },
  });
  const { updatedAt, ...stableStatus } = status;

  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(stableStatus, {
    id: 'schema-task',
    title: 'Schema task',
    state: 'failed',
    attempt: 2,
    provider: 'schema-provider',
    files: ['src/schema.js'],
    worktree,
    worktreePath: '/tmp/tasks/schema/repo',
    worktreeRoot: '/tmp/tasks/schema',
    baseSha: 'base-sha',
    baseline,
    baselineRef: 'baseline-ref',
    baselineSha: 'baseline-sha',
    changedFiles: ['src/schema.js'],
    diffStat: 'src/schema.js | 1 +',
    cleanup: { removed: false },
    error: 'status failed',
  });
  assert.equal(status.task, undefined);
  assert.equal(status.patch, undefined);
});

test('writeTaskState writes current status fields to task status artifacts', async () => {
  const writes = [];
  const store = {
    async writeJson(file, value) {
      writes.push({ file, value });
      return file;
    },
  };
  const task = {
    id: 'Current Task',
    title: 'Current task',
    files: ['src/current.js'],
  };
  const workspace = {
    worktree: {
      cwd: '/tmp/current/repo',
      path: '/tmp/current',
      baseSha: 'base-current',
    },
    baseline: {
      baselineRef: 'refs/commands/current',
      baselineSha: 'baseline-current',
    },
  };
  const patchInfo = {
    patch: 'diff --git a/src/current.js b/src/current.js',
    diffStat: 'src/current.js | 2 ++',
    files: ['src/current.js'],
  };

  const status = await writeTaskState(taskRunContext({
    provider: { id: 'current-provider' },
    store,
    cycle: 4,
  }), {
    task,
    attempt: 1,
    state: 'succeeded',
    workspace,
    patchInfo,
    writeAttemptStatus: true,
  });
  const { updatedAt, ...stableStatus } = status;

  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(writes.map(({ file }) => file), [
    'cycle-4/tasks/current-task/status.json',
    'cycle-4/tasks/current-task/attempts/1/status.json',
  ]);
  assert.deepEqual(writes.map(({ value }) => {
    const { updatedAt: writeUpdatedAt, ...stableWrite } = value;
    assert.match(writeUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
    return stableWrite;
  }), [stableStatus, stableStatus]);
  assert.deepEqual(stableStatus, {
    id: 'Current Task',
    title: 'Current task',
    state: 'succeeded',
    attempt: 1,
    provider: 'current-provider',
    files: ['src/current.js'],
    worktree: workspace.worktree,
    worktreePath: '/tmp/current/repo',
    worktreeRoot: '/tmp/current',
    baseSha: 'base-current',
    baseline: workspace.baseline,
    baselineRef: 'refs/commands/current',
    baselineSha: 'baseline-current',
    changedFiles: ['src/current.js'],
    diffStat: 'src/current.js | 2 ++',
    cleanup: null,
    error: '',
  });
  assert.equal(stableStatus.patch, undefined);
});

test('taskResultPayload returns the structured result schema for merge consumers', () => {
  const task = {
    id: 'schema-task',
    title: 'Schema task',
    files: ['src/schema.js'],
  };
  const worktree = {
    cwd: '/tmp/tasks/schema/repo',
    path: '/tmp/tasks/schema',
    baseSha: 'base-sha',
  };
  const baseline = {
    baselineRef: 'baseline-ref',
    baselineSha: 'baseline-sha',
  };
  const patchInfo = {
    patch: 'diff --git a/src/schema.js b/src/schema.js',
    diffStat: 'src/schema.js | 1 +',
    files: ['src/schema.js'],
  };

  const result = taskResultPayload({
    taskRunContext: taskRunContext({ provider: { id: 'schema-provider' } }),
    task,
    text: 'done',
    attempt: 2,
    worktree,
    baseline,
    patchInfo,
  });

  assert.deepEqual(result, {
    task,
    provider: 'schema-provider',
    text: 'done',
    attempt: 2,
    state: 'succeeded',
    worktree,
    worktreePath: '/tmp/tasks/schema/repo',
    worktreeRoot: '/tmp/tasks/schema',
    baseSha: 'base-sha',
    baseline,
    baselineRef: 'baseline-ref',
    baselineSha: 'baseline-sha',
    patch: 'diff --git a/src/schema.js b/src/schema.js',
    diffStat: 'src/schema.js | 1 +',
    changedFiles: ['src/schema.js'],
  });
  assert.equal(result.id, undefined);
  assert.equal(result.files, undefined);
  assert.equal(result.cleanup, undefined);
  assert.equal(result.error, undefined);
});

test('writeTaskState reads store and cycle from the taskWorkspace slice', async () => {
  const writes = [];
  const store = {
    async writeJson(file, value) {
      writes.push({ file, value });
      return file;
    },
  };
  const task = {
    id: 'Artifact Task',
    title: 'Artifact task',
  };

  const result = await writeTaskState(taskRunContext({ store, cycle: 8 }), {
    task,
    state: 'retrying',
    attempt: 2,
    writeAttemptStatus: true,
  });
  const { updatedAt, ...stableResult } = result;

  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(stableResult, {
    id: 'Artifact Task',
    title: 'Artifact task',
    state: 'retrying',
    attempt: 2,
    provider: 'slice-provider',
    files: [],
    worktree: null,
    worktreePath: '',
    worktreeRoot: '',
    baseSha: '',
    baseline: null,
    baselineRef: '',
    baselineSha: '',
    changedFiles: [],
    diffStat: '',
    cleanup: null,
    error: '',
  });
  assert.deepEqual(writes.map(({ file, value }) => {
    const { updatedAt: writeUpdatedAt, ...stableWrite } = value;
    assert.match(writeUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
    return { file, value: stableWrite };
  }), [
    {
      file: 'cycle-8/tasks/artifact-task/status.json',
      value: stableResult,
    },
    {
      file: 'cycle-8/tasks/artifact-task/attempts/2/status.json',
      value: stableResult,
    },
  ]);
});
