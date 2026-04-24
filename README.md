<div align="center">

# Commands.com CLI

**One command to improve your codebase until it earns an A.**

[![Node](https://img.shields.io/badge/Node-20.19%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Providers](https://img.shields.io/badge/Providers-Codex%20%7C%20Claude%20%7C%20Gemini-8B5CF6.svg)](#providers)
[![Tests](https://github.com/Commands-com/cli/actions/workflows/test.yml/badge.svg)](https://github.com/Commands-com/cli/actions/workflows/test.yml)

```sh
npx commands-com quality --until A
```

Commands.com fans out across local AI CLIs, synthesizes a code-quality grade,
plans non-overlapping fixes, runs implementers in parallel, re-reviews, and
keeps going until the target grade is reached or the safety cap stops it.

</div>

---

## Why This Is Fun

Most agent tools ask you to steer every step. Commands.com is the terminal-native
version of "set it and forget it":

```text
audit -> synthesize -> plan fixes -> run implementers -> validate -> re-audit
```

It writes everything to plain files under `.commands-com/runs/`: prompts,
provider outputs, preflight checks, task status, resume state, Markdown reports,
and the final summary.

The headline move:

```sh
npx commands-com quality --until A --test "npm test"
```

Walk away. Come back to a scored final report.

---

## Quick Start

Try it without installing:

```sh
npx commands-com quality --until A
```

Use a deterministic local mock provider:

```sh
npx commands-com quality --provider mock --until A
```

Save provider defaults:

```sh
commands-com init --providers all
```

Run a normal review:

```sh
commands-com review "review the current diff" --changed
commands-com review "fix the failing tests" --fix --test "npm test"
```

Resume after a provider outage, capacity error, or interrupted shell:

```sh
commands-com quality --resume latest
commands-com review --resume <run-id>
```

Inspect the trail:

```sh
commands-com runs list
commands-com runs show <run-id>
```

Requires Node.js 20.19 or newer.

---

## What It Does

- **Quality to A**: `quality --until A` keeps cycling until the synthesized A-F score reaches the target.
- **Scored review**: `review --until A` uses the same stop shape for code review loops.
- **Parallel fan-out**: provider × area and provider × reviewer jobs run together by default.
- **One synthesized answer**: provider findings are deduped into a final score, synopsis, and prioritized issues.
- **Multi-implementer fixes**: the orchestrator chooses tasks up to `--max-implementers`, then workers run non-overlapping fixes.
- **Provider fallback**: transient capacity and stream failures retry, then fall through to the next provider.
- **Resume-safe runs**: `run-state.json` lets `--resume` continue from the previous cycle.
- **Plain local files**: no daemon, no hosted project state, no mystery database.

---

## Providers

`review` and `quality` default to `--providers all`, which uses every available
real provider CLI in order: Codex, Claude, Gemini. The built-in `mock` provider
keeps tests and demos fast.

```sh
commands-com doctor --ping
commands-com quality --providers codex,claude,gemini --until A
commands-com quality --provider claude --area maintainability
```

Environment defaults work too:

```sh
COMMANDS_COM_PROVIDERS=codex,claude commands-com quality --until A
COMMANDS_COM_PROVIDER=codex COMMANDS_COM_MODEL=gpt-5.5 commands-com review "review this"
```

---

## Safety

Report-only is the default. File edits require `--fix` or `--until`.

Commands.com refuses to edit a dirty current worktree unless you pass
`--allow-dirty` or isolate edits in a git worktree:

```sh
commands-com quality --until A --worktree --test "npm test"
```

Fix loops also write `preflight.json`, `run-state.json`, `final-summary.json`,
and `final-report.md` so failed or interrupted runs are understandable.

---

## Commands

| Command | Use it for |
| --- | --- |
| `quality` | Score and improve code quality. |
| `review <objective>` | Review a diff or objective, optionally with fixes. |
| `room <type> <objective>` | Run a focused multi-perspective room. |
| `rooms list` | See available rooms. |
| `runs list` / `runs show <id>` | Inspect local run artifacts. |
| `doctor` | Check provider CLI availability. |
| `init` | Save local provider defaults. |

Built-in rooms include `security`, `architecture`, `performance`, `bug-hunt`,
`test-plan`, `implementation-plan`, `product-spec`, `docs`,
`release-readiness`, and `codebase-research`.

```sh
commands-com room security "audit the local runtime"
commands-com room implementation-plan "ship the v1 unlock"
```

---

## Flags

Run `commands-com help` for full descriptions. The short version:

### Common Flags

`--cwd`, `--json`

### Review Flags

`--providers`, `--provider`, `--model`, `--changed`, `--until`, `--fix`, `--resume`,
`--worktree`, `--base-ref`, `--allow-dirty`, `--keep-worktree`,
`--max-cycles`, `--max-implementers`, `--stall-cycles`, `--reviewers`,
`--parallel`, `--serial`, `--retries`, `--test`, `--timeout-ms`,
`--fail-on-issues`

### Quality Flags

`--providers`, `--provider`, `--model`, `--changed`, `--until`, `--fix`,
`--resume`, `--worktree`, `--base-ref`, `--allow-dirty`, `--keep-worktree`,
`--max-cycles`, `--max-implementers`, `--stall-cycles`, `--area`,
`--parallel`, `--serial`, `--retries`, `--test`, `--timeout-ms`,
`--fail-on-issues`

### Room Flags

`--provider`, `--model`, `--changed`, `--participants`, `--parallel`,
`--no-synthesis`, `--retries`, `--timeout-ms`

### Doctor Flags

`--providers`, `--provider`, `--model`, `--ping`, `--timeout-ms`

### Init Flags

`--providers`, `--provider`, `--model`

### Runs Flags

`--limit`

---

## Run Layout

Every run writes a folder like:

```text
.commands-com/runs/<run-id>/
  metadata.json
  preflight.json
  run-state.json
  context.md
  prompts/
  cycle-1/
    synthesis.md
    areas/ or reviewers/
    implementation-plan.md
    tasks/
    implementation.md
    test.log
  code-quality.md or review-cycle.md
  final-summary.json
  final-report.md
```

---

## Development

```sh
npm install
npm run validate
```

The `mock` provider is part of the product. It keeps tests and docs usable on
machines without AI provider CLIs installed.

See [SECURITY.md](SECURITY.md) for the `--fix` and `--test` trust model, and
[CONTRIBUTING.md](CONTRIBUTING.md) for project guardrails.

---

## License

MIT, see [LICENSE](LICENSE).
