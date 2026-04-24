export function commandResult({ failed = false } = {}) {
  return {
    failed: Boolean(failed),
    exitCode: failed ? 1 : 0,
  };
}

export function completeCommandRun({
  logger,
  payload,
  failOnIssues,
  hasFinalIssues,
  onText,
}) {
  if (!logger) {
    throw new Error('completeCommandRun requires logger');
  }

  const failed = Boolean(failOnIssues && hasFinalIssues);
  if (logger.jsonMode) {
    logger.json(payload);
    return commandResult({ failed });
  }

  if (typeof onText === 'function') {
    onText(logger);
  }
  return commandResult({ failed });
}
