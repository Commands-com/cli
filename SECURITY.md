# Security Policy

This CLI is local-first and runs provider CLIs on the user's machine. Treat AI
provider output as untrusted.

## Defaults

- `review` and `quality` are report-only by default. Provider adapters may grant
  read-only inspection tools for report-only runs, but write-capable tools are
  reserved for explicit `--fix` runs.
- `review` defaults to all available real provider CLIs. Repository context and
  diffs are sent to each selected provider; use `--provider <id>` or
  `--providers <ids>` to restrict fan-out.
- `doctor --ping` sends only a small health-check prompt to selected providers.
  It does not include repository context or grant tools.
- `review --fix` or `quality --fix` is required before provider tools may edit files.
- `review --fix` and `quality --fix` refuse dirty worktrees unless `--allow-dirty` or `--worktree`
  is explicitly provided.
- `--worktree` is the recommended path for untrusted or large edits.
- `--fix` first asks an orchestrator for non-overlapping implementation tasks.
  Up to `--max-implementers` write-capable provider CLIs may run in parallel.
  The orchestrator chooses the actual task count up to that cap, and tasks with
  overlapping or unknown file ownership are serialized.
- `--test` is evaluated by the user's shell so commands like `npm test` work.
  Never construct `--test` from provider output or untrusted text. Captured
  `--test` stdout/stderr are capped at 10 MiB total per stream in run artifacts.
- `review --fix` and `quality --fix` send repository context, diffs, synthesized
  findings, and task instructions to provider CLIs with tools enabled. Treat
  diff content as part of the trust boundary; use `--worktree` for changes you
  do not fully trust.

## Reporting Issues

Until the public repository is created, report security issues privately to the
maintainers. Do not open public issues for exploitable behavior.
