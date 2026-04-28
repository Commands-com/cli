/**
 * @typedef {(value: string) => void} LogWriter
 *
 * @typedef {object} LoggerOptions
 * @property {boolean} [json]
 * @property {string} [kind]
 * @property {LogWriter} [stdout]
 * @property {LogWriter} [stderr]
 */

/**
 * @param {LoggerOptions} [options]
 */
export function createLogger({
  json = false,
  kind = '',
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const jsonMode = Boolean(json);
  const prefix = kind ? `[${kind}] ` : '';

  function writeStdout(value) {
    stdout(String(value));
  }

  return Object.freeze({
    kind,
    jsonMode,
    child(nextKind) {
      return createLogger({ json: jsonMode, kind: nextKind, stdout, stderr });
    },
    line(value = '') {
      if (!jsonMode) writeStdout(value);
    },
    info(value = '') {
      if (!jsonMode) writeStdout(`${prefix}${value}`);
    },
    warn(value = '') {
      stderr(String(value));
    },
    json(value) {
      writeStdout(JSON.stringify(value, null, 2));
    },
    error(value = '') {
      stderr(String(value));
    },
  });
}

/**
 * @param {{ flags?: { has?: (name: string) => boolean } } | null | undefined} parsed
 * @param {Pick<LoggerOptions, 'kind' | 'stdout' | 'stderr'>} [options]
 */
export function createCommandLogger(parsed, { kind = '', stdout, stderr } = {}) {
  return createLogger({
    json: Boolean(parsed?.flags?.has?.('json')),
    kind,
    stdout,
    stderr,
  });
}
