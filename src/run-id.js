import { safePathSegment } from './safe-path.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function timestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function slug(value, maxLength = 48) {
  // safePathSegment already trims dashes after its 80-char cap, but slicing to
  // maxLength can re-introduce a leading or trailing '-' that would break
  // RUN_ID_PATTERN and produce ambiguous worktree paths. Re-trim and fall back
  // to the default segment so callers always get a pattern-valid segment.
  const trimmed = safePathSegment(value, 'run').slice(0, maxLength).replace(/^-+|-+$/g, '');
  return trimmed || 'run';
}
