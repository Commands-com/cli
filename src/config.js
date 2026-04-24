import fs from 'node:fs/promises';
import path from 'node:path';
import { readCommandOptionValue } from './command-options.js';
import { UsageError } from './errors.js';

const LOCAL_DIR = '.commands-com';
const CONFIG_FILE = 'config.json';

function localStatePath(cwd, ...segments) {
  return path.join(cwd, LOCAL_DIR, ...segments);
}

export function localRunsPath(cwd, ...segments) {
  return localStatePath(cwd, 'runs', ...segments);
}

export function localWorktreesPath(cwd, ...segments) {
  return localStatePath(cwd, 'worktrees', ...segments);
}

export function hasLocalStatePathSegment(filePath) {
  return String(filePath || '').split(/[\\/]+/).includes(LOCAL_DIR);
}

function configPath(cwd) {
  return localStatePath(cwd, CONFIG_FILE);
}

export async function loadConfig(cwd) {
  const filePath = configPath(cwd);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new UsageError(`invalid config JSON at ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function saveConfig(cwd, config) {
  const filePath = configPath(cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function resolveRuntimeOptions(cwd, flags) {
  const config = await loadConfig(cwd);
  const providers = readCommandOptionValue(flags, 'providers', '')
    || process.env.COMMANDS_COM_PROVIDERS
    || config.providers
    || '';
  const provider = readCommandOptionValue(flags, 'provider', '')
    || process.env.COMMANDS_COM_PROVIDER
    || config.provider
    || 'auto';
  const model = readCommandOptionValue(flags, 'model', '')
    || process.env.COMMANDS_COM_MODEL
    || config.model
    || '';
  return { config, provider, providers, model };
}

export async function initConfig(cwd, nextConfig) {
  const current = await loadConfig(cwd);
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(nextConfig).filter(([, value]) => value !== undefined && value !== '')),
  };
  const filePath = await saveConfig(cwd, merged);
  return { filePath, config: merged };
}
