import { isObjectRecord } from './objects.js';

const PROMPT_INTENT_MARKER = 'commands-com-prompt-intent';

const TRAILING_PROMPT_INTENT_RE = new RegExp(
  `(?:^|\\r?\\n)[ \\t]*<!--\\s*${PROMPT_INTENT_MARKER}:\\s*([^\\r\\n]*?)\\s*-->\\s*$`,
  'i',
);

function normalizePromptIntent(intent = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(intent || {})) {
    if (value === undefined || value === null || value === '') continue;
    normalized[key] = value;
  }
  return normalized;
}

function formatPromptIntent(intent) {
  const normalized = normalizePromptIntent(intent);
  if (Object.keys(normalized).length === 0) return '';
  return `<!-- ${PROMPT_INTENT_MARKER}: ${JSON.stringify(normalized)} -->`;
}

function withPromptIntent(text, intent) {
  const marker = formatPromptIntent(intent);
  return marker ? [text, '', marker].join('\n') : text;
}

export function compactPrompt(parts, intent) {
  return withPromptIntent(parts.filter((part) => part !== '').join('\n'), intent);
}

export function literalPrompt(parts, intent) {
  return withPromptIntent(parts.join('\n'), intent);
}

function parsePromptIntentPayload(payload) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function splitPromptIntent(prompt) {
  const text = String(prompt || '');
  const match = text.match(TRAILING_PROMPT_INTENT_RE);
  if (!match) return { prompt: text, intent: null };
  return {
    prompt: text.slice(0, match.index).trimEnd(),
    intent: parsePromptIntentPayload(match[1]),
  };
}
