import { isObjectRecord } from './objects.js';
import { outputString } from './output-string.js';

const ASSISTANT_ITEM_TYPES = new Set(['agent_message', 'message']);
const TEXT_BLOCK_TYPES = new Set(['text', 'output_text']);

function codexEventMessage(event) {
  if (typeof event.message === 'string') return event.message;
  if (typeof event.error?.message === 'string') return event.error.message;
  if (typeof event.error === 'string') return event.error;
  return '';
}

function isErrorEvent(event) {
  return event.type === 'error' || /error|failed/i.test(String(event.type || ''));
}

function isProgressEvent(event) {
  return /progress/i.test(String(event.type || ''));
}

function contentBlockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isObjectRecord(block) || typeof block.text !== 'string') return '';
      if (typeof block.type === 'string' && !TEXT_BLOCK_TYPES.has(block.type)) return '';
      return block.text;
    })
    .filter(Boolean)
    .join('\n');
}

function assistantItemText(item) {
  if (!isObjectRecord(item) || !ASSISTANT_ITEM_TYPES.has(item.type)) return '';
  if (typeof item.text === 'string') return item.text;
  return contentBlockText(item.content);
}

function parseCodexJsonl(stdout) {
  const raw = outputString(stdout).trim();
  const assistantMessages = [];
  const errors = [];
  const progressMessages = [];
  let sessionId = '';
  let turnResult = '';

  if (!raw) return { raw, assistantMessages, errors, progressMessages, sessionId, turnResult };

  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (!isObjectRecord(event)) continue;

      const assistantText = event.type === 'item.completed'
        ? assistantItemText(event.item)
        : '';
      if (assistantText) assistantMessages.push(assistantText);

      if (event.type === 'turn.completed' && typeof event.result === 'string') {
        turnResult = event.result;
      }

      const message = codexEventMessage(event);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      } else if (!sessionId && typeof event.session_id === 'string') {
        sessionId = event.session_id;
      }
      if (isErrorEvent(event) && message) {
        errors.push(message);
      } else if (isProgressEvent(event) && message) {
        progressMessages.push(message);
      }
    } catch {
      // Ignore non-JSON logs and truncated JSONL fragments.
    }
  }

  return { raw, assistantMessages, errors, progressMessages, sessionId, turnResult };
}

export function extractCodexJsonlText(stdout) {
  const parsed = parseCodexJsonl(stdout);
  return parsed.turnResult || parsed.assistantMessages.at(-1) || parsed.raw;
}

export function extractCodexJsonlSessionId(stdout) {
  return parseCodexJsonl(stdout).sessionId || '';
}

export function codexJsonlStdoutDiagnostics(stdout, maxChars) {
  const parsed = parseCodexJsonl(stdout);
  return [
    ...parsed.errors.map((message) => `stdout error: ${message.slice(0, maxChars)}`),
    parsed.progressMessages.length
      ? `stdout progress: ${parsed.progressMessages.at(-1).slice(0, maxChars)}`
      : '',
    parsed.assistantMessages.length
      ? `stdout last message: ${parsed.assistantMessages.at(-1).slice(0, maxChars)}`
      : '',
  ].filter(Boolean);
}
