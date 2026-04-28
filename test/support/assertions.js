/**
 * @param {unknown} error
 * @param {string} name
 * @param {string | RegExp} message
 * @returns {boolean}
 */
export function hasErrorNameAndMessage(error, name, message) {
  const actual = /** @type {{ name?: unknown, message?: unknown }} */ (error);
  if (actual.name !== name || typeof actual.message !== 'string') return false;
  return typeof message === 'string' ? actual.message === message : message.test(actual.message);
}

/**
 * @param {unknown} error
 * @param {string | RegExp} message
 * @returns {boolean}
 */
export function isUsageError(error, message) {
  return hasErrorNameAndMessage(error, 'UsageError', message);
}

/**
 * @param {unknown} error
 * @returns {{ message: string, cause: Array<{ provider: string, item: string, error: string }> }}
 */
export function fanoutError(error) {
  return /** @type {{ message: string, cause: Array<{ provider: string, item: string, error: string }> }} */ (error);
}
