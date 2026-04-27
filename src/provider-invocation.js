import { getProviderAdapter as getAdapterMetadata } from './provider-adapters.js';

/**
 * Options consumed by `buildProviderInvocation` and `runProvider`.
 *
 * Callers pass a single bag of options that flows into invocation building,
 * limit resolution, and the spawn layer. All fields are optional: each
 * consumer reads only what it needs.
 *
 * @typedef {object} RunProviderOptions
 * @property {string} [prompt] Stdin text passed to the provider CLI.
 * @property {string} [model] Provider model identifier.
 * @property {boolean} [allowTools] Whether the invocation may use tool/write-capable mode.
 * @property {string} [resumeSessionId] Provider session id to resume.
 * @property {string} [cwd] Working directory for the spawned process.
 * @property {number} [timeoutMs] Provider invocation timeout in milliseconds.
 * @property {number} [maxOutputBytes] Captured stdout/stderr cap in bytes.
 */

function normalizedResumeSessionId(value) {
  return String(value || '').trim();
}

function buildCodexInvocation(provider, { prompt, model, allowTools, resumeSessionId = '' }) {
  const args = ['exec', '--json', '--skip-git-repo-check'];
  const resume = normalizedResumeSessionId(resumeSessionId);
  if (model) args.push('--model', model);
  args.push('--sandbox', allowTools ? 'workspace-write' : 'read-only');
  args.push('--config', 'mcp_servers={}');
  if (resume) args.push('resume', resume, '-');
  else args.push('-');
  return { command: provider.command, args, stdin: prompt };
}

function buildClaudeInvocation(provider, { prompt, model, allowTools, resumeSessionId = '' }) {
  const args = ['--print', '--output-format', 'json'];
  const resume = normalizedResumeSessionId(resumeSessionId);
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  if (allowTools) {
    args.push('--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,LS');
  }
  return { command: provider.command, args, stdin: prompt };
}

function buildGeminiInvocation(provider, { prompt, model, allowTools, resumeSessionId = '' }) {
  // `--prompt ''` puts the CLI in non-interactive mode without polluting the
  // prompt; the real content flows via stdin, which Gemini appends.
  const args = ['--output-format', 'json', '--prompt', ''];
  const resume = normalizedResumeSessionId(resumeSessionId);
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  if (allowTools) {
    args.push('--yolo');
  } else {
    args.push('--approval-mode', 'plan');
  }
  return { command: provider.command, args, stdin: prompt };
}

const INVOCATION_BUILDERS = Object.freeze({
  codex: buildCodexInvocation,
  claude: buildClaudeInvocation,
  gemini: buildGeminiInvocation,
});

// `model` flows into spawn args and, on Windows, through cmd.exe when the
// provider is an npm `.cmd`/`.bat` shim. Enforce a conservative character
// set so shell metacharacters can never reach the shell layer, even if
// future callers wire up `shell: true`.
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9._:@/-]+$/;

function assertSafeModel(model) {
  if (model === '' || model === undefined || model === null) return;
  if (!SAFE_MODEL_PATTERN.test(String(model))) {
    throw new Error(`invalid --model value '${model}': only letters, digits, and ._:@/- are allowed`);
  }
}

/**
 * @param {{id: string, command?: string}} provider
 * @param {RunProviderOptions} options
 */
export function buildProviderInvocation(provider, { prompt, model, allowTools, resumeSessionId = '' }) {
  assertSafeModel(model);
  const adapter = getAdapterMetadata(provider.id);
  const buildInvocation = adapter?.invocation ? INVOCATION_BUILDERS[adapter.invocation] : null;
  if (buildInvocation) return buildInvocation(provider, { prompt, model, allowTools, resumeSessionId });

  throw new Error(`unsupported provider: ${provider.id}`);
}
