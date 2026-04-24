import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '..', 'src');
const DEPENDENCY_DIRECTION_RULES = Object.freeze([
  {
    name: 'command entrypoints remain top-level modules',
    from: /^.+\.js$/,
    forbidden: /^(?:cli|review|quality|rooms|runs|init|doctor)\.js$/,
  },
  {
    name: 'provider modules stay below command, cycle, and implementation layers',
    from: /^(?:provider-|providers\.js|mock-provider\.js)/,
    forbidden: /^(?:cli|review|quality|rooms|runs|init|doctor|assessment-|cycle-|implementation(?:\.js|-)|task-|run-state\.js|run-store\.js)/,
  },
  {
    name: 'prompt modules do not depend on execution or command layers',
    from: /^(?:assessment-prompts|implementation-prompts|repo-context-prompt|prompt-intent|summary-contract)\.js$/,
    forbidden: /^(?:args|cli|command-|config|providers?\.js|provider-|process-runner|workflow(?:\.js|-)|cycle-|assessment-(?:command|cycle|fanout)|implementation(?:\.js|-)|review|quality|rooms|runs|doctor|init)\.js/,
  },
  {
    name: 'foundation utilities stay below application layers',
    from: /^(?:errors|objects|output-string|safe-path|workflow-constants)\.js$/,
    forbidden: /^(?:args|cli|command-|config|provider|providers|assessment|cycle|implementation|review|quality|rooms|runs|run-|git|workflow|doctor|init|task-)/,
  },
]);

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  }).sort((a, b) => a.localeCompare(b));
}

function resolveSourceImport(fromFile, specifier, sourceFiles) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    resolved,
    `${resolved}.js`,
    path.join(resolved, 'index.js'),
  ];

  return candidates.find((candidate) => sourceFiles.has(candidate)) || null;
}

function sourceImportSpecifiers(file) {
  const source = fs.readFileSync(file, 'utf8');
  const patterns = [
    /\b(?:import|export)\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];

  return patterns.flatMap((pattern) => (
    [...source.matchAll(pattern)].map((match) => match[1])
  ));
}

function namedImportNames(file, specifier) {
  const source = fs.readFileSync(file, 'utf8');
  const names = [];
  for (const match of source.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (match[2] !== specifier) continue;
    names.push(...match[1]
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/i)[0].trim())
      .filter(Boolean));
  }
  return names;
}

function buildImportGraph(files) {
  const sourceFiles = new Set(files);
  return new Map(files.map((file) => [
    file,
    [...new Set(sourceImportSpecifiers(file)
      .map((specifier) => resolveSourceImport(file, specifier, sourceFiles))
      .filter(Boolean))],
  ]));
}

function canonicalCycleKey(cycle) {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => [
    ...nodes.slice(index),
    ...nodes.slice(0, index),
  ].join('\0'));
  return rotations.sort()[0];
}

function findImportCycles(graph) {
  const cycles = [];
  const seenCycles = new Set();
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file];
      const key = canonicalCycleKey(cycle);
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(file)) return;

    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) {
      visit(dependency);
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of graph.keys()) {
    visit(file);
  }
  return cycles;
}

function relativeSourcePath(file) {
  return path.relative(SRC_ROOT, file);
}

function normalizedRelativeSourcePath(file) {
  return relativeSourcePath(file).replaceAll(path.sep, '/');
}

function matchesRule(pattern, file) {
  return pattern.test(normalizedRelativeSourcePath(file));
}

function collectForbiddenDependencyPaths(graph, sourceFile, forbiddenPattern) {
  const violations = [];
  const stack = [[sourceFile, [sourceFile]]];
  const visited = new Set([sourceFile]);

  while (stack.length > 0) {
    const [file, importPath] = stack.pop();
    for (const dependency of graph.get(file) || []) {
      if (visited.has(dependency)) continue;

      const nextPath = [...importPath, dependency];
      visited.add(dependency);
      if (matchesRule(forbiddenPattern, dependency)) {
        violations.push(nextPath);
        continue;
      }
      stack.push([dependency, nextPath]);
    }
  }

  return violations;
}

function dependencyDirectionViolations(graph) {
  return DEPENDENCY_DIRECTION_RULES.flatMap((rule) => (
    [...graph.keys()]
      .filter((file) => matchesRule(rule.from, file))
      .flatMap((file) => collectForbiddenDependencyPaths(graph, file, rule.forbidden)
        .map((importPath) => `${rule.name}: ${importPath.map(normalizedRelativeSourcePath).join(' -> ')}`))
  )).sort((a, b) => a.localeCompare(b));
}

function sourceFile(relativePath) {
  return path.join(SRC_ROOT, relativePath);
}

function forbiddenProviderInvocationImports({
  files = listJsFiles(SRC_ROOT),
  readNamedImportNames = namedImportNames,
} = {}) {
  const forbiddenNames = new Set(['buildSpawnTarget', 'getProviderAdapter', 'providerAdapters']);
  return files
    .filter((file) => normalizedRelativeSourcePath(file) !== 'provider-invocation.js')
    .flatMap((file) => readNamedImportNames(file, './provider-invocation.js')
      .filter((name) => forbiddenNames.has(name))
      .map((name) => `${normalizedRelativeSourcePath(file)} imports ${name} from provider-invocation.js`))
    .sort((a, b) => a.localeCompare(b));
}

test('src imports do not contain dependency cycles', () => {
  const graph = buildImportGraph(listJsFiles(SRC_ROOT));
  const cycles = findImportCycles(graph).map((cycle) => (
    cycle.map(relativeSourcePath).join(' -> ')
  ));

  assert.deepEqual(cycles, [], `src import cycles:\n${cycles.join('\n')}`);
});

test('src imports follow dependency-direction rules', () => {
  const graph = buildImportGraph(listJsFiles(SRC_ROOT));
  const violations = dependencyDirectionViolations(graph);

  assert.deepEqual(violations, [], `src dependency-direction violations:\n${violations.join('\n')}`);
});

test('src has no forbidden provider-invocation imports', () => {
  assert.deepEqual(forbiddenProviderInvocationImports(), [], 'forbidden provider-invocation imports detected');
});

test('provider dependency-direction rule reports upward imports', () => {
  const graph = new Map([
    [sourceFile('provider-output.js'), [sourceFile('cycle-state.js')]],
    [sourceFile('cycle-state.js'), []],
  ]);

  assert.deepEqual(dependencyDirectionViolations(graph), [
    'provider modules stay below command, cycle, and implementation layers: provider-output.js -> cycle-state.js',
  ]);
});

test('provider invocation import detector reports forbidden compatibility imports', () => {
  const violatingFile = sourceFile('providers.js');
  const cleanFile = sourceFile('provider-output.js');
  const importsByFile = new Map([
    [violatingFile, ['buildProviderInvocation', 'buildSpawnTarget', 'providerAdapters']],
    [cleanFile, ['extractProviderText']],
  ]);

  assert.deepEqual(
    forbiddenProviderInvocationImports({
      files: [cleanFile, violatingFile],
      readNamedImportNames: (file, specifier) => {
        assert.equal(specifier, './provider-invocation.js');
        return importsByFile.get(file) || [];
      },
    }),
    [
      'providers.js imports buildSpawnTarget from provider-invocation.js',
      'providers.js imports providerAdapters from provider-invocation.js',
    ],
  );
});
