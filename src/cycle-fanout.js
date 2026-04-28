import {
  providerItemArtifactDescriptor,
} from './artifact-paths.js';
import { isObjectRecord } from './objects.js';
import {
  createProviderItemRunArtifacts,
  runProviderItem,
} from './provider-item-workflow.js';
import { formatFailureMessage } from './errors.js';
import { runFanout } from './fanout.js';
import { safePathSegment } from './safe-path.js';

const DEFAULT_ASSESSMENT_FANOUT_ARTIFACT_PATHS = providerItemArtifactDescriptor;

/**
 * @typedef {{value: *, label?: string, pathSegment?: string}} AssessmentFanoutItemDescriptor
 * @typedef {{provider: string, item: string, error: string}} AssessmentFanoutFailure
 * @typedef {{outputs: Array<Object>, failures: Array<AssessmentFanoutFailure>, partial?: true}} AssessmentFanoutResult
 */

function normalizeAssessmentFanoutItem({ item, itemIndex }) {
  const isDescriptor = isAssessmentFanoutItemDescriptor(item);
  const hasValue = isDescriptor && Object.prototype.hasOwnProperty.call(item, 'value');
  const value = hasValue ? item.value : item;
  const label = isDescriptor && item.label !== undefined ? String(item.label) : String(value);
  const pathSegment = isDescriptor && item.pathSegment
    ? String(item.pathSegment)
    : safePathSegment(label, 'item');
  return {
    value,
    label,
    pathSegment,
    itemIndex,
  };
}

/**
 * Build stable fan-out item descriptors from command-specific values.
 *
 * @param {Array<*>} items Command-specific item values.
 * @param {Object} [options] Descriptor options.
 * @param {(args: Object) => *} [options.getValue] Value handed to prompt/output hooks.
 * @param {(args: Object) => string} [options.getLabel] Human-readable label.
 * @param {(args: Object) => string} [options.getPathSegment] Artifact path segment.
 * @param {string} [options.pathFallback] Fallback segment for empty labels.
 * @returns {Array<AssessmentFanoutItemDescriptor>}
 */
export function createAssessmentFanoutItems(items, {
  getValue = ({ item }) => item,
  getLabel = ({ value }) => String(value),
  getPathSegment,
  pathFallback = 'item',
} = {}) {
  if (!Array.isArray(items)) {
    throw new Error('createAssessmentFanoutItems requires items');
  }

  return items.map((item, itemIndex) => {
    const value = getValue({ item, itemIndex });
    const label = String(getLabel({ item, value, itemIndex }));
    const pathSegment = typeof getPathSegment === 'function'
      ? String(getPathSegment({ item, value, label, itemIndex }))
      : safePathSegment(label, pathFallback);
    return { value, label, pathSegment };
  });
}

function buildAssessmentFanoutJobs({ providers, items }) {
  return providers.flatMap((provider) => items.map((item, itemIndex) => ({
    provider,
    item: normalizeAssessmentFanoutItem({ item, itemIndex }),
  })));
}

function normalizeAssessmentFanoutOptions(options = {}) {
  const adapter = isObjectRecord(options.adapter) ? options.adapter : {};
  const internal = isObjectRecord(options.internal) ? options.internal : {};
  const {
    artifactRoot,
    buildPrompt,
    buildOutput,
    logOutput,
    writeAdditionalArtifacts,
  } = adapter;
  return {
    cycle: options.cycle,
    items: options.items,
    label: options.label,
    partial: options.partial === true,
    artifactRoot,
    artifactPaths: internal.artifactPaths ?? DEFAULT_ASSESSMENT_FANOUT_ARTIFACT_PATHS,
    buildPrompt,
    buildOutput,
    logOutput,
    writeAdditionalArtifacts,
    writeFailureArtifact: internal.writeFailureArtifact,
  };
}

/**
 * Run provider fan-out for a command assessment. In strict mode every failure
 * is fatal; in partial mode (`partial: true`) per-job failures surface in
 * `failures` alongside surviving outputs, but an all-failed fan-out throws so
 * fix-cycle flows cannot silently complete with no findings.
 *
 * @returns {Promise<AssessmentFanoutResult>}
 */
export async function runAssessmentProviderFanout(dependencies, options = {}) {
  const {
    cycle,
    items,
    label,
    partial,
    artifactRoot,
    artifactPaths,
    buildPrompt,
    buildOutput,
    logOutput,
    writeAdditionalArtifacts,
    writeFailureArtifact,
  } = normalizeAssessmentFanoutOptions(options);
  const {
    context,
    store,
    logger = {},
    providerSessions,
    options: phaseOptions,
    fanoutParallel,
  } = dependencies;
  const {
    providers,
    model,
    timeoutMs,
    providerRetries,
  } = phaseOptions;
  const jobs = buildAssessmentFanoutJobs({ providers, items });
  const run = createFanoutJobRunner({
    cycle,
    artifactRoot,
    artifactPaths,
    buildPrompt,
    buildOutput,
    logOutput,
    writeAdditionalArtifacts,
    writeFailureArtifact,
    context,
    store,
    logger,
    providerSessions,
    model,
    timeoutMs,
    providerRetries,
  });

  if (!partial) {
    const outputs = await runFanout({
      jobs,
      run,
      parallel: fanoutParallel,
      label,
    });
    return { outputs, failures: [] };
  }

  const { results: outputs, failures: rawFailures } = await runFanout({
    jobs,
    run,
    parallel: fanoutParallel,
    label,
    partial: true,
  });
  const failures = rawFailures.map(toAssessmentFanoutFailure);
  if (outputs.length === 0 && failures.length > 0) {
    throw new Error(
      `${label} failed: ${failures.map((failure) => failure.error).join('; ')}`,
      { cause: failures },
    );
  }
  return { outputs, failures, partial: true };
}

function toAssessmentFanoutFailure(failure) {
  const job = failure.job || {};
  return {
    provider: job.provider?.id ?? 'unknown',
    item: job.item?.label,
    error: formatFailureMessage(failure.error),
  };
}

function isAssessmentFanoutItemDescriptor(item) {
  return Boolean(
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && Object.prototype.hasOwnProperty.call(item, 'value'),
  );
}

function createFanoutJobRunner({
  cycle,
  artifactRoot,
  artifactPaths,
  buildPrompt,
  buildOutput,
  logOutput,
  writeAdditionalArtifacts,
  writeFailureArtifact,
  context,
  store,
  logger,
  providerSessions,
  model,
  timeoutMs,
  providerRetries,
}) {
  return async function run({ provider, item }) {
    const artifact = artifactPaths({ cycle, artifactRoot, provider, item });
    const promptArgs = {
      provider,
      item: item.value,
      itemDescriptor: item,
      itemIndex: item.itemIndex,
      context,
      cycle,
    };
    const runArtifacts = createProviderItemRunArtifacts({
      store,
      promptPath: artifact.promptPath,
      outputPath: artifact.path,
      metadata: artifact,
    });
    const sessionKey = providerSessionKey({ provider, artifact: runArtifacts });
    const { result, artifact: writtenArtifact } = await runProviderItem({
      provider,
      label: item.label,
      prompt: buildPrompt(promptArgs),
      artifacts: runArtifacts,
      cwd: context.repoRoot,
      model,
      timeoutMs,
      logger,
      retry: { retries: providerRetries },
      session: providerSessions && sessionKey ? {
        resumeSessionId: providerSessions[sessionKey],
        onSessionInvalid: () => {
          delete providerSessions[sessionKey];
        },
        onSession: ({ sessionId }) => {
          providerSessions[sessionKey] = sessionId;
        },
      } : undefined,
      artifactPolicy: typeof writeFailureArtifact === 'function' ? {
        writeFailure: ({ error }) => writeFailureArtifact({
          store,
          cycle,
          artifact: runArtifacts,
          error,
        }),
      } : undefined,
    });

    const resultArgs = { ...promptArgs, result, text: result?.text };
    const output = buildOutput(resultArgs);
    const outputArgs = { ...resultArgs, output, artifact: writtenArtifact };
    if (typeof writeAdditionalArtifacts === 'function') {
      await writeAdditionalArtifacts(outputArgs);
    }
    if (!logger.jsonMode && typeof logOutput === 'function') {
      logOutput(outputArgs);
    }
    return output;
  };
}

function providerSessionKey({ provider, artifact }) {
  const providerId = String(provider?.id || '').trim();
  const root = String(artifact?.artifactRoot || '').trim();
  const item = String(artifact?.itemFile || '').trim();
  return [providerId, root, item].filter(Boolean).join('/');
}
