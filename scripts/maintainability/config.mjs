import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExistingGuardRoots,
  assertGuardRoots,
  collectUniqueJavaScriptFiles,
  normalizeGuardRoot,
  normalizePath,
} from './paths.mjs';

export const DEFAULT_REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const REQUIRED_COMPILER_OPTION_FLAGS = Object.freeze(['allowJs', 'checkJs', 'noEmit']);
export const GUARD_POLICIES = new Set(['off', 'warn', 'fail']);
export const DEFAULT_TEST_FILE_REPORT_LIMIT = 5;
export const DEFAULT_UNUSED_EXPORT_REPORT_LIMIT = 20;
export const UNUSED_EXPORT_REFERENCE_SEPARATOR = '#';

export {
  assertExistingGuardRoots,
  assertGuardRoots,
  collectUniqueJavaScriptFiles,
  normalizeGuardRoot,
  normalizePath,
};

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function assertCompilerOptionFlags(options, requiredFlags) {
  for (const key of requiredFlags) {
    if (options[key] !== true) {
      throw new Error(`jsconfig compilerOptions.${key} must stay true`);
    }
  }
}

export function unusedExportReference(file, exportName) {
  return `${normalizePath(file)}${UNUSED_EXPORT_REFERENCE_SEPARATOR}${exportName}`;
}

export function isJavaScriptIdentifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}
