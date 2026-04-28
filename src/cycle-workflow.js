import {
  filterKnownStoredCycleOptions,
  hasAnyFlag,
  projectCycleCommandOptions,
  resolveCycleCommandOptions,
} from './command-options.js';
import { COMMAND_OPTIONS } from './command-option-schema.js';
import { resolveRuntimeOptions } from './config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  collectRepoContext,
  createIsolatedWorktree,
} from './git.js';
import { resolveProviders } from './providers.js';
import { resolveProviderRequest } from './provider-selection.js';
import {
  prepareRun,
  writeRunSetupArtifacts,
} from './run-store.js';
import {
  loadRunState,
  openResumeStore,
  writeRunState,
} from './run-state.js';
import {
  createCycleState,
} from './cycle-state.js';
import { runAssessmentCycles } from './assessment-cycle.js';
import { runCyclePreflight } from './cycle-preflight.js';
import {
  finalizeWorktree,
  scopedWorktreeCwd,
} from './workflow.js';
import {
  WORKSPACE_MODES,
} from './workflow-constants.js';

const RESUME_ALWAYS_NEXT_FIELDS = new Set(['json', 'resume']);
const RESUME_PROVIDER_FIELDS = Object.freeze(['providers', 'providerIds', 'primaryProvider']);

export const CYCLE_RESUME_OPTION_OVERRIDES = Object.freeze(
  COMMAND_OPTIONS.flatMap((option) => {
    const fields = Object.freeze(
      (option.resumeOverrideFields ?? []).filter((field) => !RESUME_ALWAYS_NEXT_FIELDS.has(field)),
    );
    if (!fields.length) return [];
    return [Object.freeze({
      option: option.name,
      flags: Object.freeze([option.name, ...option.aliases]),
      fields,
    })];
  }),
);

/**
 * @typedef {import('./cycle-state.js').CycleRuntimeOptions} CycleRuntimeOptions
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 * @typedef {import('./cycle-state.js').CycleLogger} CycleLogger
 * @typedef {import('./assessment-cycle.js').AssessmentCycleAdapter} AssessmentCycleAdapter
 */

/**
 * Parsed command shape consumed by cycle workflows.
 *
 * @typedef {Object} ParsedCycleCommand
 * @property {Map<string, string|boolean>|Object<string, string|boolean|Array<string>>} flags Parsed CLI flags.
 * @property {Array<string>} [positionals] Parsed positional args.
 */

/**
 * Inputs used when resolving cycle runtime options.
 *
 * @typedef {Object} ResolveCycleOptionsArgs
 * @property {string} cwd Command working directory.
 * @property {Object} [commandOptions] Pre-resolved cycle command options.
 * @property {Object} [resumeOptions] Stored resume options used to short-circuit provider discovery.
 */

/**
 * Test seam for the assessment cycles loop.
 *
 * This is the cycle-workflow seam only: it lists exactly the keys
 * `runCycleWorkflow` reads. Command-level adapters (review/quality) must NOT
 * spread arbitrary keys through this bag — pass only the documented seams.
 *
 * @typedef {{
 *   runAssessmentCycles?: (state: CycleState, adapter: AssessmentCycleAdapter) => (void|Promise<void>),
 * }} RunCycleWorkflowDependencies
 */

/**
 * Runtime workflow options supplied by review/quality command adapters.
 *
 * @typedef {Object} RunCycleWorkflowOptions
 * @property {string} cwd Command working directory.
 * @property {string} kind Workflow kind, such as `review` or `quality`.
 * @property {string} label Human-readable run label.
 * @property {Object} [metadata] Extra metadata persisted with the run.
 * @property {CycleLogger} logger Command logger.
 * @property {AssessmentCycleAdapter|Object} adapter Assessment adapter executed by each cycle.
 * @property {RunCycleWorkflowDependencies} [dependencies] Optional test seams.
 */

/**
 * Resolve and own all runtime options needed by cycle modules.
 *
 * @param {ParsedCycleCommand} parsed Parsed command args.
 * @param {ResolveCycleOptionsArgs} args Resolution args.
 * @returns {Promise<CycleRuntimeOptions>}
 */
async function resolveCycleOptions(parsed, { cwd, commandOptions = resolveCycleCommandOptions(parsed.flags), resumeOptions }) {
  const runtimeOptions = await resolveRuntimeOptions(cwd, parsed.flags);
  const storedProviderOptions = resumeProviderOptions(resumeOptions);
  const providerOptions = shouldUseResumeProviders(parsed.flags, commandOptions, storedProviderOptions)
    ? storedProviderOptions
    : await resolveProviderOptions(parsed.flags, runtimeOptions);

  return {
    ...providerOptions,
    model: runtimeOptions.model,
    ...commandOptions,
  };
}

function shouldUseResumeProviders(flags, commandOptions, providerOptions) {
  return Boolean(commandOptions?.resume)
    && !hasAnyFlag(flags, ['provider', 'providers'])
    && Boolean(providerOptions);
}

function resumeProviderOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const providers = Array.isArray(source.providers)
    ? source.providers.filter(isProviderRecord)
    : [];
  if (!providers.length) return null;
  const primaryProvider = isProviderRecord(source.primaryProvider)
    ? source.primaryProvider
    : providers[0];
  const providerIds = Array.isArray(source.providerIds)
    ? source.providerIds.map((providerId) => String(providerId || '').trim()).filter(Boolean)
    : providers.map((provider) => provider.id);
  return {
    providers,
    primaryProvider,
    providerIds: providerIds.length ? providerIds : providers.map((provider) => provider.id),
  };
}

function isProviderRecord(provider) {
  return Boolean(provider && typeof provider === 'object' && typeof provider.id === 'string' && provider.id.trim());
}

async function resolveProviderOptions(flags, runtimeOptions) {
  const providers = await resolveProviders(resolveProviderRequest(flags, runtimeOptions));
  return {
    providers,
    primaryProvider: providers[0],
    providerIds: providers.map((provider) => provider.id),
  };
}

/**
 * Run the shared review/quality cycle workflow around an assessment adapter.
 *
 * @param {ParsedCycleCommand} parsed Parsed command args.
 * @param {RunCycleWorkflowOptions} options Workflow options.
 * @returns {Promise<CycleState>}
 */
export async function runCycleWorkflow(parsed, {
  cwd,
  kind,
  label,
  metadata = {},
  logger,
  adapter,
  dependencies = {},
}) {
  if (!logger) {
    throw new Error('runCycleWorkflow requires logger');
  }
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('runCycleWorkflow requires adapter');
  }
  const runCycles = dependencies.runAssessmentCycles ?? runAssessmentCycles;
  const commandOptions = resolveCycleCommandOptions(parsed.flags);
  const resume = commandOptions.resume ? await loadResume(cwd, commandOptions.resume, kind) : null;
  let options = await resolveCycleOptions(parsed, {
    cwd,
    commandOptions,
    resumeOptions: resume?.state.options,
  });
  if (resume) {
    const knownStored = filterKnownStoredCycleOptions(resume.state.options, { logger });
    options = mergeResumeOptions(knownStored, options, parsed.flags);
  }

  const skipPrepareContext = !resume && Boolean(options.worktree);
  const { store, context: originalContext } = resume
    ? await prepareResumeRun(cwd, resume, options)
    : await prepareRun(cwd, {
      kind,
      label,
      changed: options.changed,
      writeSetupArtifacts: false,
      collectContext: !skipPrepareContext,
    });

  /** @type {import('./cycle-state.js').CycleWorkspace} */
  let workspace;
  if (resume) {
    workspace = resumeWorkspace(resume.state.workspace, originalContext);
  } else if (options.worktree) {
    const isolated = await createIsolatedWorktree(cwd, {
      kind,
      label,
      baseRef: options.baseRef || 'HEAD',
    });
    workspace = {
      mode: WORKSPACE_MODES.WORKTREE,
      cwd: await resolveWorktreeWorkspaceCwd(cwd, isolated),
      ...isolated,
    };
  } else {
    workspace = {
      mode: WORKSPACE_MODES.CURRENT,
      cwd: /** @type {import('./git.js').RepoContext} */ (originalContext).repoRoot,
    };
  }

  const state = createCycleState({
    kind,
    store,
    workspace,
    context: originalContext,
    options,
    logger,
    cycles: resume?.state.cycles,
    providerSessions: resume?.state.providerSessions,
    priorFindings: resume?.state.priorFindings,
    hasUnresolvedTestFailure: resume?.state.hasUnresolvedTestFailure,
    stalledCycles: resume?.state.stalledCycles,
    stopReason: '',
  });
  let finalStatus = 'running';
  let failure;

  try {
    if (workspace.mode === WORKSPACE_MODES.WORKTREE && !resume) {
      state.context = await collectRepoContext(workspace.cwd, { changed: options.changed });
    }

    if (!resume) {
      await writeRunSetupArtifacts(store, /** @type {import('./git.js').RepoContext} */ (state.context), {
        kind,
        provider: options.primaryProvider.id,
        providers: options.providerIds,
        synthesizerProvider: options.primaryProvider.id,
        implementerProvider: options.primaryProvider.id,
        model: options.model,
        ...projectCycleCommandOptions(options),
        workspace,
        ...metadata,
      });
    }

    logCycleWorkflowStart(state);
    if (resume) state.logger.info(`resume: ${state.store.runId} (${state.cycles.length} completed cycle(s))`);
    await runCyclePreflight(state);
    await writeRunState(state, { status: 'running' });
    await runCycles(state, adapter);
    finalStatus = state.stopReason || 'completed';
  } catch (error) {
    failure = error;
    finalStatus = 'failed';
    throw error;
  } finally {
    await finalizeWorktree(workspace, { keepWorktree: options.keepWorktree });
    await writeRunState(state, { status: finalStatus, error: failure });
  }

  return state;
}

async function loadResume(cwd, runRef, kind) {
  const loaded = await loadRunState(cwd, runRef);
  if (loaded.state.kind && loaded.state.kind !== kind) {
    throw new Error(`cannot resume ${loaded.state.kind} run with ${kind} command`);
  }
  return loaded;
}

async function prepareResumeRun(cwd, resume, options) {
  const store = await openResumeStore(cwd, resume.dir);
  const contextCwd = resume.state.workspace?.cwd || resume.state.context?.repoRoot || cwd;
  return {
    store,
    context: await collectRepoContext(contextCwd, { changed: options.changed }),
  };
}

function resumeWorkspace(workspace, context) {
  if (workspace?.mode && workspace?.cwd) return { ...workspace };
  return {
    mode: WORKSPACE_MODES.CURRENT,
    cwd: context.repoRoot,
  };
}

// Mirrors the realpath-resolved gitRoot/repoRoot pair `collectRepoContext` would
// have produced for the original cwd, so `scopedWorktreeCwd` can preserve any
// subdirectory scope without re-collecting the (otherwise unused) full context.
async function resolveWorktreeWorkspaceCwd(cwd, isolated) {
  const gitRoot = isolated.originalRepoRoot
    ? await fs.realpath(isolated.originalRepoRoot).catch(() => isolated.originalRepoRoot)
    : '';
  const repoRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  return scopedWorktreeCwd(
    /** @type {import('./git.js').RepoContext} */ ({ gitRoot, repoRoot }),
    isolated,
  );
}

export function mergeResumeOptions(storedOptions, nextOptions, flags) {
  const stored = storedOptions && typeof storedOptions === 'object' ? storedOptions : {};
  const decisions = new Map();
  for (const field of new Set([...Object.keys(stored), ...Object.keys(nextOptions)])) {
    decisions.set(field, Object.hasOwn(stored, field) ? 'stored' : 'next');
  }
  for (const override of CYCLE_RESUME_OPTION_OVERRIDES) {
    if (!hasAnyFlag(flags, override.flags)) continue;
    for (const field of override.fields) decisions.set(field, 'next');
  }
  for (const field of RESUME_ALWAYS_NEXT_FIELDS) decisions.set(field, 'next');
  if (!Array.isArray(stored.providers) || stored.providers.length === 0) {
    for (const field of RESUME_PROVIDER_FIELDS) decisions.set(field, 'next');
  }
  const merged = {};
  for (const [field, source] of decisions) {
    merged[field] = source === 'next' ? nextOptions[field] : stored[field];
  }
  return merged;
}

function logCycleWorkflowStart(state) {
  const {
    providerIds,
    providers,
    primaryProvider,
  } = state.options;

  state.logger.info(`run: ${state.store.runId}`);
  state.logger.info(`providers: ${providerIds.join(', ')}`);
  if (providers.length > 1) {
    state.logger.info(`synthesizer/implementer: ${primaryProvider.id}`);
  }
  if (state.workspace.mode === WORKSPACE_MODES.WORKTREE) {
    state.logger.info(`worktree: ${state.workspace.cwd}`);
    if (state.workspace.originalStatus) {
      state.logger.info('note: uncommitted changes in the original repo were not copied into the worktree');
    }
  }
  state.logger.info(`output: ${state.store.dir}`);
}
