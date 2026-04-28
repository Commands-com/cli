import { runProviderWithRetry } from './providers.js';

/**
 * @typedef {import('./cycle-state.js').CycleProvider} ProviderDescriptor
 */

/**
 * Structured artifact writers created by `createProviderItemRunArtifacts`.
 *
 * @typedef {object} ProviderItemArtifacts
 * @property {string} promptPath
 * @property {string} outputPath
 * @property {string} path
 * @property {(prompt: string) => (void|Promise<void>)} writePrompt
 * @property {(text: string) => (void|Promise<void>)} writeOutput
 */

/**
 * Input shape for `providerItemHookPayload`. Optional fields appear only on
 * the hook payloads that actually carry them (retry counts on retry hooks,
 * sessionId on the post-run session hook, error on failure/invalid hooks).
 *
 * @typedef {object} ProviderItemHookPayload
 * @property {ProviderDescriptor} [provider]
 * @property {string} [label]
 * @property {ProviderItemArtifacts} [artifacts]
 * @property {Error} [error]
 * @property {number} [retry]
 * @property {number} [retries]
 * @property {string} [sessionId]
 */

/**
 * @typedef {object} ProviderItemExecution
 * @property {boolean} [allowTools]
 */

/**
 * @typedef {object} ProviderItemRetry
 * @property {number} [retries]
 * @property {number} [delayMs]
 * @property {(payload: ProviderItemHookPayload) => string} [logMessage]
 */

/**
 * @typedef {object} ProviderItemArtifactPolicy
 * @property {(payload: ProviderItemHookPayload) => (void|Promise<void>)} [writeRetry]
 * @property {(payload: ProviderItemHookPayload) => (void|Promise<void>)} [writeFailure]
 */

/**
 * @typedef {object} ProviderItemOutputPolicy
 * @property {boolean} [allowEmpty]
 */

/**
 * @typedef {object} ProviderItemSession
 * @property {string} [resumeSessionId]
 * @property {(payload: ProviderItemHookPayload) => (void|Promise<void>)} [onSessionInvalid]
 * @property {(payload: ProviderItemHookPayload) => (void|Promise<void>)} [onSession]
 */

/**
 * Args bag consumed by `runProviderItem`. Parallel in spirit to
 * `RunProviderOptions` in `provider-invocation.js`: a single options bag.
 * Every field is marked optional at the type level so the `args = {}` default
 * type-checks; `provider` and `artifacts.writePrompt`/`artifacts.writeOutput`
 * must be present at runtime.
 *
 * @typedef {object} RunProviderItemArgs
 * @property {ProviderDescriptor} [provider]
 * @property {string} [label]
 * @property {string} [prompt]
 * @property {ProviderItemArtifacts} [artifacts]
 * @property {string} [cwd]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {{info?: (message: string) => void}} [logger]
 * @property {ProviderItemExecution} [execution]
 * @property {ProviderItemRetry} [retry]
 * @property {ProviderItemArtifactPolicy} [artifactPolicy]
 * @property {ProviderItemOutputPolicy} [outputPolicy]
 * @property {ProviderItemSession} [session]
 */

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
 * @param {RunProviderItemArgs} [args]
 * @returns {Promise<{artifact: ProviderItemArtifacts, result: Object, text: string}>}
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

  await artifacts.writePrompt(prompt);

  const resumeSessionId = String(args.session?.resumeSessionId || '').trim();

  let result;
  try {
    const run = (sessionId) => runProviderWithRetry(provider, {
      cwd,
      prompt,
      model,
      allowTools: args.execution?.allowTools ?? false,
      timeoutMs,
      resumeSessionId: sessionId,
      retries: args.retry?.retries,
      retryDelayMs: args.retry?.delayMs,
      onRetry: async ({ retry: retryNumber, retries, error }) => {
        const payload = providerItemHookPayload({ provider, label, artifacts, error, retry: retryNumber, retries });
        if (typeof args.artifactPolicy?.writeRetry === 'function') {
          await args.artifactPolicy.writeRetry(payload);
        }
        const logMessage = typeof args.retry?.logMessage === 'function'
          ? args.retry.logMessage
          : defaultRetryLogMessage;
        logger.info?.(logMessage({
          ...payload,
          retry: retryNumber,
          retries,
        }));
      },
    });
    try {
      result = await run(resumeSessionId);
    } catch (error) {
      if (!resumeSessionId || !isInvalidSessionError(error)) throw error;
      if (typeof args.session?.onSessionInvalid === 'function') {
        await args.session.onSessionInvalid(providerItemHookPayload({ provider, label, artifacts, error }));
      }
      logger.info?.(`${provider.id}/${label}: provider session invalid; retrying fresh`);
      result = await run('');
    }
    if (!args.outputPolicy?.allowEmpty && !String(result?.text ?? '').trim()) {
      throw new Error(`${provider.id}/${label}: provider returned empty output`);
    }
  } catch (error) {
    if (typeof args.artifactPolicy?.writeFailure === 'function') {
      await args.artifactPolicy.writeFailure(providerItemHookPayload({ provider, label, artifacts, error }));
    }
    throw error;
  }

  if (result.sessionId && typeof args.session?.onSession === 'function') {
    await args.session.onSession(providerItemHookPayload({
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

/**
 * @param {ProviderItemHookPayload} args
 */
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

// Codex/Claude/Gemini do not surface a structured invalid-session signal
// today; stale/unknown session ids land as free-text inside the generic
// non-zero-exit error wrapped by src/providers.js (sourced from stderr or
// the codex JSONL `error` events parsed in src/codex-jsonl.js and
// src/provider-output.js). Match any of the session-related nouns
// (session/thread/conversation/resume) paired with an invalidating term
// (invalid/expired/not found/unknown) in either order so reversed
// phrasings like "invalid session id" and provider-specific phrasings
// like "thread not found" trigger the fresh-session retry path. Stay
// conservative: transient/tool failures (ETIMEDOUT, capacity, rate
// limit, stream disconnects) match neither side and keep the saved
// session id, falling through to the surrounding withRetries layer.
const INVALID_SESSION_PATTERN = /\b(?:session|thread|conversation|resume)\b[^\n]{0,120}?\b(?:invalid|expired|not\s+found|unknown)\b|\b(?:invalid|expired|not\s+found|unknown)\b[^\n]{0,120}?\b(?:session|thread|conversation|resume)\b/i;

function isInvalidSessionError(error) {
  if (!error) return false;
  return INVALID_SESSION_PATTERN.test(String(error.message || error));
}
