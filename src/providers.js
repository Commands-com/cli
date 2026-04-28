import { resolveProviderLimits } from './provider-limits.js';
import { adapterRunsDirectly, getProviderAdapter } from './provider-adapters.js';
import { buildProviderInvocation } from './provider-invocation.js';
import { buildSpawnTarget } from './provider-os-shell.js';
import {
  extractProviderSessionId,
  extractProviderText,
  providerFailureDetails,
} from './provider-output.js';
import { runProcess } from './process-runner.js';
import { runProviderWithRetry as runProviderWithRetryPolicy } from './provider-retry.js';

/**
 * Runtime provider facade used by workflow modules.
 *
 * Focused `provider-*` modules own helper behavior; this surface only exposes
 * provider resolution, retry classification, and execution.
 */
export { detectProviders, resolveProvider, resolveProviders } from './provider-registry.js';
export { isTransientProviderError } from './provider-retry.js';

export async function runProviderWithRetry(provider, options = {}) {
  return runProviderWithRetryPolicy(provider, options, runProvider);
}

/**
 * @typedef {import('./provider-invocation.js').RunProviderOptions} RunProviderOptions
 * @typedef {Error & { code?: string }} ProviderTimeoutError
 */

/**
 * @param {{id: string, command?: string}} provider
 * @param {RunProviderOptions} [options]
 *
 * Write-capable invocations (`options.allowTools`) pass `waitForCloseOnTimeout: true` to `runProcess`, so the worst-case latency on a timed-out call is `timeoutMs + PROCESS_KILL_GRACE_MS + PROCESS_FORCE_SETTLE_GRACE_MS` (SIGTERM, then the SIGKILL grace from `./provider-limits.js`, then the outer fail-safe from `./process-runner.js`).
 */
export async function runProvider(provider, options = {}) {
  const adapter = getProviderAdapter(provider.id);
  if (adapterRunsDirectly(adapter)) return adapter.run(provider, options);

  const invocation = buildProviderInvocation(provider, options);
  const { timeoutMs, maxOutputBytes } = resolveProviderLimits(options);
  const spawnTarget = buildSpawnTarget(invocation);
  const result = await runProcess({
    command: spawnTarget.command,
    args: spawnTarget.args,
    cwd: options.cwd,
    stdin: invocation.stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
    timeoutMs,
    maxOutputBytes,
    resolveOnTimeout: true,
    // Write-capable invocations may be editing the working tree; defer the
    // timeout settle until the child has actually exited so a retry/fallback
    // never overlaps with a still-running prior child.
    waitForCloseOnTimeout: Boolean(options.allowTools),
  });

  if (result.error) {
    throw result.error;
  }
  if (result.timedOut) {
    /** @type {ProviderTimeoutError} */
    const timeoutError = new Error(`${provider.id} timed out after ${timeoutMs}ms (ETIMEDOUT)`);
    timeoutError.code = 'ETIMEDOUT';
    throw timeoutError;
  }
  if (result.signal) {
    throw new Error(`${provider.id} interrupted by ${result.signal}: ${providerFailureDetails(provider, result.stdout, result.stderr)}`);
  }
  if (result.exitCode !== 0) {
    const code = typeof result.code === 'number' ? result.code : result.exitCode;
    throw new Error(`${provider.id} exited with ${code}: ${providerFailureDetails(provider, result.stdout, result.stderr)}`);
  }
  return {
    text: extractProviderText(provider.id, result.stdout),
    sessionId: extractProviderSessionId(provider.id, result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}
