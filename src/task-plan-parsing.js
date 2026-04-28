import { hasLocalStatePathSegment } from './config.js';
import { safePathSegment } from './safe-path.js';

const DEFAULT_MAX_TASKS = 6;
const TASK_ID_SEGMENT_MAX = 80;

function jsonBlock(text) {
  const source = String(text || '');
  const fenced = source.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (fenced) return fenced[1];
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start !== -1 && end > start ? source.slice(start, end + 1) : '';
}

function normalizeFilePath(file) {
  const raw = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  const normalized = raw.endsWith('/') ? raw.replace(/\/+$/g, '/') : raw.replace(/\/+$/g, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || parts.includes('..')) return '';
  if (hasLocalStatePathSegment(normalized)) return '';
  return normalized;
}

function normalizeFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of Array.isArray(files) ? files : []) {
    const normalized = normalizeFilePath(file);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function instructionFileRefs(text) {
  const refs = [];
  const source = String(text || '');
  const pathPattern = /(?:\.\/)?(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\/)?|[A-Za-z0-9._-]+\.(?:json|yaml|cjs|jsx|mjs|tsx|txt|yml|js|md|ts))(?:\:\d+)?/g;
  for (const match of source.matchAll(pathPattern)) {
    const previous = match.index > 0 ? source[match.index - 1] : '';
    if (previous === '/' || previous === '.') continue;
    const normalized = normalizeFilePath(match[0].replace(/\:\d+$/, '').replace(/[.,;:)]+$/g, ''));
    if (normalized) refs.push(normalized);
  }
  return refs;
}

function fallbackPlan(instructions = '') {
  // The only plan-level fallback: use one broad task when provider output is
  // malformed or contains no tasks to schedule.
  return [{
    id: 'task-1',
    title: 'Implement synthesized findings',
    files: [],
    instructions: String(instructions || 'Fix the synthesized findings.').trim(),
    order: 1,
  }];
}

function rawPlanTasks(text) {
  try {
    const parsed = JSON.parse(jsonBlock(text));
    return Array.isArray(parsed?.tasks) ? parsed.tasks : null;
  } catch {
    return null;
  }
}

function normalizeMaxTasks(maxTasks = DEFAULT_MAX_TASKS) {
  const value = Number(maxTasks);
  if (!Number.isFinite(value)) return DEFAULT_MAX_TASKS;
  return Math.max(1, Math.floor(value));
}

function normalizeTask(task, index) {
  const fallbackId = `task-${index + 1}`;
  const id = safePathSegment(task?.id ?? fallbackId, fallbackId);
  const title = String(task?.title ?? id).trim() || id;
  const instructions = String(task?.instructions ?? title).trim() || title;
  return {
    id,
    title,
    files: normalizeFiles([
      ...(Array.isArray(task?.files) ? task.files : []),
      ...instructionFileRefs(instructions),
    ]),
    instructions,
    order: index + 1,
  };
}

function suffixedTaskId(id, suffix) {
  const suffixText = `-${suffix}`;
  const base = String(id || 'task').slice(0, TASK_ID_SEGMENT_MAX - suffixText.length).replace(/-+$/g, '');
  return safePathSegment(`${base || 'task'}${suffixText}`, `task-${suffix}`);
}

function dedupeTaskIds(tasks) {
  const seen = new Set();
  const counts = new Map();
  return tasks.map((task) => {
    const baseId = task.id;
    let count = (counts.get(baseId) || 0) + 1;
    let id = count === 1 ? baseId : suffixedTaskId(baseId, count);
    while (seen.has(id)) {
      count += 1;
      id = suffixedTaskId(baseId, count);
    }
    counts.set(baseId, count);
    seen.add(id);
    return id === task.id ? task : { ...task, id };
  });
}

export function parseImplementationPlan(text, { maxTasks = DEFAULT_MAX_TASKS, fallbackInstructions = '' } = {}) {
  const rawTasks = rawPlanTasks(text);
  if (!rawTasks) return fallbackPlan(fallbackInstructions);
  return dedupeTaskIds(rawTasks
    .slice(0, normalizeMaxTasks(maxTasks))
    .map(normalizeTask));
}

function ownershipOverlaps(left, right) {
  if (left === right) return true;
  if (left.endsWith('/') && right.startsWith(left)) return true;
  return right.endsWith('/') && left.startsWith(right);
}

function overlapsAny(task, batch) {
  if (!task.files.length) return true;
  return batch.some((existing) => {
    if (!existing.files.length) return true;
    return task.files.some((file) => existing.files.some((existingFile) => ownershipOverlaps(file, existingFile)));
  });
}

export function buildImplementationBatches(tasks, { maxParallel = 6, parallel = true } = {}) {
  const normalizedMax = Math.max(1, maxParallel);
  if (!parallel || normalizedMax <= 1) return tasks.map((task) => [task]);

  const batches = [];
  for (const task of tasks) {
    let placed = false;
    for (const batch of batches) {
      if (batch.length >= normalizedMax || overlapsAny(task, batch)) continue;
      batch.push(task);
      placed = true;
      break;
    }
    if (!placed) batches.push([task]);
  }
  return batches;
}
