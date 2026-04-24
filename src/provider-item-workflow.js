import { runProviderWithRetry } from './providers.js';

/**
 * Create structured artifact writers for one provider/item run.
 *
 * @param {Object} args
 * @param {Object} args.store Artifact store with a `write` method.
 * @param {string} args.promptPath Prompt artifact path.
 * @param {string} args.outputPath Output artifact path.
 * @param {Object} [args.metadata] Additional artifact metadata to preserve.
 * @returns {Object}
 */
export function createProviderItemRunArtifacts({
  store,
  promptPath,
  outputPath,
  metadata = {},
}) {
  return {
    ...metadata,
    promptPath,
    outputPath,
    path: outputPath,
    writePrompt: (prompt) => store.write(promptPath, prompt),
    writeOutput: (text) => store.write(outputPath, text),
  };
}

/**
 * Run a single provider prompt and persist its prompt/output artifacts.
 *
 * @param {Object} args
 * @param {Object} args.provider Provider descriptor.
 * @param {string} args.label Human-readable item label for retry logs.
 * @param {string} args.prompt Provider prompt.
 * @param {Object} args.artifacts Structured artifact writers.
 * @param {string} args.cwd Provider working directory.
 * @param {string} [args.model] Provider model override.
 * @param {number} [args.timeoutMs] Provider timeout.
 * @param {Object} [args.logger] Optional logger.
 * @param {Object} [args.execution] Provider execution policy.
 * @param {boolean} [args.execution.allowTools] Whether provider tool use is allowed.
 * @param {Object} [args.retry] Provider retry policy.
 * @param {number} [args.retry.retries] Provider retry count.
 * @param {number} [args.retry.delayMs] Delay multiplier for transient retries.
 * @param {(args: Object) => string} [args.retry.logMessage] Optional retry log formatter.
 * @param {Object} [args.artifactPolicy] Optional retry/failure artifact policy.
 * @param {(args: Object) => (void|Promise<void>)} [args.artifactPolicy.writeRetry] Optional retry artifact hook.
 * @param {(args: Object) => (void|Promise<void>)} [args.artifactPolicy.writeFailure] Optional failure artifact hook.
 * @param {Object} [args.outputPolicy] Optional provider output policy.
 * @param {boolean} [args.outputPolicy.allowEmpty] Whether blank provider output is valid.
 * @param {Object} [args.session] Optional provider session policy.
 * @param {string} [args.session.resumeSessionId] Provider session id to resume.
 * @param {(args: Object) => (void|Promise<void>)} [args.session.onSessionInvalid] Hook called before retrying fresh.
 * @param {(args: Object) => (void|Promise<void>)} [args.session.onSession] Hook called with a fresh returned session id.
 * @returns {Promise<{artifact: Object, result: Object, text: string}>}
 */
export async function runProviderItem(args = {}) {
  const {
    provider,
    label,
    prompt,
    artifacts,
    cwd,
    model,
    timeoutMs,
    logger = {},
  } = args;
  const {
    execution,
    retry,
    artifactPolicy,
    outputPolicy,
    session,
  } = normalizeProviderItemPolicies(args);

  assertProviderItemRun({ provider, artifacts });
  await artifacts.writePrompt(prompt);

  let result;
  try {
    const run = (resumeSessionId) => runProviderWithRetry(provider, {
      cwd,
      prompt,
      model,
      allowTools: execution.allowTools,
      timeoutMs,
      resumeSessionId,
      retries: retry.retries,
      retryDelayMs: retry.delayMs,
      onRetry: async ({ retry: retryNumber, retries, error }) => {
        const payload = providerItemHookPayload({ provider, label, artifacts, error, retry: retryNumber, retries });
        if (typeof artifactPolicy.writeRetry === 'function') {
          await artifactPolicy.writeRetry(payload);
        }
        logger.info?.(retry.logMessage(payload));
      },
    });
    try {
      result = await run(session.resumeSessionId);
    } catch (error) {
      if (!session.resumeSessionId) throw error;
      await session.onSessionInvalid?.(providerItemHookPayload({ provider, label, artifacts, error }));
      logger.info?.(`${provider.id}/${label}: provider session invalid; retrying fresh`);
      result = await run('');
    }
    if (!outputPolicy.allowEmpty && !String(result?.text ?? '').trim()) {
      throw new Error(`${provider.id}/${label}: provider returned empty output`);
    }
  } catch (error) {
    if (typeof artifactPolicy.writeFailure === 'function') {
      await artifactPolicy.writeFailure(providerItemHookPayload({ provider, label, artifacts, error }));
    }
    throw error;
  }

  if (result.sessionId) {
    await session.onSession?.(providerItemHookPayload({
      provider,
      label,
      artifacts,
      sessionId: result.sessionId,
    }));
  }
  await artifacts.writeOutput(result.text);
  return {
    artifact: artifacts,
    result,
    text: result.text,
  };
}

function assertProviderItemRun({ provider, artifacts }) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('runProviderItem requires provider');
  }
  if (!artifacts || typeof artifacts.writePrompt !== 'function') {
    throw new Error('runProviderItem requires artifacts.writePrompt');
  }
  if (typeof artifacts.writeOutput !== 'function') {
    throw new Error('runProviderItem requires artifacts.writeOutput');
  }
}

function normalizeProviderItemPolicies(args) {
  return {
    execution: {
      allowTools: args.execution?.allowTools ?? false,
    },
    retry: {
      retries: args.retry?.retries,
      delayMs: args.retry?.delayMs,
      logMessage: typeof args.retry?.logMessage === 'function'
        ? args.retry.logMessage
        : defaultRetryLogMessage,
    },
    artifactPolicy: {
      writeRetry: typeof args.artifactPolicy?.writeRetry === 'function'
        ? args.artifactPolicy.writeRetry
        : undefined,
      writeFailure: typeof args.artifactPolicy?.writeFailure === 'function'
        ? args.artifactPolicy.writeFailure
        : undefined,
    },
    outputPolicy: {
      allowEmpty: Boolean(args.outputPolicy?.allowEmpty),
    },
    session: {
      resumeSessionId: String(args.session?.resumeSessionId || '').trim(),
      onSessionInvalid: typeof args.session?.onSessionInvalid === 'function'
        ? args.session.onSessionInvalid
        : undefined,
      onSession: typeof args.session?.onSession === 'function'
        ? args.session.onSession
        : undefined,
    },
  };
}

function providerItemHookPayload({
  provider,
  label,
  artifacts,
  error,
  retry,
  retries,
  sessionId,
}) {
  return {
    provider,
    label,
    artifact: artifacts,
    error,
    ...(retry === undefined ? {} : { retry }),
    ...(retries === undefined ? {} : { retries }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function defaultRetryLogMessage({
  provider,
  label,
  retry,
  retries,
}) {
  return `${provider.id}/${label}: retry ${retry}/${retries} after transient provider failure`;
}
