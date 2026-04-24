import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImplementationTaskRunContext } from '../src/implementation-task-context.js';
import {
  applyImplementationPartialMergePolicy,
  integrationPatchForBatch,
} from '../src/implementation-task-merge.js';
import { fileStore, readTaskStatus } from './support/git.js';

test('integrationPatchForBatch reports git diff capture failures', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-integration-patch-'));
  const storeRoot = path.join(tmp, 'store');
  const taskRunContext = createImplementationTaskRunContext({
    execution: {
      provider: { id: 'codex' },
      model: '',
      timeoutMs: 5_000,
      retries: 0,
      retryDelayMs: 0,
      logger: { info() {} },
      logPrefix: 'integration',
    },
    taskWorkspace: {
      store: fileStore(storeRoot, 'unit-integration-patch-run'),
      cycle: 1,
      context: { repoRoot: tmp },
      workspace: { mode: 'current', cwd: tmp },
    },
    assignment: {
      objective: 'integration patch failure',
      findings: '',
      testCommand: '',
    },
  });

  try {
    await assert.rejects(
      () => integrationPatchForBatch(taskRunContext, { useTaskWorktrees: true }),
      /could not capture integration patch:/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyImplementationPartialMergePolicy records cleanup failures in merged status', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-cleanup-'));
  const storeRoot = path.join(tmp, 'store');
  const taskRunContext = createImplementationTaskRunContext({
    execution: {
      provider: { id: 'codex' },
      model: '',
      timeoutMs: 5_000,
      retries: 0,
      retryDelayMs: 0,
      logger: { info() {} },
      logPrefix: 'cleanup',
    },
    taskWorkspace: {
      store: fileStore(storeRoot, 'unit-cleanup-run'),
      cycle: 1,
      context: { repoRoot: tmp },
      workspace: { mode: 'current', cwd: tmp },
    },
    assignment: {
      objective: 'cleanup status',
      findings: '',
      testCommand: '',
    },
  });

  try {
    const result = await applyImplementationPartialMergePolicy({
      taskRunContext,
      useTaskWorktrees: true,
      successes: [{
        task: {
          id: 'task-cleanup',
          title: 'Cleanup task',
          files: [],
        },
        provider: 'codex',
        text: 'done',
        attempt: 1,
        worktree: { cwd: path.join(tmp, 'missing-worktree') },
        baseline: { baselineRef: 'HEAD', baselineSha: 'base' },
        patch: '',
        diffStat: '',
        changedFiles: [],
      }],
    });

    assert.equal(result.failures.length, 0);
    assert.equal(result.merged[0].state, 'merged');
    const status = await readTaskStatus(storeRoot, 'task-cleanup');
    assert.equal(status.state, 'merged');
    assert.deepEqual(status.cleanup, {
      ok: false,
      error: 'missing_task_worktree_metadata',
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
