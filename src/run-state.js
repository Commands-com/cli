import path from 'node:path';
import { artifactPath } from './artifact-paths.js';
import {
  openRunStore,
  readRunJson,
  resolveRunDir,
} from './run-store.js';
import {
  formatFailureMessage,
  UsageError,
} from './errors.js';
import { normalizeFiniteNonNegativeNumber } from './number-utils.js';
import { isObjectRecord } from './objects.js';

const RUN_STATE_FILE = 'run-state.json';
export const RUN_STATE_VERSION = 1;
const SENSITIVE_PROVIDER_FIELD_NAMES = new Set(['cookie', 'passphrase']);
const SENSITIVE_PROVIDER_FIELD_SUFFIXES = Object.freeze([
  '_api_key',
  '_auth_header',
  '_auth_token',
  '_authorization',
  '_authorization_header',
  '_password',
  '_private_key',
  '_secret',
  '_token',
]);

export async function loadRunState(cwd, runRef) {
  const { dir, runId, value } = await readRunJson(cwd, runRef, RUN_STATE_FILE);
  return {
    dir,
    runId,
    state: normalizeRunStatePayload(value),
  };
}

export async function openResumeStore(cwd, runRef) {
  const dir = await resolveRunDir(cwd, runRef);
  return openRunStore(dir, path.basename(dir));
}

/**
 * @param {*} state
 * @param {{ status?: string, error?: unknown }} [options]
 */
export async function writeRunState(state, {
  status = 'running',
  error,
} = {}) {
  if (typeof state?.store?.writeJson !== 'function') return '';
  return state.store.writeJson(artifactPath(RUN_STATE_FILE), runStatePayload(state, { status, error }));
}

/**
 * @param {*} state
 * @param {{ status?: string, error?: unknown }} [options]
 */
function runStatePayload(state, {
  status = 'running',
  error,
} = {}) {
  const redactedKeys = [];
  const options = serializeOptionsCollectingRedactions(state.options, redactedKeys);
  if (redactedKeys.length && typeof state?.logger?.warn === 'function') {
    for (const key of redactedKeys) {
      state.logger.warn(`[run-state] redacted sensitive provider field: ${key}`);
    }
  }
  return {
    version: RUN_STATE_VERSION,
    status: normalizeStateString(status),
    updatedAt: new Date().toISOString(),
    kind: state.kind,
    runId: state.store?.runId || '',
    storeDir: state.store?.dir || '',
    workspace: state.workspace || {},
    context: state.context || {},
    options,
    cycles: Array.isArray(state.cycles) ? state.cycles : [],
    providerSessions: serializeProviderSessions(state.providerSessions),
    priorFindings: state.priorFindings || '',
    hasUnresolvedTestFailure: Boolean(state.hasUnresolvedTestFailure),
    stalledCycles: normalizeFiniteNonNegativeNumber(state.stalledCycles),
    stopReason: state.stopReason || '',
    ...(error ? { error: formatFailureMessage(error) } : {}),
  };
}

function normalizeRunStatePayload(payload) {
  const source = isObjectRecord(payload) ? payload : {};
  const version = normalizeRunStateVersion(source);
  return {
    version,
    status: normalizeStateString(source.status),
    kind: normalizeStateString(source.kind),
    runId: normalizeStateString(source.runId),
    storeDir: normalizeStateString(source.storeDir),
    workspace: isObjectRecord(source.workspace) ? source.workspace : {},
    context: isObjectRecord(source.context) ? source.context : {},
    options: isObjectRecord(source.options) ? source.options : {},
    cycles: Array.isArray(source.cycles) ? source.cycles : [],
    providerSessions: serializeProviderSessions(source.providerSessions),
    priorFindings: normalizeStateString(source.priorFindings),
    hasUnresolvedTestFailure: Boolean(source.hasUnresolvedTestFailure),
    stalledCycles: normalizeFiniteNonNegativeNumber(source.stalledCycles),
    stopReason: normalizeStateString(source.stopReason),
  };
}

function serializeProviderSessions(providerSessions) {
  if (!isObjectRecord(providerSessions)) return {};
  return Object.fromEntries(
    Object.entries(providerSessions)
      .map(([key, value]) => [String(key), normalizeStateString(value).trim()])
      .filter(([key, value]) => key && value),
  );
}

function normalizeRunStateVersion(source) {
  if (source.version === RUN_STATE_VERSION || source.version === undefined) return RUN_STATE_VERSION;
  const found = JSON.stringify(source.version);
  throw new UsageError(`unsupported run-state version: ${found} (expected ${RUN_STATE_VERSION})`);
}

function normalizeStateString(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function serializeCycleOptions(options = {}) {
  return serializeOptionsCollectingRedactions(options, null);
}

function serializeOptionsCollectingRedactions(options, redactedKeys) {
  const source = isObjectRecord(options) ? options : {};
  return {
    ...source,
    providers: Array.isArray(source.providers)
      ? source.providers
        .map((provider) => serializeProviderInto(provider, redactedKeys))
        .filter((provider) => provider !== undefined)
      : [],
    primaryProvider: serializeProviderInto(source.primaryProvider, redactedKeys),
  };
}

export function serializeProvider(provider) {
  return serializeProviderInto(provider, null);
}

function serializeProviderInto(provider, redactedKeys) {
  if (provider === null) return null;
  if (isSerializablePrimitive(provider)) return provider;
  if (!provider || typeof provider !== 'object') return undefined;
  return serializeProviderEntries(provider, redactedKeys);
}

function serializeProviderEntries(provider, redactedKeys) {
  return Object.fromEntries(
    Object.entries(provider)
      .filter(([key]) => {
        if (!isSensitiveProviderField(key)) return true;
        if (redactedKeys) redactedKeys.push(key);
        return false;
      })
      .map(([key, value]) => [key, serializeProviderValue(value, redactedKeys)])
      .filter(([, value]) => value !== undefined),
  );
}

function serializeProviderValue(value, redactedKeys) {
  if (value === null) return null;
  if (isSerializablePrimitive(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => serializeProviderValue(item, redactedKeys)).filter((item) => item !== undefined);
  }
  if (isObjectRecord(value)) return serializeProviderEntries(value, redactedKeys);
  return undefined;
}

function isSerializablePrimitive(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function isSensitiveProviderField(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return SENSITIVE_PROVIDER_FIELD_NAMES.has(normalized)
    || SENSITIVE_PROVIDER_FIELD_SUFFIXES.some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    );
}
