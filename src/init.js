import { initConfig } from './config.js';
import { commandResult } from './command-result.js';
import { stringOption } from './command-options.js';

export async function runInitCommand(parsed, { cwd, logger }) {
  if (!logger) {
    throw new Error('runInitCommand requires logger');
  }
  const provider = stringOption(parsed.flags, 'provider', '');
  const providers = stringOption(parsed.flags, 'providers', '');
  const model = stringOption(parsed.flags, 'model', '');
  const result = await initConfig(cwd, { provider, providers, model });

  if (logger.jsonMode) {
    logger.json({
      type: 'init.completed',
      configPath: result.filePath,
      config: result.config,
    });
    return commandResult();
  }

  logger.line(`Wrote ${result.filePath}`);
  if (result.config.provider) logger.line(`provider: ${result.config.provider}`);
  if (result.config.providers) logger.line(`providers: ${result.config.providers}`);
  if (result.config.model) logger.line(`model: ${result.config.model}`);
  return commandResult();
}
