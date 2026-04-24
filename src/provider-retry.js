import { normalizeFiniteNonNegativeNumber } from './number-utils.js';

export function isTransientProviderError(error) {
  const message = String(error?.message || error || '');
  return [
    /stream disconnected/i,
    /reconnecting\.\.\./i,
    /retry your request/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /gateway timeout/i,
    /socket hang up/i,
    /overloaded/i,
    /at capacity/i,
    /rate limit/i,
    /\bECONNRESET\b/i,
    /\bECONNREFUSED\b/i,
    /\bENOTFOUND\b/i,
    /\bETIMEDOUT\b/i,
    /\bEPIPE\b/i,
    /\bEAI_AGAIN\b/i,
    /(?:status|http|code|response)\D{0,12}?50[234]\b/i,
  ].some((pattern) => pattern.test(message));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runProviderWithRetry(provider, options = {}, runProvider, sleepFn = sleep) {
  if (typeof runProvider !== 'function') {
    throw new TypeError('runProviderWithRetry requires a provider runner function');
  }

  const retries = normalizeFiniteNonNegativeNumber(options.retries);
  const retryDelayMs = normalizeFiniteNonNegativeNumber(options.retryDelayMs ?? 750);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runProvider(provider, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isTransientProviderError(error)) {
        throw error;
      }
      const retryNumber = attempt + 1;
      if (typeof options.onRetry === 'function') {
        await options.onRetry({ provider, error, retry: retryNumber, retries });
      }
      if (retryDelayMs > 0) await sleepFn(retryDelayMs * retryNumber);
    }
  }
  throw lastError;
}
