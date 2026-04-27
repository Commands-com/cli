import { isObjectRecord } from './objects.js';
import { safePathSegment } from './safe-path.js';

const DEFAULT_ARTIFACT_SEGMENT = 'artifact';
/** @type {ReadonlyArray<readonly [RegExp, string]>} */
const ARTIFACT_FILE_NORMALIZATION_STEPS = Object.freeze([
  [/[^a-z0-9.]+/g, '-'],
  [/\.{2,}/g, '.'],
  [/(^|[^a-z0-9])\.+/g, '$1'],
  [/\.+($|[^a-z0-9])/g, '$1'],
  [/-+/g, '-'],
  [/^-+|-+$/g, ''],
  [/^\.+|\.+$/g, ''],
]);

export function artifactPath(...segments) {
  return buildArtifactPath({}, ...segments);
}

export function markdownArtifactPath(...segments) {
  return buildArtifactPath({ markdown: true }, ...segments);
}

export function promptArtifactPath(...segments) {
  return buildArtifactPath({ prompt: true }, ...segments);
}

function cycleDirectory(cycle) {
  return `cycle-${normalizePositiveInteger(cycle, 'cycle')}`;
}

export function cycleArtifactPath(cycle, ...segments) {
  return buildArtifactPath({ cycle }, ...segments);
}

export function cycleMarkdownArtifactPath(cycle, ...segments) {
  return buildArtifactPath({ cycle, markdown: true }, ...segments);
}

export function cyclePromptArtifactPath(cycle, ...segments) {
  return buildArtifactPath({ cycle, prompt: true }, ...segments);
}

export function providerItemArtifactDescriptor({
  artifactRoot,
  provider,
  providerFile,
  item,
  itemFile,
}) {
  const parts = providerItemArtifactSegments({
    artifactRoot,
    provider: provider ?? providerFile,
    item: item ?? itemFile,
  });
  return {
    path: joinArtifactPath(parts.artifactRoot, parts.providerFile, withExtension(parts.itemFile, 'md')),
    promptPath: promptArtifactPath(parts.providerFile, parts.itemFile),
    ...parts,
  };
}

export function cycleProviderItemArtifactDescriptor({
  cycle,
  artifactRoot,
  provider,
  item,
}) {
  const parts = providerItemArtifactSegments({ artifactRoot, provider, item });
  return {
    path: joinArtifactPath(
      cycleDirectory(cycle),
      parts.artifactRoot,
      parts.providerFile,
      withExtension(parts.itemFile, 'md'),
    ),
    promptPath: cyclePromptArtifactPath(cycle, parts.providerFile, parts.itemFile),
    ...parts,
  };
}

export function providerItemResolvedArtifactPath({
  artifactRoot,
  provider,
  providerFile,
  item,
  itemFile,
}) {
  const parts = providerItemArtifactSegments({
    artifactRoot,
    provider: provider ?? providerFile,
    item: item ?? itemFile,
  });
  return joinArtifactPath(parts.artifactRoot, parts.providerFile, withExtension(parts.itemFile, 'md'));
}

function providerItemArtifactSegments({
  artifactRoot,
  provider,
  item,
}) {
  return {
    artifactRoot: safePathSegment(artifactRoot, DEFAULT_ARTIFACT_SEGMENT),
    providerFile: safePathSegment(providerArtifactValue(provider), 'provider'),
    itemFile: safePathSegment(itemArtifactValue(item), 'item'),
  };
}

function joinArtifactPath(...segments) {
  return segments.filter(Boolean).join('/');
}

/**
 * @param {{ cycle?: number|string, markdown?: boolean, prompt?: boolean }} [options]
 * @param {...(string|string[])} segments
 */
function buildArtifactPath({ cycle, markdown = false, prompt = false } = {}, ...segments) {
  const normalized = normalizeArtifactPathSegments(segments, { finalFile: !prompt });
  const cycleSegment = cycle === undefined ? '' : cycleDirectory(cycle);

  if (prompt) {
    const name = normalized.join('-') || DEFAULT_ARTIFACT_SEGMENT;
    const promptName = cycleSegment ? `${cycleSegment}-${name}` : name;
    return joinArtifactPath('prompts', withExtension(promptName, 'md'));
  }

  if (markdown) {
    const file = normalized.pop() || DEFAULT_ARTIFACT_SEGMENT;
    normalized.push(withExtension(file, 'md'));
  }

  return joinArtifactPath(cycleSegment, ...normalized);
}

function normalizeArtifactPathSegments(segments, { finalFile = false } = {}) {
  const flattened = segments.flat();
  return flattened
    .map((segment, index) => {
      const isFileSegment = finalFile && index === flattened.length - 1;
      return isFileSegment
        ? normalizeArtifactFileSegment(segment)
        : safePathSegment(segment, DEFAULT_ARTIFACT_SEGMENT);
    })
    .filter(Boolean);
}

// Mirrors safePathSegment's lowercase separator normalization, but keeps single
// dots inside final filenames for extensions and retry-attempt suffixes.
function normalizeArtifactFileSegment(value, fallback = DEFAULT_ARTIFACT_SEGMENT) {
  const normalized = normalizeArtifactFileText(value);

  if (normalized) return normalized;
  if (fallback === undefined) return '';

  return normalizeArtifactFileText(fallback) || DEFAULT_ARTIFACT_SEGMENT;
}

function normalizeArtifactFileText(value) {
  return ARTIFACT_FILE_NORMALIZATION_STEPS.reduce(
    (segment, [pattern, replacement]) => segment.replace(pattern, replacement),
    String(value ?? '').toLowerCase(),
  );
}

function withExtension(name, extension) {
  const suffix = `.${extension}`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

function providerArtifactValue(provider) {
  if (isObjectRecord(provider)) {
    return provider.id ?? provider.name ?? provider.label;
  }
  return provider;
}

function itemArtifactValue(item) {
  if (isObjectRecord(item)) {
    return item.pathSegment ?? item.id ?? item.label ?? item.value;
  }
  return item;
}

function normalizePositiveInteger(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new TypeError(`${label} must be a positive integer`);
  }

  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }

  return String(number);
}
