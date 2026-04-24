import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFiniteNonNegativeNumber,
  normalizeIssueCount,
} from '../src/number-utils.js';

test('normalizeFiniteNonNegativeNumber pins boundary handling', () => {
  const cases = [
    { label: 'zero', value: 0, expected: 0 },
    { label: 'finite positive integer', value: 3, expected: 3 },
    { label: 'finite positive float', value: 7.5, expected: 7.5 },
    { label: 'negative', value: -1, expected: 0 },
    { label: 'NaN', value: Number.NaN, expected: 0 },
    { label: 'POSITIVE_INFINITY', value: Number.POSITIVE_INFINITY, expected: 0 },
    { label: 'NEGATIVE_INFINITY', value: Number.NEGATIVE_INFINITY, expected: 0 },
    { label: 'numeric string', value: '4', expected: 0 },
    { label: 'null', value: null, expected: 0 },
  ];

  for (const { label, value, expected } of cases) {
    assert.strictEqual(normalizeFiniteNonNegativeNumber(value), expected, label);
  }
});

test('normalizeIssueCount coerces numeric issue counts before normalization', () => {
  assert.strictEqual(normalizeIssueCount('4'), 4);
  assert.strictEqual(normalizeIssueCount(3), 3);
  assert.strictEqual(normalizeIssueCount('2.5'), 2.5);
});

test('normalizeIssueCount treats missing, invalid, and negative counts as zero', () => {
  for (const value of [undefined, null, '', 'not-a-number', -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.strictEqual(normalizeIssueCount(value), 0);
  }
});
