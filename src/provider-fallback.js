import { isTransientProviderError } from './provider-retry.js';

export function providerFallbackChain(primaryProvider, providers) {
  const chain = [primaryProvider, ...(Array.isArray(providers) ? providers : [])].filter(Boolean);
  const seen = new Set();
  return chain.filter((provider) => {
    if (!provider?.id || seen.has(provider.id)) return false;
    seen.add(provider.id);
    return true;
  });
}

/**
 * Run `runForProvider` against the chain, handing transient failures down to
 * the next provider via `onFallback`.
 *
 * Error handling:
 *   - Transient error with a remaining fallback: swallowed; `onFallback` runs
 *     and the next provider is tried.
 *   - Non-transient error, or error on the last provider: chain is exhausted.
 *     If `onExhausted` is provided, its return value is returned to the
 *     caller (the error is swallowed); otherwise the error is rethrown.
 *
 * `onExhausted` receives `{ provider, error, isLast }` where `isLast`
 * indicates whether the failed provider was the final one in the chain.
 *
 * @template T
 * @param {{
 *   providerChain: Array<{ id: string }>,
 *   runForProvider: (provider: { id: string }, ctx: { isLast: boolean, nextProvider: { id: string } | null }) => Promise<T>,
 *   onFallback?: (event: { from: { id: string }, to: { id: string }, error: unknown }) => (void|Promise<void>),
 *   onExhausted?: (event: { provider: { id: string }, error: unknown, isLast: boolean }) => (T|Promise<T>),
 *   isTransient?: (error: unknown) => boolean,
 * }} options
 * @returns {Promise<T>}
 */
export async function runWithProviderFallback({
  providerChain,
  runForProvider,
  onFallback,
  onExhausted,
  isTransient = isTransientProviderError,
}) {
  if (!Array.isArray(providerChain) || providerChain.length === 0) {
    throw new Error('runWithProviderFallback called with empty providerChain');
  }
  for (let index = 0; index < providerChain.length; index += 1) {
    const provider = providerChain[index];
    const nextProvider = providerChain[index + 1] ?? null;
    const isLast = !nextProvider;
    try {
      return await runForProvider(provider, { isLast, nextProvider });
    } catch (error) {
      if (isLast || !isTransient(error)) {
        if (onExhausted) return await onExhausted({ provider, error, isLast });
        throw error;
      }
      if (onFallback) await onFallback({ from: provider, to: nextProvider, error });
    }
  }
}
