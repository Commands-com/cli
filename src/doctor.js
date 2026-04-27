import { detectProviders, resolveProviders, runProvider } from './providers.js';
import { loadConfig, resolveRuntimeOptions } from './config.js';
import { getRepoRoot } from './git.js';
import { commandResult } from './command-result.js';
import { readCommandOptionValue } from './command-options.js';
import { PROVIDER_PING_MARKER } from './mock-provider.js';

const PING_PROMPT = [
  'Commands.com provider health check.',
  `Reply with one short sentence that includes the exact text: ${PROVIDER_PING_MARKER}`,
  'Do not edit files. Do not use tools.',
].join('\n');

function doctorProviderRequest(flags) {
  return readCommandOptionValue(flags, 'providers', '')
    || readCommandOptionValue(flags, 'provider', '')
    || 'all';
}

/**
 * @param {Array<{id: string, path?: string}>} providers
 * @param {{cwd?: string, model?: string, timeoutMs?: number}} [options]
 */
async function pingProviders(providers, { cwd, model = '', timeoutMs = 60_000 } = {}) {
  return Promise.all(providers.map(async (provider) => {
    const started = Date.now();
    try {
      const result = await runProvider(provider, {
        cwd,
        prompt: PING_PROMPT,
        model,
        allowTools: false,
        timeoutMs,
        maxOutputBytes: 128 * 1024,
      });
      const text = String(result.text ?? '').trim();
      return {
        id: provider.id,
        path: provider.path || '',
        ok: text.includes(PROVIDER_PING_MARKER),
        latencyMs: Date.now() - started,
        text: text.slice(0, 500),
      };
    } catch (error) {
      return {
        id: provider.id,
        path: provider.path || '',
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

/**
 * @param {{flags: any}} parsed
 * @param {{cwd?: string, logger?: any}} [context]
 */
export async function runDoctorCommand(parsed, { cwd = process.cwd(), logger } = {}) {
  if (!logger) {
    throw new Error('runDoctorCommand requires logger');
  }
  const providers = await detectProviders();
  const config = await loadConfig(cwd);
  const runtimeOptions = await resolveRuntimeOptions(cwd, parsed.flags);
  const repoRoot = await getRepoRoot(cwd);
  const rows = providers.map((provider) => ({
    id: provider.id,
    available: provider.available,
    path: provider.path || '',
  }));
  let pings = null;
  if (readCommandOptionValue(parsed.flags, 'ping', false)) {
    const timeoutMs = readCommandOptionValue(parsed.flags, 'timeout-ms', 60_000);
    const pingTargets = await resolveProviders(doctorProviderRequest(parsed.flags));
    pings = await pingProviders(pingTargets, {
      cwd: repoRoot || cwd,
      model: runtimeOptions.model,
      timeoutMs,
    });
  }

  if (logger.jsonMode) {
    logger.json({
      type: 'doctor',
      node: process.version,
      repoRoot,
      config,
      providers: rows,
      ...(pings ? { pings } : {}),
    });
    return commandResult();
  }

  logger.line(`Node: ${process.version}`);
  logger.line(`Repository: ${repoRoot || 'not a git repository'}`);
  if (config.providers || config.provider || config.model) {
    logger.line([
      `Config: providers=${config.providers || '(review default)'}`,
      `provider=${config.provider || 'auto'}`,
      `model=${config.model || '(default)'}`,
    ].join(' '));
  }
  logger.line('Env: COMMANDS_COM_PROVIDERS, COMMANDS_COM_PROVIDER, and COMMANDS_COM_MODEL are supported overrides.');
  logger.line('');
  logger.line('Provider CLIs');
  for (const row of rows) {
    const status = row.available ? 'found' : 'missing';
    const suffix = row.path ? ` at ${row.path}` : '';
    logger.line(`- ${row.id}: ${status}${suffix}`);
  }
  if (pings) {
    logger.line('');
    logger.line('Provider Responses');
    for (const ping of pings) {
      const status = ping.ok ? 'ok' : 'failed';
      const detail = ping.ok ? ` - ${ping.text}` : ` - ${ping.error || ping.text || 'no response'}`;
      logger.line(`- ${ping.id}: ${status} (${ping.latencyMs}ms)${detail}`);
    }
  }
  return commandResult();
}
