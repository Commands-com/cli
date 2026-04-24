const MAX_PATH_SEGMENT_LENGTH = 80;
const DEFAULT_PATH_SEGMENT = 'item';

/**
 * Shared path segment normalizer for artifact and worktree names.
 *
 * This intentionally stays narrow: callers that need filename extension
 * preservation should use their own filename-specific normalizer.
 */
export function safePathSegment(value, fallback = DEFAULT_PATH_SEGMENT) {
  const segment = sanitizePathSegment(value) || sanitizePathSegment(fallback) || DEFAULT_PATH_SEGMENT;
  return segment.slice(0, MAX_PATH_SEGMENT_LENGTH).replace(/^-+|-+$/g, '') || DEFAULT_PATH_SEGMENT;
}

// Non-file path segments collapse dots like any other punctuation. Artifact
// filename segments use a separate normalizer so extensions can be preserved.
function sanitizePathSegment(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
