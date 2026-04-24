import { VALUE_FLAG_NAMES } from './command-option-schema.js';

const VALUE_FLAGS = new Set(VALUE_FLAG_NAMES);

/**
 * Public CLI argument parser.
 *
 * @param {string[] | null | undefined} argv
 * @returns {{ command: string, positionals: string[], flags: Map<string, string | boolean> }}
 */
export function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv.slice(2) : [];
  const positionals = [];
  const flags = new Map();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }

    const key = token.slice(2);
    const next = tokens[i + 1];
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  const command = positionals.shift() || 'help';
  return { command, positionals, flags };
}
