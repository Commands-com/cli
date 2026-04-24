const DEFAULT_MAX_DIFF_CHARS = 40_000;

function truncateForPrompt(value, maxChars = DEFAULT_MAX_DIFF_CHARS, label = 'content') {
  const text = String(value || '');
  if (!Number.isFinite(maxChars) || maxChars < 1 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: [
      text.slice(0, maxChars),
      '',
      `[commands-com: ${label} truncated after ${maxChars} characters. Narrow the diff or inspect the full file locally.]`,
    ].join('\n'),
    truncated: true,
  };
}

export function formatRepoContext(context, { maxDiffChars = DEFAULT_MAX_DIFF_CHARS } = {}) {
  const diff = truncateForPrompt(context.diff || '', maxDiffChars, 'git diff');
  return [
    `Repository: ${context.repoRoot}`,
    context.gitRoot && context.gitRoot !== context.repoRoot ? `Git root: ${context.gitRoot}` : '',
    `Branch: ${context.branch || 'unknown'}`,
    `HEAD: ${context.head || 'unknown'}`,
    '',
    'Git status:',
    context.status || '(clean)',
    '',
    'Diff stat:',
    context.diffStat || '(no diff stat)',
    diff.text ? ['', 'Diff:', diff.text].join('\n') : '',
  ].filter((part) => part !== '').join('\n');
}
