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
    if (Array.isArray(values) && values.length) return values;
  }
  return listOption(parsed.flags, flag, fallback);
}
