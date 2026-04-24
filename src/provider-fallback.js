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

export async function runWithProviderFallback({
  providerChain,
  runForProvider,
  onFallback,
  isTransient = isTransientProviderError,
}) {
  let lastError;
  for (let index = 0; index < providerChain.length; index += 1) {
    const provider = providerChain[index];
    const nextProvider = providerChain[index + 1] ?? null;
    try {
      return await runForProvider(provider, { isLast: !nextProvider, nextProvider });
    } catch (error) {
      lastError = error;
      if (!nextProvider || !isTransient(error)) throw error;
      if (onFallback) await onFallback({ from: provider, to: nextProvider, error });
    }
  }
  throw lastError;
}
