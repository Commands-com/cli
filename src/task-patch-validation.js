import path from 'node:path';
import { hasLocalStatePathSegment } from './config.js';

export function normalizeGitPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function normalizeAssignedScope(filePath) {
  const raw = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const normalized = normalizeGitPath(raw);
  if (!normalized) return '';
  return raw.endsWith('/') ? `${normalized}/` : normalized;
}

function assignedScopeAllowsFile(scope, file) {
  return scope.endsWith('/') ? file.startsWith(scope) : file === scope;
}

function isOutsideTaskScope(file) {
  return file === '..'
    || file.startsWith('../')
    || file.includes('/../')
    || path.posix.isAbsolute(file)
    || /^[A-Za-z]:\//.test(file);
}

/** @param {{ label?: string, files?: Array<string>, assignedFiles?: Array<string> }} [args] */
export function validatePatchFiles({ label = 'patch', files, assignedFiles } = {}) {
  const changedFiles = Array.isArray(files)
    ? files.map((file) => normalizeGitPath(file)).filter(Boolean)
    : [];
  const errors = [];
  const outsideScopeFiles = new Set();
  for (const file of changedFiles) {
    if (isOutsideTaskScope(file)) {
      errors.push(`${label} changed file outside assigned scope: ${file}`);
      outsideScopeFiles.add(file);
      continue;
    }
    if (hasLocalStatePathSegment(file)) {
      errors.push(`${label} changed CLI-owned artifact path: ${file}`);
    }
  }

  const assigned = Array.isArray(assignedFiles)
    ? assignedFiles.map((file) => normalizeAssignedScope(file)).filter(Boolean)
    : [];
  if (assigned.length) {
    for (const file of changedFiles) {
      if (outsideScopeFiles.has(file)) continue;
      if (!assigned.some((scope) => assignedScopeAllowsFile(scope, file))) {
        errors.push(`${label} changed unassigned file: ${file}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateTaskPatch({ task, files }) {
  return validatePatchFiles({ label: `task ${task?.id || 'unknown'}`, files, assignedFiles: task?.files });
}
