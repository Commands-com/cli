import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  artifactPath,
  markdownArtifactPath,
} from './artifact-paths.js';
import { collectRepoContext } from './git.js';
import { localRunsPath } from './config.js';
import { formatRepoContext } from './repo-context-prompt.js';
import { slug, timestamp } from './run-id.js';
import { UsageError } from './errors.js';

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-f0-9]{6}$/;

/**
 * Free-form metadata persisted next to a run. Adapter callers attach
 * provider/options details (objective, reviewers, areas, providers, model,
 * ...). The dict is typed as open-ended `any` because contents vary by
 * adapter and are read defensively at consumer callsites.
 *
 * @typedef {Record<string, any>} RunMetadata
 */

/**
 * Result returned by `readRunMetadata` — like `RunJsonResult` but with the
 * value statically narrowed to `RunMetadata` so callers can read provider
 * and option fields without an explicit cast.
 *
 * @typedef {{ dir: string, runId: string, value: RunMetadata }} RunMetadataResult
 */

/**
 * Artifact store backing a single run. `write` resolves filesystem-safe paths
 * inside the run directory and returns the absolute path written to.
 *
 * @typedef {Object} RunStore
 * @property {string} runId Run identifier (also the directory basename).
 * @property {string} dir Absolute directory containing run artifacts.
 * @property {(name: string, content: string) => Promise<string>} write Write a UTF-8 file inside the run directory.
 * @property {(name: string, value: unknown) => Promise<string>} writeJson JSON-encode and write a file inside the run directory.
 */

/**
 * Result returned by `readRunJson` — the resolved run directory plus the
 * parsed JSON value at `fileName`.
 *
 * @typedef {Object} RunJsonResult
 * @property {string} dir Absolute run directory.
 * @property {string} runId Basename of the run directory.
 * @property {unknown} value Parsed JSON contents.
 */

/**
 * Symmetric metadata shape returned by `readRunMetadataStatus`. `metadata` is
 * `null` only when metadata.json is absent or unparseable.
 *
 * @typedef {Object} RunMetadataStatus
 * @property {RunMetadata | null} metadata Parsed metadata when readable.
 * @property {string | null} metadataError Human-readable read/parse error.
 */

/**
 * Row entry produced by `readRunRows` — one record per run directory.
 *
 * @typedef {Object} RunRow
 * @property {string} runId Run identifier.
 * @property {string} dir Absolute run directory path.
 * @property {RunMetadata | null} metadata Parsed metadata when readable.
 * @property {string | null} metadataError Human-readable read/parse error.
 * @property {number} mtimeMs Last-modified time in ms (used as an order tiebreaker).
 */

/**
 * Result returned by `prepareRun`. `context` is `null` when the caller passes
 * `collectContext: false` and takes responsibility for collecting context
 * itself (worktree workflows do this against the worktree path).
 *
 * @typedef {Object} PreparedRun
 * @property {RunStore} store Artifact store for this run.
 * @property {import('./git.js').RepoContext | null} context Repository context captured at run start, or `null` when context capture was opted out.
 */

/**
 * @param {string} cwd
 * @returns {string}
 */
export function runStoreRoot(cwd) {
  return localRunsPath(cwd);
}

/**
 * @param {string} cwd
 * @param {string} kind
 * @param {string} label
 * @returns {Promise<RunStore>}
 */
async function createRunStore(cwd, kind, label) {
  const runId = `${timestamp()}-${kind}-${slug(label)}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(runStoreRoot(cwd), runId);
  await fs.mkdir(dir, { recursive: true });

  return openRunStore(dir, runId);
}

/**
 * @param {string} dir
 * @param {string} [runId]
 * @returns {RunStore}
 */
export function openRunStore(dir, runId = path.basename(dir)) {
  return {
    runId,
    dir,
    async write(name, content) {
      const root = path.resolve(dir);
      const filePath = path.resolve(dir, name);
      if (filePath === root) {
        throw new Error(`refusing to write run directory itself: ${name}`);
      }
      if (!filePath.startsWith(`${root}${path.sep}`)) {
        throw new Error(`refusing to write outside run directory: ${name}`);
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(content ?? ''), 'utf8');
      return filePath;
    },
    async writeJson(name, value) {
      return this.write(name, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/**
 * @param {string} cwd
 * @param {string} runRef
 * @param {string} fileName
 * @returns {Promise<RunJsonResult>}
 */
export async function readRunJson(cwd, runRef, fileName) {
  const dir = await resolveRunDir(cwd, runRef);
  const filePath = path.join(dir, fileName);
  try {
    return {
      dir,
      runId: path.basename(dir),
      value: JSON.parse(await fs.readFile(filePath, 'utf8')),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new UsageError(`run artifact not found: ${path.join(path.basename(dir), fileName)}`);
    }
    if (error instanceof SyntaxError) {
      throw new UsageError(`invalid run artifact JSON at ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * @param {string} cwd
 * @param {string} runRef
 * @returns {Promise<RunMetadataResult>}
 */
export async function readRunMetadata(cwd, runRef) {
  return /** @type {Promise<RunMetadataResult>} */ (readRunJson(cwd, runRef, 'metadata.json'));
}

/**
 * @param {string} cwd
 * @param {string} runRef
 * @returns {Promise<string>}
 */
export async function resolveRunDir(cwd, runRef) {
  const ref = String(runRef || '').trim();
  if (!ref) {
    throw new UsageError('run id is required');
  }
  if (ref === 'latest') return latestRunDir(cwd);

  if (ref.includes('/') || ref.includes('\\')) {
    const dir = path.resolve(cwd, ref);
    await assertRunDirectory(dir, ref);
    return dir;
  }

  if (!RUN_ID_PATTERN.test(ref)) {
    throw new UsageError(`run not found: ${ref}`);
  }
  const dir = path.join(runStoreRoot(cwd), ref);
  await assertRunDirectory(dir, ref);
  return dir;
}

async function latestRunDir(cwd) {
  const rows = await readRunRows(cwd);
  if (!rows.length) throw new UsageError('run not found: latest');
  return rows[0].dir;
}

function describeMetadataError(error) {
  const code = error?.code || error?.name || 'Error';
  const message = error?.message || String(error);
  return `${code}: ${message}`;
}

// Symmetric metadata read used by listRuns, showRun, and the shared run-row reader.
// metadata is null when metadata.json is absent (ENOENT) and metadataError stays null.
// metadataError is set only when metadata.json exists but cannot be read or parsed.
/**
 * @param {string} dir
 * @returns {Promise<RunMetadataStatus>}
 */
export async function readRunMetadataStatus(dir) {
  try {
    const text = await fs.readFile(path.join(dir, 'metadata.json'), 'utf8');
    return { metadata: JSON.parse(text), metadataError: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { metadata: null, metadataError: null };
    return { metadata: null, metadataError: describeMetadataError(error) };
  }
}

async function readRunDirMtime(dir) {
  try {
    const stats = await fs.stat(dir);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

function parseRunCreatedAt(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Run IDs only timestamp to seconds, so two runs created in the same second tie
// on ID. Order primarily by metadata.createdAt (ms-precision), fall back to dir
// mtimeMs, and use the run ID string only as a final tie-breaker.
function compareRunRows(a, b) {
  const aTime = parseRunCreatedAt(a.metadata?.createdAt);
  const bTime = parseRunCreatedAt(b.metadata?.createdAt);
  if (aTime !== null && bTime !== null) {
    if (aTime !== bTime) return bTime - aTime;
  } else if (aTime !== null) {
    return -1;
  } else if (bTime !== null) {
    return 1;
  }
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return b.runId.localeCompare(a.runId);
}

/**
 * @param {string} cwd
 * @returns {Promise<Array<RunRow>>}
 */
export async function readRunRows(cwd) {
  let entries = [];
  try {
    entries = await fs.readdir(runStoreRoot(cwd), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const dir = path.join(runStoreRoot(cwd), entry.name);
    const [{ metadata, metadataError }, mtimeMs] = await Promise.all([
      readRunMetadataStatus(dir),
      readRunDirMtime(dir),
    ]);
    rows.push({ runId: entry.name, dir, metadata, metadataError, mtimeMs });
  }

  rows.sort(compareRunRows);
  return rows;
}

async function assertRunDirectory(dir, displayRef) {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  throw new UsageError(`run not found: ${displayRef}`);
}

/**
 * @param {string} cwd
 * @param {{
 *   kind: string,
 *   label: string,
 *   changed?: boolean,
 *   metadata?: RunMetadata,
 *   writeSetupArtifacts?: boolean,
 *   collectContext?: boolean,
 * }} options
 * @returns {Promise<PreparedRun>}
 */
export async function prepareRun(cwd, {
  kind,
  label,
  changed = false,
  metadata = {},
  writeSetupArtifacts = true,
  collectContext = true,
}) {
  if (typeof kind !== 'string' || kind.trim() === '') {
    throw new Error('prepareRun: kind must be a non-empty string');
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('prepareRun: label must be a non-empty string');
  }
  if (writeSetupArtifacts && !collectContext) {
    throw new Error('prepareRun: writeSetupArtifacts requires collectContext');
  }
  const store = await createRunStore(cwd, kind, label);
  const context = collectContext ? await collectRepoContext(cwd, { changed }) : null;
  if (writeSetupArtifacts && context) {
    await writeRunSetupArtifacts(store, context, metadata);
  }
  return { store, context };
}

/**
 * @param {RunStore} store
 * @param {import('./git.js').RepoContext} context
 * @param {RunMetadata} [metadata]
 * @returns {Promise<void>}
 */
export async function writeRunSetupArtifacts(store, context, metadata = {}) {
  await store.write(markdownArtifactPath('context'), formatRepoContext(context));
  await store.writeJson(artifactPath('metadata.json'), {
    ...metadata,
    createdAt: new Date().toISOString(),
  });
}
