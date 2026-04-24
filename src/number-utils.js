export function normalizeFiniteNonNegativeNumber(value) {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

export function normalizeIssueCount(value) {
  return normalizeFiniteNonNegativeNumber(Number(value));
}
