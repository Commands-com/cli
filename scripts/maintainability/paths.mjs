import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export function collectUniqueJavaScriptFiles(roots, { repoRoot, excludedRoots = new Set() }) {
  return [...new Set(roots.flatMap((root) => findJavaScriptFiles(join(repoRoot, root), {
    repoRoot,
    excludedRoots,
  })))].sort();
}

export function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

export function assertExistingGuardRoots(name, roots, { repoRoot, required = false }) {
  const guardRoots = assertGuardRoots(name, roots, { required });
  return guardRoots.map((root) => {
    const rootPath = join(repoRoot, root);
    const stats = statSync(rootPath, { throwIfNoEntry: false });
    if (!stats || !stats.isDirectory()) {
      throw new Error(`jsconfig maintainabilityGuard.${name} entry must be an existing directory: ${root}`);
    }
    return root;
  });
}

export function assertGuardRoots(name, roots, { required = false } = {}) {
  if (!Array.isArray(roots) || (required && roots.length === 0)) {
    throw new Error(`jsconfig maintainabilityGuard.${name} ${required ? 'is required' : 'must be an array'}`);
  }
  return roots.map((root) => normalizeGuardRoot(name, root));
}

export function normalizeGuardRoot(name, root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error(`jsconfig maintainabilityGuard.${name} must contain non-empty strings`);
  }

  const trimmedRoot = root.trim();
  const normalized = normalizePath(trimmedRoot);
  if (
    normalized === ''
    || normalized === '.'
    || isAbsolute(trimmedRoot)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
  ) {
    throw new Error(`jsconfig maintainabilityGuard.${name} must contain repo-relative paths`);
  }
  return normalized;
}

function findJavaScriptFiles(dir, { repoRoot, excludedRoots }) {
  const relativeDir = normalizePath(relative(repoRoot, dir));
  if (isExcludedRoot(relativeDir, excludedRoots)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      return findJavaScriptFiles(file, { repoRoot, excludedRoots });
    }
    return file.endsWith('.js') ? [file] : [];
  });
}

function isExcludedRoot(relativeDir, excludedRoots) {
  return excludedRoots.has(relativeDir)
    || [...excludedRoots].some((root) => relativeDir.startsWith(`${root}/`));
}
