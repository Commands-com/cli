import test from 'node:test';
import assert from 'node:assert/strict';
import { runFanout } from '../src/fanout.js';

test('runFanout returns an empty result for empty jobs', async () => {
  const results = await runFanout({
    jobs: [],
    parallel: true,
    run: async () => {
      throw new Error('should not run');
    },
  });

  assert.deepEqual(results, []);
});

test('runFanout runs sequential jobs in order', async () => {
  const seen = [];
  const results = await runFanout({
    jobs: [1, 2, 3],
    parallel: false,
    run: async (job) => {
      seen.push(job);
      return job * 10;
    },
  });

  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(results, [10, 20, 30]);
});

test('runFanout serial mode rejects with the first failure, skips later jobs, and exposes no partial results', async () => {
  const seen = [];
  const completed = [];
  const failure = new Error('failed at two');
  const originalFailureKeys = Reflect.ownKeys(failure);
  let thrown;

  try {
    await runFanout({
      jobs: [1, 2, 3],
      parallel: false,
      run: async (job) => {
        seen.push(job);
        if (job === 2) throw failure;
        completed.push(job);
        return job;
      },
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown, failure);
  assert.equal(thrown?.message, 'failed at two');
  assert.deepEqual(Reflect.ownKeys(thrown), originalFailureKeys);
  assert.equal(Object.hasOwn(thrown, 'results'), false);
  assert.equal(Object.hasOwn(thrown, 'settled'), false);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(completed, [1]);
});

test('runFanout preserves job ordering for parallel results', async () => {
  const results = await runFanout({
    jobs: [1, 2, 3],
    parallel: true,
    run: async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 4 - job));
      return job * 10;
    },
  });

  assert.deepEqual(results, [10, 20, 30]);
});

test('runFanout uses a default parallel cap of four jobs', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await runFanout({
    jobs: [1, 2, 3, 4, 5, 6],
    parallel: true,
    run: async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return job;
    },
  });

  assert.deepEqual(results, [1, 2, 3, 4, 5, 6]);
  assert.equal(maxActive, 4);
});

test('runFanout aggregates parallel failures with the workflow label', async () => {
  await assert.rejects(
    runFanout({
      jobs: ['a', 'b', 'c'],
      parallel: true,
      label: 'quality fan-out',
      run: async (job) => {
        if (job !== 'b') return job;
        throw new Error('provider failed');
      },
    }),
    /quality fan-out failed: provider failed/,
  );
});

test('runFanout reports non-Error parallel failures', async () => {
  await assert.rejects(
    runFanout({
      jobs: ['a', 'b'],
      parallel: true,
      label: 'reviewer fan-out',
      run: async (job) => {
        if (job === 'a') throw 'provider exited';
        throw new Error('provider timed out');
      },
    }),
    /reviewer fan-out failed: provider exited; provider timed out/,
  );
});

test('runFanout partial parallel returns successful results plus an input-ordered failures array', async () => {
  const failure = new Error('provider failed');
  const result = await runFanout({
    jobs: ['a', 'b', 'c'],
    parallel: true,
    partial: true,
    label: 'quality fan-out',
    run: async (job) => {
      await new Promise((resolve) => setTimeout(resolve, job === 'a' ? 4 : 0));
      if (job === 'b') throw failure;
      return job.toUpperCase();
    },
  });

  assert.deepEqual(result.results, ['A', 'C']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 1);
  assert.equal(result.failures[0].job, 'b');
  assert.equal(result.failures[0].error, failure);
});

test('runFanout partial serial settles each job, recording failures and continuing past rejections', async () => {
  const seen = [];
  const failure = new Error('serial failure');

  const result = await runFanout({
    jobs: [1, 2, 3],
    parallel: false,
    partial: true,
    label: 'quality fan-out',
    run: async (job) => {
      seen.push(job);
      if (job === 2) throw failure;
      return job * 10;
    },
  });

  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(result.results, [10, 30]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 1);
  assert.equal(result.failures[0].job, 2);
  assert.equal(result.failures[0].error, failure);
});

test('runFanout partial serial returns the uniform shape on success', async () => {
  const seen = [];
  const result = await runFanout({
    jobs: [1, 2, 3],
    parallel: false,
    partial: true,
    run: async (job) => {
      seen.push(job);
      return job * 10;
    },
  });

  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(result.results, [10, 20, 30]);
  assert.deepEqual(result.failures, []);
});
