import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = resolve('bin/commands-com.js');
const maxBuffer = 10 * 1024 * 1024;

async function runCli(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    maxBuffer,
  });
  writeOutput(process.stdout, stdout);
  writeOutput(process.stderr, stderr);
  return stdout;
}

function writeOutput(stream, text) {
  if (!text) return;
  stream.write(text);
  if (!text.endsWith('\n')) stream.write('\n');
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

const review = parseJson(await runCli(['review', 'smoke test', '--provider', 'mock', '--json']));
await runCli(['quality', '--provider', 'mock', '--area', 'maintainability', '--json']);
await runCli(['rooms', 'list', '--json']);
await runCli(['room', 'security', 'smoke room', '--provider', 'mock', '--participants', '1', '--json']);
await runCli(['doctor', '--json']);
await runCli(['runs', 'list', '--json']);
await runCli(['runs', 'show', review.runId, '--json']);

const initCwd = await mkdtemp(join(tmpdir(), 'commands-com-smoke-init-'));
await runCli(['init', '--cwd', initCwd, '--provider', 'mock', '--json']);
