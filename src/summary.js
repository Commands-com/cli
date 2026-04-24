import {
  SCORE_ORDER,
  SUMMARY_FIELD,
  SUMMARY_FIELD_NAMES,
  VERDICT_VALUES,
} from './summary-contract.js';

const SUMMARY_FIELD_SET = new Set(SUMMARY_FIELD_NAMES);
const SCORE_PATTERN = new RegExp(`^(${SCORE_ORDER.join('|')})\\b`, 'i');
const SUMMARY_KEY_VALUE_PATTERN = /^([A-Za-z_][\w-]*):(?:[ \t]*(.*))?$/;

function summaryBlockMatch(text, { topOnly = false } = {}) {
  const source = String(text || '').trimStart();
  const pattern = topOnly
    ? /^```(?!`)ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```(?!`)/i
    : /(?:^|\n)```(?!`)ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```(?!`)/i;
  return source.match(pattern);
}

function summaryYamlBlock(match) {
  return match ? match[1] : '';
}

export function yamlScalar(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function normalizeSummaryLines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n');
}

function malformedLine(line, index, reason) {
  return {
    line: index + 1,
    reason,
    text: line,
  };
}

function malformedField(record, reason) {
  return {
    field: record.field,
    line: record.line,
    reason,
    text: record.text,
  };
}

function duplicateField(line, index, field) {
  return {
    field,
    line: index + 1,
    reason: 'duplicate-key',
    text: line,
  };
}

function leadingWhitespaceLength(line) {
  return line.match(/^[ \t]*/)?.[0].length || 0;
}

function blockScalarValue(lines, startIndex, mode) {
  const blockLines = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() && !/^[ \t]/.test(line)) break;
    blockLines.push(line);
    index += 1;
  }

  const indents = blockLines
    .filter((line) => line.trim())
    .map((line) => leadingWhitespaceLength(line));
  const indent = indents.length ? Math.min(...indents) : 0;
  const normalized = blockLines.map((line) => (line.trim() ? line.slice(indent) : ''));
  const value = mode === '>'
    ? normalized.join('\n').replace(/[ \t]*\n[ \t]*/g, ' ')
    : normalized.join('\n');

  return {
    nextIndex: index,
    value: value.trim(),
  };
}

function normalizedScore(value) {
  return yamlScalar(value).match(SCORE_PATTERN)?.[1]?.toUpperCase() || '';
}

function normalizedVerdict(value) {
  const verdict = yamlScalar(value).toLowerCase();
  return VERDICT_VALUES.includes(verdict) ? verdict : '';
}

function parsedIssueCount(value) {
  const clean = yamlScalar(value);
  if (!/^\d+$/.test(clean)) return undefined;
  const count = Number.parseInt(clean, 10);
  return Number.isSafeInteger(count) ? count : undefined;
}

function verdictContradictions(verdict, issueCount, hasNumericIssueCount) {
  if (!hasNumericIssueCount) return [];
  if (verdict === 'clean' && issueCount > 0) return ['clean-with-positive-issue-count'];
  if (verdict === 'issues' && issueCount === 0) return ['issues-with-zero-issue-count'];
  return [];
}

// Parses the YAML-like content inside a commands.com summary, not a whole
// provider response. It is intentionally line-oriented and supports only the
// summary fields above plus simple block scalars.
export function parseSummary(summaryContent) {
  const lines = normalizeSummaryLines(summaryContent);
  const fields = {};
  const fieldRecords = {};
  const malformed = [];
  const duplicates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^[ \t]/.test(line)) {
      malformed.push(malformedLine(line, index, 'unexpected-indented-line'));
      continue;
    }

    const match = line.match(SUMMARY_KEY_VALUE_PATTERN);
    if (!match) {
      malformed.push(malformedLine(line, index, 'expected-key-value'));
      continue;
    }

    const field = match[1].toLowerCase();
    if (!SUMMARY_FIELD_SET.has(field)) continue;
    const value = match[2] ?? '';
    if (Object.hasOwn(fields, field)) {
      duplicates.push(duplicateField(line, index, field));
      const duplicateScalarMode = value.trim();
      if (duplicateScalarMode === '|' || duplicateScalarMode === '>') {
        const block = blockScalarValue(lines, index + 1, duplicateScalarMode);
        index = block.nextIndex - 1;
      }
      continue;
    }

    const scalarMode = value.trim();
    if (scalarMode === '|' || scalarMode === '>') {
      const block = blockScalarValue(lines, index + 1, scalarMode);
      fields[field] = block.value;
      fieldRecords[field] = { field, line: index + 1, text: line };
      index = block.nextIndex - 1;
    } else {
      fields[field] = value;
      fieldRecords[field] = { field, line: index + 1, text: line };
    }
  }

  const issueCountPresent = Object.hasOwn(fields, SUMMARY_FIELD.ISSUE_COUNT);
  const issueCount = parsedIssueCount(fields[SUMMARY_FIELD.ISSUE_COUNT]);
  const hasNumericIssueCount = issueCount !== undefined;
  const hasMalformedIssueCount = issueCountPresent && !hasNumericIssueCount;
  if (hasMalformedIssueCount) {
    malformed.push(malformedField(fieldRecords[SUMMARY_FIELD.ISSUE_COUNT], 'invalid-issue-count'));
  }
  malformed.sort((a, b) => a.line - b.line || a.reason.localeCompare(b.reason));
  const verdict = normalizedVerdict(fields[SUMMARY_FIELD.VERDICT]);
  const contradictions = verdictContradictions(verdict, issueCount, hasNumericIssueCount);
  const hasMalformedFields = malformed.length > 0;

  return {
    fields,
    score: normalizedScore(fields[SUMMARY_FIELD.SCORE]),
    verdict,
    issueCount,
    issueCountPresent,
    hasNumericIssueCount,
    summary: yamlScalar(fields[SUMMARY_FIELD.SUMMARY]),
    malformed,
    hasMalformedFields,
    hasMalformedIssueCount,
    duplicates,
    hasDuplicateFields: duplicates.length > 0,
    contradictions,
    contradictsVerdict: contradictions.length > 0,
  };
}

// Extracts a fenced ```yaml summary block from a full provider response, then
// parses the YAML-like summary content with parseSummary.
export function parseSummaryBlock(text, { topOnly = false } = {}) {
  const match = summaryBlockMatch(text, { topOnly });
  const yaml = summaryYamlBlock(match);
  return {
    ...parseSummary(yaml),
    found: Boolean(match),
    yaml,
  };
}
