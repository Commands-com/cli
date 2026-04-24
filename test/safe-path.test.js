import test from 'node:test';
import assert from 'node:assert/strict';
import { safePathSegment } from '../src/safe-path.js';

test('safePathSegment normalizes unsafe characters to lowercase separators', () => {
  assert.equal(safePathSegment(' ../Review Lead: API & UI/UX! '), 'review-lead-api-ui-ux');
  assert.equal(safePathSegment('Café\\Team\tQA#1'), 'caf-team-qa-1');
});

test('safePathSegment treats dots as separators for non-file path segments', () => {
  assert.equal(safePathSegment('Gemini CLI.v2'), 'gemini-cli-v2');
  assert.equal(safePathSegment('implementation-plan.attempt-1-error'), 'implementation-plan-attempt-1-error');
});

test('safePathSegment sanitizes fallback when input has no safe characters', () => {
  assert.equal(safePathSegment('!!!', '../Fallback Value'), 'fallback-value');
  assert.equal(safePathSegment('!!!', '***'), 'item');
});

test('safePathSegment keeps provided values that sanitize to a segment', () => {
  assert.equal(safePathSegment(0, 'fallback'), '0');
});

test('safePathSegment truncates without leaving edge separators', () => {
  const segment = safePathSegment(`${'a'.repeat(79)} ${'b'.repeat(50)}`);

  assert.ok(segment.length <= 80);
  assert.equal(segment.length, 79);
  assert.doesNotMatch(segment, /-$/);
});

test('safePathSegment caps long segments at 80 characters', () => {
  assert.equal(safePathSegment('A'.repeat(100)), 'a'.repeat(80));
});

test('safePathSegment applies the same boundary to fallback names', () => {
  const segment = safePathSegment('', 'Fallback/'.repeat(20));

  assert.ok(segment.length <= 80);
  assert.match(segment, /^fallback(?:-fallback)*$/);
  assert.doesNotMatch(segment, /-$/);
});
