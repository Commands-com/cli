import fs from 'node:fs/promises';
import path from 'node:path';
import { commandResult } from './command-result.js';
import { positiveIntegerOption } from './command-options.js';
import { UsageError } from './errors.js';
import {
  RUN_ID_PATTERN,
  readRunMetadataStatus,
  readRunRows,
  runStoreRoot,
} from './run-store.js';

async function listRuns(cwd, { limit = 20 } = {}) {
  const rows = await readRunRows(cwd);
  return rows.slice(0, limit).map(({ runId, dir, metadata, metadataError }) => {
    const row = {
      runId,
      dir,
      kind: metadata?.kind || '',
      objective: metadata?.objective || '',
      provider: metadata?.provider || '',
      createdAt: metadata?.createdAt || '',
    };
    if (metadataError) row.metadataError = metadataError;
    return row;
  });
}

async function showRun(cwd, runId) {
  const safeRunId = String(runId || '').trim();
  if (!safeRunId || safeRunId.includes('/') || safeRunId.includes('\\')) {
    throw new UsageError('run id is required');
  }
  if (!RUN_ID_PATTERN.test(safeRunId)) {
    throw new UsageError(`run not found: ${safeRunId}`);
  }
  const dir = path.join(runStoreRoot(cwd), safeRunId);
  let files;
  try {
    files = await fs.readdir(dir, { recursive: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new UsageError(`run not found: ${safeRunId}`);
    }
    throw error;
  }
  // Symmetric with listRuns: a run dir with no metadata.json renders as an
  // empty-metadata record rather than a `run not found` rejection.
  const { metadata, metadataError } = await readRunMetadataStatus(dir);
  const run = {
    runId: safeRunId,
    dir,
    metadata,
    files: files
      .filter((file) => typeof file === 'string')
      .map(portablePath)
      .sort(),
  };
  if (metadataError) run.metadataError = metadataError;
  return run;
}

function portablePath(file) {
  return file.split(path.sep).join('/');
}

export async function runRunsCommand(parsed, { cwd, logger }) {
  if (!logger) {
    throw new Error('runRunsCommand requires logger');
  }
  const subcommand = parsed.positionals[0] || 'list';

  if (subcommand === 'list') {
    const runs = await listRuns(cwd, {
      limit: positiveIntegerOption(parsed.flags, 'limit', 20),
    });
    printRunList(logger, runs);
    return commandResult();
  }

  if (subcommand === 'show') {
    const run = await showRun(cwd, parsed.positionals[1]);
    printRunShow(logger, run);
    return commandResult();
  }

  throw new UsageError(`unknown runs subcommand: ${subcommand}`);
}

function printRunList(logger, runs) {
  if (logger.jsonMode) {
    logger.json({ type: 'runs.list', runs });
    return;
  }
  if (runs.length === 0) {
    logger.line('No commands-com runs found.');
    return;
  }
  for (const run of runs) {
    if (run.metadataError) {
      logger.line(`${run.runId}  [metadata error: ${run.metadataError}]`);
      continue;
    }
    const parts = [run.runId, run.kind, run.provider, run.objective].filter(Boolean);
    logger.line(parts.join('  '));
  }
}

function printRunShow(logger, run) {
  if (logger.jsonMode) {
    logger.json({ type: 'runs.show', run });
    return;
  }
  logger.line(`Run: ${run.runId}`);
  logger.line(`Path: ${run.dir}`);
  if (run.metadataError) logger.line(`metadata error: ${run.metadataError}`);
  else if (!run.metadata) logger.line('metadata not found');
  logger.line(`Kind: ${run.metadata?.kind || 'unknown'}`);
  if (run.metadata?.objective) logger.line(`Objective: ${run.metadata.objective}`);
  logger.line('Files:');
  for (const file of run.files) logger.line(`- ${file}`);
}
