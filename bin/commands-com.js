#!/usr/bin/env node
import { main } from '../src/cli.js';
import { normalizeError } from '../src/errors.js';

main(process.argv).catch((error) => {
  const normalized = normalizeError(error);
  console.error(`commands-com: ${normalized.message}`);
  process.exitCode = normalized.exitCode || 1;
});
