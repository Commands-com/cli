import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runOrchestratedImplementationPhase,
} from '../src/implementation.js';
import { createImplementationTaskRunContext } from '../src/implementation-task-context.js';
import { applyImplementationPartialMergePolicy } from '../src/implementation-task-merge.js';
import { collectRepoContext, runGit } from '../src/git.js';
import {
  fileStore,
  initGitRepo,
  readTaskStatus,
  writeExecutable,
} from './support/implementation-fixtures.js';

test('runOrchestratedImplementationPhase applies successful task worktree patches', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-worktree-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const planText = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'Write task file',
          files: ['src/task-output.txt'],
          instructions: 'Write the assigned task output file.',
        },
      ],
    }),
    '```',
  ].join('\n');

  await initGitRepo(tmp);
  await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src', 'base.txt'), 'base integration\n', 'utf8');
  await runGit(['add', 'src/base.txt'], tmp);
  await runGit([
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test User',
    'commit',
    '-m',
    'add base file',
  ], tmp);
  await fs.writeFile(path.join(tmp, 'src', 'base.txt'), 'dirty integration\n', 'utf8');
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      'prompt=$(cat)',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: planText } })}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-task"\'; then',
      '  mkdir -p src',
      '  printf \'saw %s\\n\' "$(cat src/base.txt)" > src/task-output.txt',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'implemented in task worktree' } })}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  const store = {
    runId: 'unit-worktree-run',
    async write(file, text) {
      const target = path.join(storeRoot, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(text), 'utf8');
      return target;
    },
    async writeJson(file, value) {
      return this.write(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };

  try {
    const context = await collectRepoContext(tmp);
    const phase = await runOrchestratedImplementationPhase({
      provider: { id: 'codex', command: bin },
      store,
      cycle: 1,
      objective: 'apply worktree task patch',
      findings: 'create the task output file',
      context,
      workspace: { mode: 'current', cwd: tmp },
      timeoutMs: 5_000,
      maxImplementers: 1,
      retries: 0,
      retryDelayMs: 0,
      json: true,
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const result = phase.result;
    assert.equal(await fs.readFile(path.join(tmp, 'src', 'task-output.txt'), 'utf8'), 'saw dirty integration\n');
    assert.equal(result.implementations[0].state, 'merged');
    assert.deepEqual(result.implementations[0].changedFiles, ['src/task-output.txt']);
    const status = JSON.parse(await fs.readFile(
      path.join(storeRoot, 'cycle-1', 'tasks', 'task-1', 'status.json'),
      'utf8',
    ));
    assert.equal(status.state, 'merged');
    assert.deepEqual(status.changedFiles, ['src/task-output.txt']);
    assert.match(
      await fs.readFile(path.join(storeRoot, 'cycle-1', 'tasks', 'task-1', 'diff.patch'), 'utf8'),
      /task-output\.txt/,
    );
    const listed = await runGit(['worktree', 'list', '--porcelain'], tmp);
    assert.doesNotMatch(listed.stdout, /\.commands-com\/worktrees/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase returns batch-one success before batch-two failure', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-partial-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const planText = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-success',
          title: 'Successful task',
          files: ['src/shared.txt'],
          instructions: 'Create the successful output.',
        },
        {
          id: 'task-failure',
          title: 'Failing task',
          files: ['src/shared.txt'],
          instructions: 'Fail this task intentionally.',
        },
      ],
    }),
    '```',
  ].join('\n');

  await initGitRepo(tmp);
  await writeExecutable(bin, [
    '#!/bin/sh',
    'prompt=$(cat)',
    'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
    `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: planText } })}'`,
    '  exit 0',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'task-success\'; then',
    '  mkdir -p src',
    '  printf \'partial success\\n\' > src/shared.txt',
    `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'implemented success' } })}'`,
    '  exit 0',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'task-failure\'; then',
    `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: 'intentional task failure' })}'`,
    '  exit 1',
    'fi',
    'exit 1',
  ]);

  try {
    const context = await collectRepoContext(tmp);
    const phase = await runOrchestratedImplementationPhase({
      provider: { id: 'codex', command: bin },
      store: fileStore(storeRoot, 'unit-partial-run'),
      cycle: 1,
      objective: 'partial merge behavior',
      findings: 'one task should fail after another succeeds',
      context,
      workspace: { mode: 'current', cwd: tmp },
      timeoutMs: 5_000,
      maxImplementers: 2,
      parallel: true,
      retries: 0,
      retryDelayMs: 0,
      logger: { info() {} },
      logPrefix: 'partial',
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error?.message, /partial implementation batch 2 failed:.*intentional task failure/);
    assert.equal(await fs.readFile(path.join(tmp, 'src', 'shared.txt'), 'utf8'), 'partial success\n');
    const implementation = phase.result;
    assert.deepEqual(implementation.batches, [['task-success'], ['task-failure']]);
    assert.deepEqual(implementation.implementations.map((item) => item.task.id), ['task-success']);
    assert.match(implementation.text, /## task-success: Successful task/);
    assert.match(implementation.text, /implemented success/);
    assert.doesNotMatch(implementation.text, /Failing task/);
    const artifact = await fs.readFile(path.join(storeRoot, 'cycle-1', 'implementation.md'), 'utf8');
    assert.equal(artifact, implementation.text);
    assert.match(artifact, /## task-success: Successful task/);
    assert.doesNotMatch(artifact, /Failing task/);
    const successStatus = await readTaskStatus(storeRoot, 'task-success');
    assert.equal(successStatus.state, 'merged');
    assert.deepEqual(successStatus.changedFiles, ['src/shared.txt']);
    const failureStatus = await readTaskStatus(storeRoot, 'task-failure');
    assert.equal(failureStatus.state, 'failed');
    assert.match(failureStatus.error, /intentional task failure/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyImplementationPartialMergePolicy records merge conflict status and log', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-conflict-'));
  const storeRoot = path.join(tmp, 'store');
  const successTask = {
    id: 'task-a',
    title: 'Conflict A',
    files: ['README.md'],
  };
  const conflictTask = {
    id: 'task-b',
    title: 'Conflict B',
    files: ['README.md'],
  };

  await initGitRepo(tmp);

  try {
    const context = await collectRepoContext(tmp);
    const taskRunContext = createImplementationTaskRunContext({
      execution: {
        provider: { id: 'codex' },
        model: '',
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'conflict',
      },
      taskWorkspace: {
        store: fileStore(storeRoot, 'unit-conflict-run'),
        cycle: 1,
        context,
        workspace: { mode: 'current', cwd: tmp },
      },
      assignment: {
        objective: 'merge conflict behavior',
        findings: 'two successful patches should conflict during merge',
        testCommand: '',
      },
    });
    const result = await applyImplementationPartialMergePolicy({
      taskRunContext,
      useTaskWorktrees: true,
      successes: [
        {
          task: successTask,
          provider: 'codex',
          text: 'implemented a',
          attempt: 1,
          worktree: { cwd: path.join(tmp, 'task-a') },
          baseline: { baselineRef: 'HEAD', baselineSha: 'base-a' },
          patch: '',
          diffStat: '',
          changedFiles: [],
        },
        {
          task: conflictTask,
          provider: 'codex',
          text: 'implemented b',
          attempt: 1,
          worktree: { cwd: path.join(tmp, 'task-b') },
          baseline: { baselineRef: 'HEAD', baselineSha: 'base-b' },
          patch: 'this is not a git patch\n',
          diffStat: 'README.md | 1 +',
          changedFiles: ['README.md'],
        },
      ],
    });

    assert.equal(result.merged.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /merge-conflict/);
    const mergedStatus = await readTaskStatus(storeRoot, 'task-a');
    assert.equal(mergedStatus.state, 'merged');
    const conflictStatus = await readTaskStatus(storeRoot, 'task-b');
    assert.equal(conflictStatus.state, 'merge-conflict');
    assert.match(conflictStatus.error, /merge-conflict/);
    assert.match(
      await fs.readFile(path.join(storeRoot, 'cycle-1', 'tasks', 'task-b', 'merge.log'), 'utf8'),
      /ok: false/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
