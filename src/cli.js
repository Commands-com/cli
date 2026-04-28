import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './args.js';
import { commandForName, formatCommandHelpRows } from './command-registry.js';
import {
  formatScopedOptionsHelp,
  stringOption,
  validateFlagsForCommand,
} from './command-options.js';
import { commandResult } from './command-result.js';
import { UsageError } from './errors.js';
import { createCommandLogger } from './logger.js';

function resolveCwd(flags, base = process.cwd()) {
  const requested = stringOption(flags, 'cwd', '');
  if (!requested) return base;
  const resolved = path.resolve(base, requested);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new UsageError(`--cwd path does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new UsageError(`--cwd must be a directory: ${resolved}`);
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const HELP = `Usage: commands-com <command> [options]

Commands:
${formatCommandHelpRows()}

Examples:
  commands-com init --providers all
  commands-com review "review the current diff" --changed
  commands-com review "fix the failing tests" --fix --test "npm test"
  commands-com review "fix safely" --fix --worktree --test "npm test"
  commands-com quality --changed --area maintainability
  commands-com quality --changed --area maintainability --fix --test "npm test"
  commands-com quality --changed --area maintainability --until A --test "npm test"
  commands-com rooms list
  commands-com room security "audit this CLI"
  commands-com doctor --ping --json
  commands-com runs list
  commands-com runs show <run-id>
  commands-com doctor

${formatScopedOptionsHelp()}
`;

export async function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  validateFlagsForCommand(parsed.command, parsed.flags);
  const cwd = resolveCwd(parsed.flags);
  const logger = createCommandLogger(parsed);
  const command = commandForName(parsed.command);

  if (command) {
    return applyCommandResult(await command.run(parsed, {
      cwd,
      helpText: HELP,
      logger: command.loggerChild ? logger.child(command.loggerChild) : logger,
    }));
  }

  logger.error(`Unknown command: ${parsed.command}`);
  logger.line(HELP);
  return applyCommandResult(commandResult({ failed: true }));
}

function applyCommandResult(result = commandResult()) {
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
  return result;
}
