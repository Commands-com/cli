import fs from 'node:fs/promises';
import path from 'node:path';

export function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function writeExecutable(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await fs.chmod(filePath, 0o755);
}

export async function writeTransientCodexBin({ dir, successText }) {
  const bin = path.join(dir, 'codex');
  await writeExecutable(bin, [
    '#!/bin/sh',
    'count_file="$0.count"',
    'if [ -f "$count_file" ]; then',
    '  read n < "$count_file"',
    'else',
    '  n=0',
    'fi',
    'n=$((n + 1))',
    'printf \'%s\\n\' "$n" > "$count_file"',
    'if [ "$n" -eq 1 ]; then',
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'stream disconnected before completion',
    }))}`,
    '  exit 1',
    'fi',
    `printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: successText },
    }))}`,
  ]);
  return bin;
}

export function memoryArtifacts(events = []) {
  return {
    promptPath: 'prompt.md',
    outputPath: 'output.md',
    path: 'output.md',
    async writePrompt(prompt) {
      events.push({ method: 'writePrompt', text: prompt });
    },
    async writeOutput(text) {
      events.push({ method: 'writeOutput', text });
    },
  };
}

export function recordStoreWrite(events) {
  return ({ name, value }) => {
    events.push({ method: 'store.write', path: name, text: value });
  };
}
