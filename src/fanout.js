import { formatFailureMessage } from './errors.js';

const PARALLEL_FANOUT_LIMIT = 4;

/**
 * @template TJob
 * @typedef {Object} FanoutFailure
 * @property {number} index Zero-based index of the failed job in the input list.
 * @property {TJob} job Original input job that rejected.
 * @property {*} error Original rejection value.
 */

/**
 * @template TJob, TResult
 * @typedef {Object} FanoutPartialResult
 * @property {Array<TResult>} results Successful outputs in input order, with failed slots omitted.
 * @property {Array<FanoutFailure<TJob>>} failures Failed jobs in input order.
 */

/**
 * Run a list of jobs through the fanout executor.
 *
 * Default behavior fails fast: parallel mode aggregates rejections into one
 * thrown error, serial mode lets the first rejection escape before later jobs
 * start. On success both modes return the bare results array.
 *
 * Pass `partial: true` to settle every job and always receive a uniform
 * `{ results, failures }` shape regardless of `parallel`. Rejections are
 * caught per-job and recorded as `{ index, job, error }` in `failures`;
 * successful outputs go into `results`. Serial+partial keeps running after
 * each rejection so callers see the full picture rather than only the first
 * failure.
 *
 * @template TJob, TResult
 * @overload
 * @param {Object} options
 * @param {Array<TJob>} [options.jobs]
 * @param {(job: TJob) => Promise<TResult>} options.run
 * @param {boolean} [options.parallel]
 * @param {string} [options.label]
 * @param {true} options.partial
 * @returns {Promise<FanoutPartialResult<TJob, TResult>>}
 */
/**
 * @template TJob, TResult
 * @overload
 * @param {Object} options
 * @param {Array<TJob>} [options.jobs]
 * @param {(job: TJob) => Promise<TResult>} options.run
 * @param {boolean} [options.parallel]
 * @param {string} [options.label]
 * @param {false} [options.partial]
 * @returns {Promise<Array<TResult>>}
 */
/**
 * @template TJob, TResult
 * @param {Object} options
 * @param {Array<TJob>} [options.jobs]
 * @param {(job: TJob) => Promise<TResult>} options.run
 * @param {boolean} [options.parallel]
 * @param {string} [options.label]
 * @param {boolean} [options.partial]
 * @returns {Promise<Array<TResult> | FanoutPartialResult<TJob, TResult>>}
 */
export async function runFanout({
  jobs = [],
  run,
  parallel,
  label = 'fan-out',
  partial = false,
}) {
  if (!parallel) {
    if (partial) return runSerialSettled(jobs, run);
    return runSerialFailFast(jobs, run);
  }

  const settled = await settleParallelJobs(jobs, run, PARALLEL_FANOUT_LIMIT);
  const results = [];
  const failures = [];
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') {
      results.push(item.value);
    } else {
      failures.push({ index, job: jobs[index], error: item.reason });
    }
  });
  if (partial) {
    return { results, failures };
  }
  if (failures.length) {
    throw new Error(`${label} failed: ${failures.map((failure) => formatFailureMessage(failure.error)).join('; ')}`);
  }
  return results;
}

async function runSerialFailFast(jobs, run) {
  const results = [];
  for (const job of jobs) {
    // Let the first rejection escape immediately. Later jobs are not started,
    // and this function never returns the partial successes already collected.
    results.push(await run(job));
  }
  return results;
}

async function runSerialSettled(jobs, run) {
  const results = [];
  const failures = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    try {
      results.push(await run(job));
    } catch (error) {
      failures.push({ index, job, error });
    }
  }
  return { results, failures };
}

async function settleParallelJobs(jobs, run, parallelLimit) {
  const settled = new Array(jobs.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < jobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        settled[index] = { status: 'fulfilled', value: await run(jobs[index]) };
      } catch (error) {
        settled[index] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(parallelLimit, jobs.length) },
    () => worker(),
  ));
  return settled;
}
