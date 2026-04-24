import { runMockProvider } from './mock-provider.js';

function frozenCapabilities(capabilities) {
  return Object.freeze({
    directRun: false,
    pathLookup: false,
    ...capabilities,
  });
}

const PROVIDER_ADAPTERS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    commandName: 'codex',
    invocation: 'codex',
    output: 'codex-jsonl',
    capabilities: frozenCapabilities({
      pathLookup: true,
    }),
  }),
  claude: Object.freeze({
    id: 'claude',
    commandName: 'claude',
    invocation: 'claude',
    output: 'generic',
    capabilities: frozenCapabilities({
      pathLookup: true,
    }),
  }),
  gemini: Object.freeze({
    id: 'gemini',
    commandName: 'gemini',
    invocation: 'gemini',
    output: 'generic',
    capabilities: frozenCapabilities({
      pathLookup: true,
    }),
  }),
  mock: Object.freeze({
    id: 'mock',
    path: 'built-in',
    output: 'generic',
    capabilities: frozenCapabilities({
      directRun: true,
    }),
    run: (_provider, options) => runMockProvider(options),
  }),
});

const PROVIDER_ORDER = Object.freeze(Object.keys(PROVIDER_ADAPTERS));

export function getProviderAdapter(providerId) {
  return PROVIDER_ADAPTERS[String(providerId || '').toLowerCase()] || null;
}

export function providerAdapters() {
  return PROVIDER_ORDER.map((id) => PROVIDER_ADAPTERS[id]);
}

export function adapterSupportsPathLookup(adapter) {
  return adapter?.capabilities?.pathLookup === true;
}

export function adapterRunsDirectly(adapter) {
  return adapter?.capabilities?.directRun === true;
}
