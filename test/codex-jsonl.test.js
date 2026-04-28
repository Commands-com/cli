import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexJsonlStdoutDiagnostics,
  extractCodexJsonlText,
} from '../src/codex-jsonl.js';

function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

test('codex jsonl extraction falls back to the last complete assistant message after a partial turn result', () => {
  const stdout = jsonl([
    { type: 'item.completed', item: { type: 'agent_message', text: 'first complete message' } },
    { type: 'item.completed', item: { type: 'message', text: 'last complete assistant message' } },
    '{"type":"turn.completed","result":"truncated final',
  ]);

  assert.equal(extractCodexJsonlText(stdout), 'last complete assistant message');
  assert.deepEqual(codexJsonlStdoutDiagnostics(stdout, 1_000), [
    'stdout last message: last complete assistant message',
    'stdout parse errors: 1 line(s)',
  ]);
});

test('codex jsonl diagnostics ignore partial trailing events and keep complete stream context', () => {
  const stdout = jsonl([
    { type: 'progress', message: 'running tool call' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'complete assistant context' } },
    { type: 'error', message: 'complete stream error' },
    '{"type":"error","message":"partial stream error',
  ]);

  const diagnostics = codexJsonlStdoutDiagnostics(stdout, 1_000);

  assert.deepEqual(diagnostics, [
    'stdout error: complete stream error',
    'stdout progress: running tool call',
    'stdout last message: complete assistant context',
    'stdout parse errors: 1 line(s)',
  ]);
  assert.equal(extractCodexJsonlText(stdout), 'complete assistant context');
});

test('codex jsonl diagnostics surface a parse-error count when malformed lines mix with valid JSONL', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    '',
    '   ',
    'this is not json',
    '{"type":"turn.completed","result":"truncated',
    JSON.stringify({ type: 'item.completed', item: { type: 'message', text: 'final' } }),
  ].join('\n');

  const diagnostics = codexJsonlStdoutDiagnostics(stdout, 1_000);

  assert.ok(
    diagnostics.includes('stdout parse errors: 2 line(s)'),
    `expected parse-error diagnostic, got: ${JSON.stringify(diagnostics)}`,
  );
});
