import { createCycleState } from '../../src/cycle-state.js';
import { memoryStore } from './memory-store.js';

/** @param {any} args @returns {any} */
export function testState({
  providers = [{ id: 'mock' }],
  parallel = false,
  logger,
} = {}) {
  const provider = providers[0];
  return /** @type {any} */ (createCycleState({
    kind: 'quality',
    store: memoryStore(),
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      providers,
      primaryProvider: provider,
      providerIds: providers.map((item) => item.id),
      model: '',
      parallel,
      timeoutMs: 30_000,
      providerRetries: 0,
      json: false,
    },
    logger: logger || {
      jsonMode: false,
      info() {},
    },
  }));
}

/** @param {any} args @returns {any} */
export function fanoutDependencies({
  store = memoryStore(),
  logger = {},
  providers = [{ id: 'mock' }],
  fanoutParallel,
} = {}) {
  return /** @type {any} */ ({
    context: { repoRoot: '/repo' },
    store,
    logger,
    options: {
      providers,
      model: '',
      timeoutMs: 30_000,
      providerRetries: 0,
    },
    ...(fanoutParallel === undefined ? {} : { fanoutParallel }),
  });
}
