import { readCommandOptionValue } from './command-options.js';

/**
 * @param {Map<string, string | boolean>} flags
 * @param {{ providers?: string, provider?: string }} [runtimeOptions]
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveProviderRequest(flags, runtimeOptions = {}, fallback = 'all') {
  const explicitProviders = readCommandOptionValue(flags, 'providers', '');
  if (explicitProviders) return explicitProviders;
  const explicitProvider = readCommandOptionValue(flags, 'provider', '');
  if (explicitProvider) return explicitProvider;
  if (runtimeOptions.providers) return runtimeOptions.providers;
  if (runtimeOptions.provider && runtimeOptions.provider !== 'auto') return runtimeOptions.provider;
  return fallback;
}
