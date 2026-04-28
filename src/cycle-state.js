import { createLogger } from './logger.js';
import { normalizeFiniteNonNegativeNumber } from './number-utils.js';

/**
 * Provider descriptor used by cycle fan-out, synthesis, and implementation.
 *
 * @typedef {Object} CycleProvider
 * @property {string} id Stable provider id used in logs and artifacts.
 * @property {string} [command] Optional command path for external providers.
 */

/**
 * @typedef {Object} CycleRepoContext
 * @property {string} repoRoot Repository root for command execution.
 * @property {string} [gitRoot] Git worktree root when available.
 * @property {boolean} [isGit] Whether the context came from a Git repository.
 * @property {string} [branch] Current branch name.
 * @property {string} [head] Current short commit sha.
 * @property {string} [status] Porcelain status text.
 * @property {string} [diffStat] Diff stat text.
 * @property {string} [diff] Diff text for changed-only follow-up cycles.
 * @property {string} [diffError] Diff collection diagnostic, when available.
 */

/**
 * @typedef {Object} CycleWorkspace
 * @property {'current'|'worktree'|string} mode Workspace mode.
 * @property {string} cwd Working directory used by providers and validation.
 * @property {string} [path] Isolated worktree path.
 * @property {string} [branch] Isolated worktree branch.
 * @property {string} [baseRef] Base ref for isolated worktrees.
 * @property {string} [baseSha] Base sha for isolated worktrees.
 * @property {string} [originalRepoRoot] Original repository root.
 * @property {string} [originalStatus] Original repository status.
 */

/**
 * @typedef {Object} CycleStore
 * @property {string} [runId] Run id for user-facing logs.
 * @property {string} [dir] Artifact root directory.
 * @property {(name: string, content: string) => Promise<string>} write
 * @property {(name: string, value: *) => Promise<string>} [writeJson]
 * @property {*} [writes] Test/support stores may expose captured writes.
 */

/**
 * @typedef {Object} CycleLogger
 * @property {string} [kind] Logger scope.
 * @property {boolean} [jsonMode] Whether human-readable output is suppressed.
 * @property {(kind: string) => CycleLogger} [child]
 * @property {(message: string) => void} [line]
 * @property {(message: string) => void} [info]
 * @property {(message: string) => void} [warn]
 * @property {(payload: *) => void} [json]
 * @property {(message: string) => void} [error]
 */

/**
 * Runtime options owned by a cycle state. Resolved once by `runCycleWorkflow`
 * and read through `state.options` by phase modules; tests may construct
 * subsets, so all fields are typed as optional.
 *
 * @typedef {Object} CycleRuntimeOptions
 * @property {Array<CycleProvider>} [providers] Providers used for fan-out.
 * @property {CycleProvider} [primaryProvider] Provider used for synthesis and implementation.
 * @property {Array<string>} [providerIds] Provider ids in execution order.
 * @property {string} [model] Provider model override.
 * @property {boolean} [changed] Whether the first cycle is changed-files scoped.
 * @property {boolean} [fix] Whether implementation cycles are enabled.
 * @property {boolean} [worktree] Whether fixes run in an isolated worktree.
 * @property {string} [baseRef] Base ref used when creating isolated worktrees.
 * @property {boolean} [keepWorktree] Whether to keep isolated worktrees.
 * @property {boolean} [allowDirty] Whether fixing a dirty tree is allowed.
 * @property {boolean} [serial] Whether provider/implementer fan-out is serialized.
 * @property {boolean} [parallel] Whether provider fan-out may run in parallel.
 * @property {boolean} [failOnIssues] Whether final issues should fail the command.
 * @property {boolean} [json] Whether command output is JSON.
 * @property {number} [timeoutMs] Provider and validation timeout.
 * @property {number} [maxCycles] Maximum assessment cycles.
 * @property {number} [maxImplementers] Maximum implementation tasks.
 * @property {number} [stallCycles] Stop after this many repeated no-progress cycles; 0 disables.
 * @property {number} [providerRetries] Transient provider retry count.
 * @property {string} [resume] Run id or path resumed by this invocation.
 * @property {string} [untilScore] Optional target review/quality score for stop handling.
 * @property {string} [testCommand] Optional validation command.
 * @property {*} [customOption] Test/adapters may carry extra option fields.
 * @property {*} [customAdapterOption] Test/adapters may carry extra option fields.
 * @property {*} [runtimeOptions] Extra nested option data is preserved as ordinary owned options.
 */

/**
 * @typedef {Object} CycleProgress
 * @property {boolean} improved Whether the current score/issue count beats the previous cycle.
 * @property {boolean} changed Whether the cycle changed score/issue count/synopsis.
 * @property {number} stalledCycles Consecutive repeated no-progress cycles.
 */

/**
 * Fields populated on every assessment cycle record. Adapter-specific fields
 * are extended at the adapter boundary (see `ReviewCycleRecord` in
 * `review.js`, `QualityCycleRecord` in `quality.js`).
 *
 * @typedef {Object} CycleRecordBase
 * @property {number} cycle One-based cycle number.
 * @property {string} [score] Latest cycle score from the synthesis or output summary.
 * @property {number} [issueCount] Aggregate major issue count for the cycle.
 * @property {number} [minorIssueCount] Aggregate minor issue count for the cycle.
 * @property {number} [reviewerIssueCount] Review adapter pre-synthesis major issue count.
 * @property {number} [reviewerMinorIssueCount] Review adapter pre-synthesis minor issue count.
 * @property {number} [providerIssueCount] Quality adapter pre-synthesis major issue count.
 * @property {number} [providerMinorIssueCount] Quality adapter pre-synthesis minor issue count.
 * @property {string} [synopsis] Cycle synopsis line.
 * @property {Array<Object>} [outputs] Quality adapter outputs.
 * @property {Array<Object>} [reviewers] Review adapter outputs.
 * @property {string} [synthesisProvider] Provider id used for synthesis.
 * @property {string} [synthesis] Synthesis text (empty when synthesis fails).
 * @property {string} [synthesisError] Synthesis failure message.
 * @property {Array<{ provider: string, item: string, error: string }>} [fanoutFailures] Per-job partial-mode failures from `runAssessmentProviderFanout`.
 * @property {CycleProgress} [progress] Stall/progress diagnostics.
 * @property {string} [implementationPlan] Raw implementation plan text.
 * @property {Array<Object>} [implementationTasks] Parsed implementation tasks.
 * @property {Array<Array<string>>} [implementationBatches] Implementation batches by task id.
 * @property {Array<Object>} [implementations] Per-task implementation outputs.
 * @property {string} [implementation] Rendered implementation summary.
 * @property {{ ok: boolean, exitCode: number }} [test] Validation command result.
 * @property {number} [testIssueCount] Issue count contributed by a failing validation run.
 * @property {number} [outputIssueCount] Adapter-specific pre-synthesis issue count.
 * @property {string} [source] Adapter-specific summary source marker.
 * @property {boolean} [usedOutputSummary] Adapter-specific fallback marker.
 */

/** @typedef {CycleRecordBase} CycleRecord */

/**
 * Implementation result returned by `runOrchestratedImplementationPhase`.
 *
 * @typedef {Object} CycleImplementationResult
 * @property {string} [plan] Raw implementation plan text.
 * @property {Array<Object>} [tasks] Parsed implementation tasks.
 * @property {Array<Array<string>>} [batches] Implementation batches by task id.
 * @property {Array<Object>} [implementations] Per-task implementation outputs.
 * @property {string} [text] Rendered implementation summary.
 */

/**
 * @typedef {Object} CycleTestResult
 * @property {boolean} ok Whether validation passed.
 * @property {number} exitCode Validation command exit code.
 */

/**
 * Implementation phase result applied to cycle state after implementers run.
 *
 * @typedef {Object} CycleImplementationApplicationResult
 * @property {CycleImplementationResult} [implementation] Implementation output to record.
 * @property {CycleTestResult|null} [testResult] Optional validation result.
 * @property {CycleRepoContext} [nextContext] Repository context after implementation.
 * @property {string} [nextFindings] Findings to carry into the next cycle.
 */

/**
 * Read-only run context handed to assessment adapters. This is intentionally
 * smaller than `CycleState`: adapters can read run inputs and write artifacts,
 * while mutation stays with the workflow runner.
 *
 * @typedef {Object} CycleRunContext
 * @property {string} [kind] Workflow kind such as `review` or `quality`.
 * @property {CycleStore} [store] Artifact store.
 * @property {CycleRepoContext} [context] Current repository context.
 * @property {CycleRuntimeOptions} options Runtime options owned by this state.
 * @property {CycleLogger} [logger] Command logger.
 * @property {string} [priorFindings] Findings carried into the current cycle.
 * @property {boolean} hasUnresolvedTestFailure Whether validation failed after implementation.
 */

/**
 * Explicit mutation surface used by workflow runners.
 *
 * @typedef {Object} CycleRecorder
 * @property {string} priorFindings Current findings carried into the next cycle.
 * @property {(cycle: number, details?: Object, options?: { priorFindings?: string }) => CycleRecord} beginCycle
 * @property {(cycleRecord: CycleRecord, implementationResult: CycleImplementationApplicationResult, options?: { testFailureUpdates?: Object }) => CycleRecord} applyImplementationResult
 */

/**
 * Broad mutable state owned by the cycle workflow. Phase modules and adapters
 * should depend on `CycleRunContext`, `CycleRecorder`, or explicit phase
 * dependencies instead of accepting this whole object.
 *
 * @typedef {Object} CycleState
 * @property {string} [kind] Workflow kind such as `review` or `quality`.
 * @property {CycleStore} store Artifact store.
 * @property {CycleWorkspace} workspace Active workspace.
 * @property {CycleRepoContext} [context] Current repository context.
 * @property {CycleRuntimeOptions} options Runtime options owned by this state.
 * @property {CycleLogger} [logger] Command logger.
 * @property {Array<CycleRecord>} cycles Stored cycle records.
 * @property {Record<string, string>} [providerSessions] Provider session ids carried across cycles.
 * @property {string} [priorFindings] Findings carried into the next cycle.
 * @property {boolean} hasUnresolvedTestFailure Whether validation failed after implementation.
 * @property {number} [stalledCycles] Consecutive repeated no-progress cycles.
 * @property {string} [stopReason] Why the loop stopped when it did not naturally converge.
 */

/**
 * Inputs used to create a cycle state.
 *
 * @typedef {Object} CreateCycleStateArgs
 * @property {string} kind Workflow kind.
 * @property {CycleStore} store Artifact store.
 * @property {CycleWorkspace} workspace Active workspace.
 * @property {CycleRepoContext} context Initial repository context.
 * @property {CycleRuntimeOptions} [options] Runtime options to own.
 * @property {CycleLogger} [logger] Optional logger override.
 * @property {Array<CycleRecord>} [cycles] Cycle records carried in from a resume.
 * @property {Record<string, string>} [providerSessions] Provider sessions carried across cycles.
 * @property {string} [priorFindings] Findings carried into the next cycle.
 * @property {boolean} [hasUnresolvedTestFailure] Whether validation failed after implementation.
 * @property {number} [stalledCycles] Consecutive repeated no-progress cycles.
 * @property {string} [stopReason] Why the loop stopped when it did not naturally converge.
 *
 * @param {CreateCycleStateArgs} args
 * @returns {CycleState}
 */
export function createCycleState({
  kind,
  store,
  workspace,
  context,
  options = {},
  logger,
  cycles = [],
  providerSessions = {},
  priorFindings = '',
  hasUnresolvedTestFailure = false,
  stalledCycles = 0,
  stopReason = '',
}) {
  const ownedOptions = /** @type {CycleRuntimeOptions} */ ({ ...options });
  return {
    kind,
    store,
    workspace,
    context,
    options: ownedOptions,
    logger: logger || createLogger({ json: ownedOptions.json, kind }),
    cycles,
    providerSessions,
    priorFindings,
    hasUnresolvedTestFailure,
    stalledCycles,
    stopReason,
  };
}

export function createCycleRunContext(state) {
  return Object.freeze({
    kind: state?.kind,
    store: state?.store,
    context: state?.context,
    options: state?.options || {},
    logger: state?.logger,
    priorFindings: state?.priorFindings || '',
    hasUnresolvedTestFailure: Boolean(state?.hasUnresolvedTestFailure),
  });
}

export function createCycleRecorder(state) {
  return Object.freeze({
    get priorFindings() {
      return state.priorFindings;
    },
    beginCycle(cycle, details = {}, options = {}) {
      return beginCycle(state, cycle, details, options);
    },
    applyImplementationResult(cycleRecord, implementationResult = {}, options = {}) {
      return applyImplementationResult(state, cycleRecord, implementationResult, options);
    },
  });
}

function createCycleRecord(cycle, details) {
  return applyCycleRecordUpdates({ cycle }, details);
}

function beginCycle(state, cycle, details, { priorFindings } = /** @type {{ priorFindings?: string }} */ ({})) {
  const cycleRecord = createCycleRecord(cycle, details);
  state.cycles.push(cycleRecord);
  if (priorFindings !== undefined) {
    setPriorFindings(state, priorFindings);
  }
  return cycleRecord;
}

function setPriorFindings(state, findings) {
  state.priorFindings = findings || '';
  return state.priorFindings;
}

function setContext(state, nextContext) {
  state.context = nextContext;
  return state.context;
}

function setUnresolvedTestFailure(state, value) {
  state.hasUnresolvedTestFailure = Boolean(value);
  return state.hasUnresolvedTestFailure;
}

function recordImplementation(cycleRecord, implementation = {}) {
  const updates = {
    implementationPlan: implementation.plan,
    implementationTasks: implementation.tasks,
    implementationBatches: implementation.batches,
    implementations: implementation.implementations,
    implementation: implementation.text,
  };
  // Why: a successfully parsed plan with no tasks means the implementer judged the cycle done;
  // only then do we override the synthesizer's score so a malformed plan parse cannot masquerade
  // as zero work.
  if (
    Array.isArray(implementation.tasks)
    && implementation.tasks.length === 0
    && implementation.plan != null
  ) {
    Object.assign(updates, {
      score: 'A',
      issueCount: 0,
      synopsis: 'No actionable implementation tasks were returned.',
    });
  }
  return applyCycleRecordUpdates(cycleRecord, updates);
}

function recordTestResult(state, cycleRecord, testResult, { testFailureUpdates } = /** @type {{ testFailureUpdates?: Object }} */ ({})) {
  const test = { ok: testResult.ok, exitCode: testResult.exitCode };
  if (testResult.ok) {
    setUnresolvedTestFailure(state, false);
    applyCycleRecordUpdates(cycleRecord, { test });
    return test;
  }

  setUnresolvedTestFailure(state, true);
  applyCycleRecordUpdates(cycleRecord, {
    test,
    testIssueCount: 1,
    issueCount: Math.max(normalizeFiniteNonNegativeNumber(cycleRecord.issueCount), 1),
    ...testFailureUpdates,
  });
  return test;
}

function applyImplementationResult(state, cycleRecord, implementationResult = {}, { testFailureUpdates } = /** @type {{ testFailureUpdates?: Object }} */ ({})) {
  recordImplementation(cycleRecord, implementationResult.implementation);
  if (implementationResult.testResult) {
    recordTestResult(state, cycleRecord, implementationResult.testResult, { testFailureUpdates });
  }
  if (implementationResult.nextContext) {
    setContext(state, implementationResult.nextContext);
  }
  if (Object.hasOwn(implementationResult, 'nextFindings')) {
    setPriorFindings(state, implementationResult.nextFindings);
  }
  return cycleRecord;
}

function applyCycleRecordUpdates(cycleRecord, updates) {
  Object.assign(cycleRecord, updates);
  return cycleRecord;
}
