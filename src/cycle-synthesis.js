import {
  cycleMarkdownArtifactPath,
  cyclePromptArtifactPath,
  markdownArtifactPath,
  promptArtifactPath,
} from './artifact-paths.js';
import {
  createProviderItemRunArtifacts,
  runProviderItem,
} from './provider-item-workflow.js';
import { formatFailureMessage } from './errors.js';
import { isObjectRecord } from './objects.js';
import { isTransientProviderError } from './providers.js';
import { providerFallbackChain } from './provider-fallback.js';

/**
 * @typedef {import('./cycle-state.js').CycleProvider} CycleProvider
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./cycle-state.js').CycleLogger} CycleLogger
 */

/**
 * Runtime option subset used by synthesis.
 *
 * @typedef {Object} CycleSynthesisRuntimeOptions
 * @property {Array<CycleProvider>} [providers] Provider fallback chain.
 * @property {CycleProvider} primaryProvider Provider used for synthesis.
 * @property {string} [model] Provider model override.
 * @property {number} [timeoutMs] Provider timeout.
 * @property {number} [providerRetries] Transient provider retry count.
 */

/**
 * Explicit dependency object consumed by synthesis.
 *
 * @typedef {Object} CycleSynthesisDependencies
 * @property {CycleRepoContext} context Repository context for provider cwd.
 * @property {CycleStore} store Artifact store.
 * @property {CycleLogger} [logger] Command logger.
 * @property {CycleSynthesisRuntimeOptions} synthesisRuntimeOptions Synthesis runtime options.
 */

function createSynthesisArtifacts({
  store,
  promptPath,
  outputPath,
  errorPath,
}) {
  return createProviderItemRunArtifacts({
    store,
    promptPath,
    outputPath,
    metadata: {
      errorPath,
      writeError: (text) => store.write(errorPath, text),
    },
  });
}

function sharedCycleSynthesisErrorPath(cycle) {
  return cycleMarkdownArtifactPath(cycle, 'synthesis-error');
}

function providerCycleSynthesisErrorPath(cycle, provider) {
  return cycleMarkdownArtifactPath(cycle, 'synthesis-errors', provider.id);
}

function createCycleSynthesisArtifacts({
  store,
  cycle,
  provider,
  sharedError = true,
}) {
  return createSynthesisArtifacts({
    store,
    promptPath: cyclePromptArtifactPath(cycle, 'synthesis', provider.id),
    outputPath: cycleMarkdownArtifactPath(cycle, 'synthesis'),
    errorPath: sharedError
      ? sharedCycleSynthesisErrorPath(cycle)
      : providerCycleSynthesisErrorPath(cycle, provider),
  });
}

export function createRoomSynthesisArtifacts({ store, provider }) {
  return createSynthesisArtifacts({
    store,
    promptPath: promptArtifactPath('synthesis', provider.id),
    outputPath: markdownArtifactPath('synthesis'),
    errorPath: markdownArtifactPath('synthesis-error'),
  });
}

/**
 * @typedef {import('./provider-item-workflow.js').ProviderItemArtifacts & {
 *   writeError: (text: string) => (void|Promise<void>),
 * }} CycleSynthesisArtifacts
 *
 * @param {{
 *   providerCall: {
 *     provider: CycleProvider,
 *     model?: string,
 *     timeoutMs?: number,
 *     providerRetries?: number,
 *     cwd: string,
 *   },
 *   artifacts: CycleSynthesisArtifacts,
 *   logging?: {
 *     logger?: CycleLogger,
 *     prefix?: string,
 *     complete?: string,
 *     deferFallbackLog?: boolean,
 *   },
 *   prompt: string,
 *   fallbackDescription: string,
 * }} args
 */
export async function runProviderSynthesisWithFallback({
  providerCall,
  artifacts,
  logging = {},
  prompt,
  fallbackDescription,
}) {
  const {
    provider,
    model,
    timeoutMs,
    providerRetries,
    cwd,
  } = providerCall;
  const {
    logger,
    prefix = '',
    complete = '',
    deferFallbackLog = false,
  } = logging;

  logger?.info(`${prefix}synthesis (${provider.id})`);
  assertSynthesisArtifacts(artifacts);

  try {
    const synthesisResult = await runProviderItem({
      provider,
      label: 'synthesis',
      prompt,
      artifacts,
      cwd,
      model,
      timeoutMs,
      logger,
      retry: {
        retries: providerRetries,
        logMessage: ({ retry, retries }) => (
          `${prefix}synthesis retry ${retry}/${retries} after transient ${provider.id} failure`
        ),
      },
      artifactPolicy: {
        writeFailure: ({ error }) => artifacts.writeError(formatFailureMessage(error)),
      },
      outputPolicy: {
        allowEmpty: true,
      },
    });
    if (complete) logger?.info(complete);
    return {
      synthesisProvider: provider.id,
      synthesisText: synthesisResult.text,
      synthesisError: '',
    };
  } catch (error) {
    const synthesisError = formatFailureMessage(error);
    logger?.info(deferFallbackLog && isTransientProviderError(error)
      ? `${prefix}synthesis failed (${provider.id})`
      : `${prefix}synthesis failed (${provider.id}); using ${fallbackDescription}`);
    return {
      synthesisProvider: provider.id,
      synthesisText: '',
      synthesisError,
    };
  }
}

export async function runSynthesisWithFallback(dependencies, {
  cycle,
  prompt,
  fallbackDescription,
}) {
  assertCycleSynthesisDependencies(dependencies);
  const {
    context,
    store,
    logger,
    synthesisRuntimeOptions: runtimeOptions,
  } = dependencies;
  const {
    primaryProvider,
    providers,
    model,
    timeoutMs,
    providerRetries,
  } = runtimeOptions;
  const providerChain = providerFallbackChain(primaryProvider, providers);
  let lastResult;
  for (let index = 0; index < providerChain.length; index += 1) {
    const provider = providerChain[index];
    const isLast = index === providerChain.length - 1;
    const hasFallbackProvider = !isLast;
    const result = await runProviderSynthesisWithFallback({
      providerCall: {
        provider,
        model,
        timeoutMs,
        providerRetries,
        cwd: context.repoRoot,
      },
      artifacts: createCycleSynthesisArtifacts({
        store,
        cycle,
        provider,
        sharedError: !hasFallbackProvider,
      }),
      logging: {
        logger,
        prefix: `cycle ${cycle}: `,
        deferFallbackLog: hasFallbackProvider,
      },
      prompt,
      fallbackDescription,
    });
    lastResult = result;
    if (result.synthesisText) return result;
    if (!isTransientProviderError(result.synthesisError) || isLast) {
      if (hasFallbackProvider && result.synthesisError) {
        await store.write(sharedCycleSynthesisErrorPath(cycle), result.synthesisError);
      }
      return result;
    }
    logger?.info(`cycle ${cycle}: synthesis fallback ${provider.id} -> ${providerChain[index + 1].id}`);
  }
  return lastResult;
}

export function formatPriorFindings({
  synthesisText = '',
  synthesisError = '',
  findingsTitle,
  findingsText = '',
}) {
  return [
    '## Synthesis',
    synthesisText || (synthesisError ? `Synthesis failed: ${synthesisError}` : '(none)'),
    '',
    `## ${findingsTitle}`,
    findingsText || '(none)',
  ].join('\n');
}

function assertSynthesisArtifacts(artifacts) {
  const missing = [
    [typeof artifacts?.writePrompt === 'function', 'artifacts.writePrompt'],
    [typeof artifacts?.writeOutput === 'function', 'artifacts.writeOutput'],
    [typeof artifacts?.writeError === 'function', 'artifacts.writeError'],
  ].find(([passes]) => !passes);
  if (missing) throw new Error(`runProviderSynthesisWithFallback requires ${missing[1]}`);
}

function assertCycleSynthesisDependencies(dependencies) {
  const missing = [
    [isObjectRecord(dependencies), 'explicit synthesis dependencies'],
    [typeof dependencies?.context?.repoRoot === 'string', 'dependencies.context.repoRoot'],
    [typeof dependencies?.store?.write === 'function', 'dependencies.store.write'],
    [isObjectRecord(dependencies?.synthesisRuntimeOptions), 'dependencies.synthesisRuntimeOptions'],
    [
      typeof dependencies?.synthesisRuntimeOptions?.primaryProvider?.id === 'string',
      'dependencies.synthesisRuntimeOptions.primaryProvider',
    ],
  ].find(([passes]) => !passes);
  if (missing) throw new Error(`runSynthesisWithFallback requires ${missing[1]}`);
}
