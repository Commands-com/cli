export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const SHELL_OUTPUT_CAP_BYTES = DEFAULT_MAX_OUTPUT_BYTES;
export const PROCESS_KILL_GRACE_MS = 2_000;

export function resolveProviderLimits(options = {}) {
  return {
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxOutputBytes: Number.isFinite(options.maxOutputBytes) ? options.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES,
  };
}
