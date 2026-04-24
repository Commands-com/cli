class CliError extends Error {
  constructor(message, { code = 'error', exitCode = 1, details = undefined } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends CliError {
  constructor(message, details) {
    super(message, { code: 'usage_error', exitCode: 2, details });
    this.name = 'UsageError';
  }
}

export function normalizeError(error) {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(message);
}

export function formatFailureMessage(failure) {
  return failure?.message || String(failure);
}

export function combineErrors(errors) {
  const filtered = errors.filter(Boolean);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];
  return new AggregateError(filtered, filtered.map(formatFailureMessage).join('; '));
}
