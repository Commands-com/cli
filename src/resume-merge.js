import { COMMAND_OPTIONS, PROVIDER_RESUME_FIELDS } from './command-option-schema.js';
import { hasAnyFlag } from './command-options.js';

// Single resume-precedence table. For each resume-relevant field, records when
// `next` (this invocation) should win over `stored` (the resumed run):
//   - 'always-next': unconditionally — fields tied to this invocation only
//                    (e.g. `json`, `resume`).
//   - 'flag-present': when any of the option's CLI flags is explicit.
//   - 'provider': flag-present, OR stored.providers is missing/empty.
// Built once from the schema's `resumeOverrideFields` so resume precedence
// lives entirely in `command-option-schema.js`.
const PROVIDER_FALLBACK_FIELDS = new Set(PROVIDER_RESUME_FIELDS);

/**
 * @typedef {{ kind: 'always-next' } | { kind: 'flag-present' | 'provider', flags: ReadonlyArray<string> }} ResumeFieldRule
 */

export const RESUME_FIELD_RULES = Object.freeze(buildResumeFieldRules());

/**
 * @returns {Record<string, ResumeFieldRule>}
 */
function buildResumeFieldRules() {
  const flagsByField = new Map();
  const alwaysNext = new Set();
  for (const option of COMMAND_OPTIONS) {
    if (!option.resumeOverrideFields.length) continue;
    if (option.resumeAlwaysOverrides) {
      for (const field of option.resumeOverrideFields) alwaysNext.add(field);
      continue;
    }
    const optionFlags = [option.name, ...option.aliases];
    for (const field of option.resumeOverrideFields) {
      flagsByField.set(field, [...(flagsByField.get(field) || []), ...optionFlags]);
    }
  }
  /** @type {Record<string, ResumeFieldRule>} */
  const rules = {};
  for (const field of alwaysNext) rules[field] = Object.freeze({ kind: 'always-next' });
  for (const [field, fieldFlags] of flagsByField) {
    if (rules[field]) continue;
    rules[field] = Object.freeze({
      kind: PROVIDER_FALLBACK_FIELDS.has(field) ? 'provider' : 'flag-present',
      flags: Object.freeze([...new Set(fieldFlags)]),
    });
  }
  return rules;
}

// Resume merge: start from stored-if-present-else-next, then for each rule in
// RESUME_FIELD_RULES whose predicate fires, force the field to next.
export function mergeResumeOptions(storedOptions, nextOptions, flags) {
  const stored = storedOptions && typeof storedOptions === 'object' ? storedOptions : {};
  const useStored = new Map();
  for (const field of new Set([...Object.keys(stored), ...Object.keys(nextOptions)])) {
    useStored.set(field, Object.hasOwn(stored, field));
  }
  for (const [field, rule] of Object.entries(RESUME_FIELD_RULES)) {
    if (resumeRuleSelectsNext(rule, flags, stored)) useStored.set(field, false);
  }
  const merged = {};
  for (const [field, fromStored] of useStored) {
    merged[field] = fromStored ? stored[field] : nextOptions[field];
  }
  return merged;
}

function resumeRuleSelectsNext(rule, flags, stored) {
  if (rule.kind === 'always-next') return true;
  if (hasAnyFlag(flags, rule.flags)) return true;
  return rule.kind === 'provider'
    && (!Array.isArray(stored.providers) || stored.providers.length === 0);
}
