/**
 * Shared tolerant string coercion for provider and process output.
 *
 * External tool output can arrive as nullish or hostile values in tests and
 * failure paths, so callers use this stable helper before trimming/parsing.
 */
export function outputString(value) {
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}
