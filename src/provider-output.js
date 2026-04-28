import {
  codexJsonlStdoutDiagnostics,
  extractCodexJsonlSessionId,
  extractCodexJsonlText,
} from './codex-jsonl.js';
import { getProviderAdapter } from './provider-adapters.js';
import { outputString } from './output-string.js';

export function extractGenericProviderText(stdout) {
  const trimmed = outputString(stdout).trim();
  if (!trimmed) return '';

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.text === 'string') return parsed.text;
  }
  return trimmed;
}

export function extractGenericProviderSessionId(stdout) {
  const trimmed = outputString(stdout).trim();
  if (!trimmed) return '';

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  const candidates = [trimmed];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i] && lines[i] !== trimmed) candidates.push(lines[i]);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const sessionId = String(
      parsed.session_id
        || parsed.sessionId
        || parsed.conversation_id
        || parsed.conversationId
        || '',
    ).trim();
    if (sessionId) return sessionId;
  }
  return '';
}

const OUTPUT_EXTRACTORS = Object.freeze({
  'codex-jsonl': extractCodexJsonlText,
  generic: extractGenericProviderText,
});

const SESSION_EXTRACTORS = Object.freeze({
  'codex-jsonl': extractCodexJsonlSessionId,
  generic: extractGenericProviderSessionId,
});

const OUTPUT_DIAGNOSTICS = Object.freeze({
  'codex-jsonl': codexJsonlStdoutDiagnostics,
});

function extractTextForAdapter(adapter) {
  return OUTPUT_EXTRACTORS[adapter?.output] || extractGenericProviderText;
}

export function extractProviderTextForAdapter(adapter, stdout) {
  return extractTextForAdapter(adapter)(stdout);
}

export function extractProviderText(providerId, stdout) {
  const adapter = getProviderAdapter(providerId);
  return extractProviderTextForAdapter(adapter, stdout);
}

function extractSessionForAdapter(adapter) {
  return SESSION_EXTRACTORS[adapter?.output] || extractGenericProviderSessionId;
}

export function extractProviderSessionIdForAdapter(adapter, stdout) {
  return extractSessionForAdapter(adapter)(stdout);
}

export function extractProviderSessionId(providerId, stdout) {
  const adapter = getProviderAdapter(providerId);
  return extractProviderSessionIdForAdapter(adapter, stdout);
}

function isContinuationByte(byte) {
  return (byte & 0xC0) === 0x80;
}

function utf8SequenceLength(lead) {
  if (lead <= 0x7F) return 1;
  if (lead >= 0xC2 && lead <= 0xDF) return 2;
  if (lead >= 0xE0 && lead <= 0xEF) return 3;
  if (lead >= 0xF0 && lead <= 0xF4) return 4;
  return 0;
}

function hasValidContinuationBytes(buf, start, length) {
  for (let i = 1; i < length; i += 1) {
    if (!isContinuationByte(buf[start + i])) return false;
  }
  return true;
}

function completeUtf8PrefixLength(buf, maxBytes) {
  let end = Math.min(Math.max(0, maxBytes), buf.length);
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && isContinuationByte(buf[start])) start -= 1;
    const sequenceLength = utf8SequenceLength(buf[start]);
    const actualLength = end - start;
    if (
      sequenceLength > 0
      && actualLength === sequenceLength
      && hasValidContinuationBytes(buf, start, sequenceLength)
    ) {
      return end;
    }
    end = start;
  }
  return 0;
}

function chunkBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return { buffer: chunk, binary: true };
  if (chunk instanceof Uint8Array) return { buffer: Buffer.from(chunk), binary: true };
  return { buffer: Buffer.from(String(chunk ?? ''), 'utf8'), binary: false };
}

export function appendCapped(current, chunk, maxBytes) {
  const value = String(current ?? '');
  const cap = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Infinity;
  const { buffer, binary } = chunkBuffer(chunk);
  const completeLength = binary ? completeUtf8PrefixLength(buffer, buffer.length) : buffer.length;
  const completeBuffer = buffer.subarray(0, completeLength);
  const completeText = completeBuffer.toString('utf8');
  const hadIncompleteChunk = completeLength < buffer.length;

  if (Buffer.byteLength(value + completeText, 'utf8') <= cap) {
    return { value: value + completeText, truncated: hadIncompleteChunk };
  }

  const allowed = Math.max(0, cap - Buffer.byteLength(value, 'utf8'));
  const end = completeUtf8PrefixLength(completeBuffer, allowed);
  return {
    value: value + completeBuffer.subarray(0, end).toString('utf8'),
    truncated: true,
  };
}

export function providerFailureDetails(provider, stdout, stderr, maxChars = 1_000) {
  const parts = [];
  const trimmedStderr = outputString(stderr).trim();
  const trimmedStdout = outputString(stdout).trim();
  if (trimmedStderr) parts.push(`stderr: ${trimmedStderr.slice(0, maxChars)}`);
  const adapter = getProviderAdapter(provider?.id);
  const stdoutDiagnostics = OUTPUT_DIAGNOSTICS[adapter?.output];
  if (stdoutDiagnostics) parts.push(...stdoutDiagnostics(trimmedStdout, maxChars));
  const extracted = extractProviderText(provider?.id, trimmedStdout).trim();
  if (extracted) parts.push(`stdout: ${extracted.slice(0, maxChars)}`);
  if (!parts.length && trimmedStdout) parts.push(`stdout: ${trimmedStdout.slice(0, maxChars)}`);
  return parts.join('\n') || 'no stderr/stdout captured';
}
