import { hasFlag, listOption, stringOption } from './command-options.js';
import { readRunMetadata } from './run-store.js';

/**
 * @typedef {import('./cycle-workflow.js').ParsedCycleCommand} ParsedCycleCommand
 * @typedef {import('./run-store.js').RunMetadata} RunMetadata
 */

/**
 * @param {ParsedCycleCommand} parsed
 * @param {string} cwd
 * @returns {Promise<RunMetadata | null>}
 */
export async function readResumeMetadata(parsed, cwd) {
  const resume = stringOption(parsed.flags, 'resume', '');
  if (!resume) return null;
  return (await readRunMetadata(cwd, resume)).value;
}

/**
 * @param {ParsedCycleCommand} parsed
 * @param {RunMetadata | null} metadata
 * @param {{ flag: string, metadataField: string, fallback: string[] }} options
 * @returns {string[]}
 */
export function metadataListOption(parsed, metadata, { flag, metadataField, fallback }) {
  if (!hasFlag(parsed.flags, flag)) {
    const values = metadata?.[metadataField];
    if (Array.isArray(values)) {
      const usable = values
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (usable.length) return usable;
    }
  }
  return listOption(parsed.flags, flag, fallback);
}
