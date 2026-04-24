import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  collectUniqueJavaScriptFiles,
  isJavaScriptIdentifier,
  normalizePath,
  unusedExportReference,
} from './config.mjs';

export function collectUnusedExports({
  repoRoot,
  exportRoots,
  consumerRoots,
  excludedRoots,
  allowlist,
}) {
  const exportFiles = collectUniqueJavaScriptFiles(exportRoots, { repoRoot, excludedRoots });
  const exportByFile = new Map(exportFiles.map((file) => [
    file,
    extractNamedExports(readFileSync(file, 'utf8')),
  ]));
  const usedExportsByFile = new Map(exportFiles.map((file) => [file, new Set()]));
  const consumerFiles = collectUniqueJavaScriptFiles(consumerRoots, { repoRoot, excludedRoots });
  const exportFileSet = new Set(exportFiles);

  for (const file of consumerFiles) {
    const text = readFileSync(file, 'utf8');
    for (const reference of extractStaticImportReferences(text)) {
      markUsedExports({
        importerFile: file,
        reference,
        exportByFile,
        exportFileSet,
        usedExportsByFile,
      });
    }
  }

  return exportFiles
    .flatMap((file) => {
      const usedExports = usedExportsByFile.get(file);
      return [...exportByFile.get(file)]
        .map((exportName) => {
          const relativeFile = normalizePath(relative(repoRoot, file));
          return {
            file,
            exportName,
            reference: unusedExportReference(relativeFile, exportName),
          };
        })
        .filter(({ exportName, reference }) => (
          !usedExports.has(exportName)
          && !allowlist.has(reference)
        ));
    })
    .sort(compareUnusedExportEntries);
}

export function writeUnusedExportFindings({
  unusedExports,
  policy,
  reportLimit,
  writeError,
}) {
  if (policy === 'off' || unusedExports.length === 0) {
    return;
  }

  const label = policy === 'fail' ? 'Error' : 'Warning';
  const reportedExports = unusedExports.slice(0, reportLimit);
  writeError(`${label}: unused exports detected (${reportedExports.length} of ${unusedExports.length} shown; policy: ${policy})`);
  for (const { reference } of reportedExports) {
    writeError(`  ${reference} is not imported by configured runtime consumers`);
  }
  const remainingCount = unusedExports.length - reportedExports.length;
  if (remainingCount > 0) {
    writeError(`  ... ${remainingCount} more unused exports not shown`);
  }
}

function markUsedExports({
  importerFile,
  reference,
  exportByFile,
  exportFileSet,
  usedExportsByFile,
}) {
  const targetFile = resolveRelativeJavaScriptModule(importerFile, reference.source, exportFileSet);
  if (!targetFile) {
    return;
  }

  const usedExports = usedExportsByFile.get(targetFile);
  if (!usedExports) {
    return;
  }

  const exportedNames = exportByFile.get(targetFile);
  if (reference.names === null) {
    for (const exportName of exportedNames) {
      usedExports.add(exportName);
    }
    return;
  }

  for (const name of reference.names) {
    if (exportedNames.has(name)) {
      usedExports.add(name);
    }
  }
}

function resolveRelativeJavaScriptModule(importerFile, source, exportFileSet) {
  if (!source.startsWith('.')) {
    return null;
  }

  const resolved = resolve(dirname(importerFile), source);
  const candidates = source.endsWith('.js')
    ? [resolved]
    : [`${resolved}.js`, join(resolved, 'index.js')];
  return candidates.find((candidate) => exportFileSet.has(candidate)) || null;
}

function extractNamedExports(text) {
  const names = new Set();
  const exportDeclarationPatterns = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ];

  for (const pattern of exportDeclarationPatterns) {
    for (const match of text.matchAll(pattern)) {
      names.add(match[1]);
    }
  }

  for (const match of text.matchAll(/\bexport\s*\{([\s\S]*?)\}(?:\s*from\s*['"][^'"]+['"])?\s*;?/g)) {
    for (const name of parseSpecifierNames(match[1], { exported: true })) {
      names.add(name);
    }
  }

  return names;
}

function extractStaticImportReferences(text) {
  const references = [];
  for (const match of text.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    references.push({
      source: match[2],
      names: parseSpecifierNames(match[1], { exported: false }),
    });
  }
  for (const match of text.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    references.push({
      source: match[2],
      names: parseSpecifierNames(match[1], { exported: false }),
    });
  }
  for (const match of text.matchAll(/\bimport\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s*['"]([^'"]+)['"]/g)) {
    references.push({
      source: match[1],
      names: null,
    });
  }
  for (const match of text.matchAll(/\blazyCommand\(\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Za-z_$][\w$]*)['"]\s*\)/g)) {
    references.push({
      source: match[1],
      names: [match[2]],
    });
  }
  return references;
}

function parseSpecifierNames(specifierBlock, { exported }) {
  return specifierBlock
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((specifier) => specifier.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((specifier) => {
      const [importedName, exportedName] = specifier.split(/\s+as\s+/i);
      return exported && exportedName ? exportedName.trim() : importedName.trim();
    })
    .filter((name) => isJavaScriptIdentifier(name));
}

function compareUnusedExportEntries(left, right) {
  return left.reference.localeCompare(right.reference);
}
