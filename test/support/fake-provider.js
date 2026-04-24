import fs from 'node:fs/promises';
import path from 'node:path';

// Use the absolute node path so fakes still execute when the surrounding test
// scrubs PATH (e.g. setting `env: { PATH: binDir }` to isolate provider lookup).
const NODE_SHEBANG = `#!${process.execPath}`;

export function emitJsonLine(payload) {
  return `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});`;
}

export function emitCodexMessage(text) {
  return emitJsonLine({ type: 'item.completed', item: { type: 'agent_message', text } });
}

export function emitCodexError(message) {
  return emitJsonLine({ type: 'error', message });
}

export function emitClaudeResult(text) {
  return emitJsonLine({ result: text });
}

export function countedCodexProviderScript({ first, retry, retryExits = false }) {
  return [
    "const fs = require('node:fs');",
    "const countFile = `${process.argv[1]}.count`;",
    'let n = 0;',
    "try { n = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch {}",
    'n += 1;',
    'fs.writeFileSync(countFile, String(n));',
    'if (n > 1) {',
    `  ${retry}`,
    ...(retryExits ? ['  process.exit(1);'] : []),
    '} else {',
    `  ${first}`,
    '}',
  ];
}

export async function writeFakeProvider(binDir, name, script) {
  await fs.mkdir(binDir, { recursive: true });
  const body = Array.isArray(script) ? script.join('\n') : String(script);
  if (process.platform === 'win32') {
    return writeWindowsFakeProvider(binDir, name, body);
  }

  const filePath = path.join(binDir, name);
  const text = body.startsWith('#!') ? body : [NODE_SHEBANG, body, ''].join('\n');
  await fs.writeFile(filePath, text, 'utf8');
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function writeWindowsFakeProvider(binDir, name, body) {
  const scriptPath = path.join(binDir, `${name}.cjs`);
  const commandPath = path.join(binDir, `${name}.cmd`);
  await fs.writeFile(scriptPath, stripShebang(body), 'utf8');
  await fs.writeFile(
    commandPath,
    `@echo off\r\n"${batchLiteral(process.execPath)}" "${batchLiteral(scriptPath)}" %*\r\n`,
    'utf8',
  );
  return commandPath;
}

function stripShebang(body) {
  return body.startsWith('#!') ? body.replace(/^#![^\r\n]*(?:\r?\n)?/, '') : body;
}

function batchLiteral(value) {
  return value.replaceAll('%', '%%');
}

export async function writeFakeClaudeRoomProvider(binDir) {
  return writeFakeProvider(binDir, 'claude', [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    'const logPath = process.env.ROOM_PROVIDER_LOG;',
    "const isSynthesis = prompt.includes('You are synthesizing');",
    "const role = (prompt.match(/You are the ([\\s\\S]*?) in the Commands\\.com/) || [])[1] || 'participant';",
    "const label = isSynthesis ? 'synthesis' : role;",
    "const countKey = isSynthesis ? 'synthesis' : 'participant';",
    'const countPath = path.join(path.dirname(process.argv[1]), `${countKey}.count`);',
    'let count = 0;',
    "try { count = Number(fs.readFileSync(countPath, 'utf8')) || 0; } catch {}",
    'count += 1;',
    'fs.writeFileSync(countPath, String(count));',
    "if (logPath) fs.appendFileSync(logPath, `${isSynthesis ? 'synthesis' : 'participant'}\\n`);",
    "if (process.env.ROOM_FAIL === 'all' || (process.env.ROOM_FAIL === 'synthesis' && isSynthesis)) {",
    "  console.error(isSynthesis ? 'synthesis failure' : 'participant failure');",
    '  process.exit(isSynthesis ? 8 : 7);',
    '}',
    "if (process.env.ROOM_FAIL === 'participant-once' && !isSynthesis && count === 1) {",
    "  console.error('temporarily unavailable');",
    '  process.exit(7);',
    '}',
    "if (process.env.ROOM_FAIL === 'synthesis-once' && isSynthesis && count === 1) {",
    "  console.error('temporarily unavailable');",
    '  process.exit(8);',
    '}',
    'console.log(JSON.stringify({ text: `Fake ${label} output` }));',
  ]);
}
