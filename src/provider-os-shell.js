function needsShellInvocation(command, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}

// Windows command-line quoting per CreateProcessW rules. Wraps the argument
// in double quotes and doubles any backslash run that precedes a quote or the
// end of the argument. Returned strings are meant to be joined with spaces
// and passed to cmd.exe with `windowsVerbatimArguments: true`, so cmd.exe's
// own quote handling preserves the argument boundaries. Paired percent signs
// are caret-escaped before quoting because cmd.exe expands %VAR% even inside
// quotes. The quote decision uses the original arg so caret escapes added only
// for percents can remain unquoted and be consumed by cmd.exe.
function quoteForCmd(arg) {
  const raw = String(arg);
  const s = escapeCmdPercentExpansion(raw);
  if (s === '') return '""';
  if (!needsCmdQuote(raw)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

function escapeCmdPercentExpansion(s) {
  if (!s.includes('%') || s.indexOf('%') === s.lastIndexOf('%')) {
    return s;
  }
  return s.replaceAll('%', '^%');
}

function needsCmdQuote(s) {
  return /[\s"&|<>^()!,;=]/.test(s)
    || (s.includes('%') && s.indexOf('%') === s.lastIndexOf('%'));
}

function quoteCmdShellLine(line) {
  return line.startsWith('"') ? `"${line}"` : line;
}

// Build a spawn() target that never passes a user-controlled args array under
// `shell: true`. On Windows, `.cmd`/`.bat` shims are routed through
// `cmd.exe /d /s /v:off /c` with explicitly quoted arguments and
// `windowsVerbatimArguments: true`; everywhere else the command is spawned
// directly with its args array and no shell.
export function buildSpawnTarget(invocation, platform = process.platform) {
  if (needsShellInvocation(invocation.command, platform)) {
    const comSpec = (platform === 'win32' && process.env.ComSpec) || 'cmd.exe';
    const line = quoteCmdShellLine([invocation.command, ...invocation.args].map(quoteForCmd).join(' '));
    return {
      command: comSpec,
      args: ['/d', '/s', '/v:off', '/c', line],
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: invocation.command,
    args: invocation.args,
    windowsVerbatimArguments: false,
  };
}
