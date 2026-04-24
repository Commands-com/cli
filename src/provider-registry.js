import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  adapterRunsDirectly,
  adapterSupportsPathLookup,
  getProviderAdapter,
  providerAdapters,
} from './provider-adapters.js';

function assertNoPathSeparators(normalized) {
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(`provider name must not contain path separators: '${normalized}'`);
  }
}

function registeredProviderAdapter(normalized) {
  const adapter = getProviderAdapter(normalized);
  if (!adapter) {
    throw new Error(`unsupported provider: ${normalized}`);
  }
  return adapter;
}

function assertProviderSelector(normalized) {
  assertNoPathSeparators(normalized);
  if (normalized === 'all' || normalized === 'auto') return;
  registeredProviderAdapter(normalized);
}

function executableProviderAdapters() {
  return providerAdapters().filter(adapterSupportsPathLookup);
}

function pathEntries() {
  const raw = process.env.PATH || process.env.Path || '';
  return raw.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

function commandNames(command) {
  if (process.platform !== 'win32') return [command];
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

async function findOnPath(command) {
  for (const dir of pathEntries()) {
    for (const name of commandNames(command)) {
      const candidate = path.join(dir, name);
      try {
        const st = await fs.stat(candidate);
        if (!st.isFile()) continue;
        // On POSIX require the executable bit so non-executable shadows on
        // PATH don't beat out the real CLI. On Windows X_OK collapses to
        // existence, but we already narrow to plausible extensions above.
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return '';
}

export async function detectProviders() {
  const rows = [];
  for (const adapter of providerAdapters()) {
    if (adapterRunsDirectly(adapter)) {
      rows.push({ id: adapter.id, available: true, path: adapter.path || 'built-in' });
      continue;
    }
    const found = await findOnPath(adapter.commandName);
    rows.push({ id: adapter.id, available: Boolean(found), path: found });
  }
  return rows;
}

export async function resolveProvider(requested = 'auto') {
  const normalized = String(requested || 'auto').trim().toLowerCase();
  if (normalized !== 'auto') {
    assertNoPathSeparators(normalized);
    const adapter = registeredProviderAdapter(normalized);
    if (adapterRunsDirectly(adapter)) {
      return { id: adapter.id, command: '', path: adapter.path || 'built-in' };
    }
    const found = await findOnPath(adapter.commandName);
    if (!found) {
      throw new Error(`provider '${normalized}' was not found on PATH`);
    }
    return { id: normalized, command: found, path: found };
  }

  for (const adapter of executableProviderAdapters()) {
    const found = await findOnPath(adapter.commandName);
    if (found) return { id: adapter.id, command: found, path: found };
  }

  throw new Error('no provider CLI found; install codex, claude, or gemini, or pass --provider mock');
}

export async function resolveProviders(requested = 'all') {
  const raw = String(requested || 'all').trim().toLowerCase();
  const names = raw.split(',').map((item) => item.trim()).filter(Boolean);
  const resolved = [];
  const seen = new Set();
  const resolvedSelectors = new Set();
  const push = (provider) => {
    if (seen.has(provider.id)) return;
    seen.add(provider.id);
    resolved.push(provider);
  };

  for (const name of names) {
    assertProviderSelector(name);
  }

  if (names.length === 0 || names.includes('all')) {
    for (const adapter of executableProviderAdapters()) {
      const found = await findOnPath(adapter.commandName);
      if (found) push({ id: adapter.id, command: found, path: found });
    }
  }

  for (const name of names) {
    if (name === 'all') continue;
    if (resolvedSelectors.has(name) || seen.has(name)) continue;
    resolvedSelectors.add(name);
    push(await resolveProvider(name));
  }

  if (resolved.length === 0) {
    throw new Error('no provider CLIs found; install codex, claude, or gemini, or pass --provider mock');
  }
  return resolved;
}
