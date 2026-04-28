import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImplementationTaskRunContext,
  implementationTaskAssignment,
  implementationTaskExecution,
  implementationTaskWorkspace,
} from '../src/implementation-task-context.js';

function sampleInputs() {
  return {
    execution: {
      provider: { id: 'slice-provider' },
      model: 'test-model',
      timeoutMs: 1_000,
      retries: 1,
      retryDelayMs: 5,
      logger: { info() {} },
      logPrefix: 'slice',
    },
    taskWorkspace: {
      store: { runId: 'slice-run', async write() { return ''; } },
      cycle: 3,
      context: { repoRoot: '/repo' },
      workspace: { mode: 'current', cwd: '/repo' },
    },
    assignment: {
      objective: 'normalize context access',
      findings: 'read through accessors',
      testCommand: 'npm test',
    },
  };
}

test('createImplementationTaskRunContext freezes a flat record of the three sub-records', () => {
  const inputs = sampleInputs();
  const taskRunContext = createImplementationTaskRunContext(inputs);

  assert.deepEqual(Object.keys(taskRunContext).sort(), ['assignment', 'execution', 'taskWorkspace']);
  assert.equal(taskRunContext.execution, inputs.execution);
  assert.equal(taskRunContext.taskWorkspace, inputs.taskWorkspace);
  assert.equal(taskRunContext.assignment, inputs.assignment);
  assert.ok(Object.isFrozen(taskRunContext));
});

test('implementation task accessors return the matching sub-record', () => {
  const inputs = sampleInputs();
  const taskRunContext = createImplementationTaskRunContext(inputs);

  assert.equal(implementationTaskExecution(taskRunContext), inputs.execution);
  assert.equal(implementationTaskWorkspace(taskRunContext), inputs.taskWorkspace);
  assert.equal(implementationTaskAssignment(taskRunContext), inputs.assignment);
});
