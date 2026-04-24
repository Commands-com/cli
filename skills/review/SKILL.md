---
name: "review"
description: "Run a local multi-agent code review with the commands-com OSS CLI"
argument-hint: "[objective]"
disable-model-invocation: true
allowed-tools: Bash(commands-com *), Bash(git *)
---

# Review

Run a local, single-process review cycle using the `commands-com` OSS CLI.
No desktop app, no account, no daemon — the CLI fans out to available provider
CLIs (`codex`, `claude`, `gemini`, or explicit lists), synthesizes findings,
and writes a Markdown report under `.commands-com/runs/<run-id>/`.

Default objective: Review the current working directory for correctness,
regressions, and missing tests.

## Arguments

The user invoked this with: $ARGUMENTS

## Instructions

1. Decide what to review:
   - If the user gave a specific directory, pass it via `--cwd <path>`.
   - Otherwise use the current directory (the CLI's default).
   - If no objective was provided, look at recent git history first to craft a
     specific one. Run:
     ```
     git log --oneline -5
     git diff HEAD~1 --stat
     ```
     and base the objective on what changed.

2. Confirm `commands-com` is on PATH and a provider is available:
   ```
   commands-com doctor
   ```
   To verify auth/response parsing instead of PATH only, run:
   ```
   commands-com doctor --ping --json
   ```
   If no provider CLI is installed, fall back to `--provider mock` so the
   round-trip still works (it returns deterministic placeholder findings).

3. Run the review with `--json` so the result is machine-readable. Default to
   `--changed` when the working tree has uncommitted edits worth scoping to;
   omit it for a broader pass. Use `--providers all` unless the user asked for
   a specific provider. **This is report-only — one cycle, no edits, no
   re-review pass.**
   ```
   commands-com review "<objective>" \
     --cwd "<dir>" \
     --providers <all|codex,claude,gemini|mock> \
     --reviewers correctness,tests,maintainability \
     --json
   ```

4. If the user asked the agent to *fix* things (not just report), add `--fix`.
   For untrusted edits or large diffs, also add `--worktree` so the changes
   land in an isolated git worktree and can be inspected before merging.
   With `--fix` the loop becomes review → implement → re-review (and repeats
   up to `--max-cycles`):
   ```
   commands-com review "<objective>" --cwd "<dir>" --providers <ids> \
     --fix --worktree --test "<validation command>" --max-cycles 2 --json
   ```
   Heads-up before launching: a `--providers all --fix --max-cycles 2` run
   typically makes ~24 LLM calls and takes 5–10 minutes. Drop providers,
   reviewers, or cycles to trade depth for speed. If you only have a single
   provider authenticated, prefer `--provider <id>` to skip fan-out.

5. Summarize the JSON result for the user:
   - `runId` and `reportPath` (the Markdown report).
   - `providers`, `synthesizerProvider`, and `implementerProvider`.
   - The final cycle's `issueCount` and (if `--test` ran) `unresolvedTestFailure`.
   - For `--worktree` runs: `workspace.prune.ok` (true means the worktree was
     auto-removed because no changes were made) or `workspace.cwd` /
     `workspace.branch` (the worktree to inspect manually otherwise).

6. Prior runs can be listed and inspected without re-running the provider:
   ```
   commands-com runs list
   commands-com runs show <run-id>
   ```

## Notes

- This skill is local-only and does not require the Commands.com desktop app.
- Provider auth is whatever the underlying CLI already uses (`codex login`,
  `claude login`, `gemini auth`, etc.) — `commands-com` only forwards prompts.
- All run artifacts live under `.commands-com/runs/<run-id>/` in the target
  directory and are gitignored by default.
