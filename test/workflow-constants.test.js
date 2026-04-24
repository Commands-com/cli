import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_MODES } from '../src/workflow-constants.js';

test('workflow constants expose frozen production-used workflow contracts', () => {
  assert.equal(Object.isFrozen(WORKSPACE_MODES), true);
  assert.deepEqual(WORKSPACE_MODES, {
    CURRENT: 'current',
    WORKTREE: 'worktree',
  });
});
