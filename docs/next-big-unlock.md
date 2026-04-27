# Next Big Unlock: Spec-First Implementation and Per-Task Resume

## Status

The original "task worktrees and resumable implementation" plan has largely shipped:

- **Task state model** — `tasks.json` and per-task `status.json` are written; states include `planned`, `running`, `succeeded`, `failed`, `merged`, `merge-conflict`, `validation-failed` (`src/implementation-task-artifacts.js`, `src/implementation-task-attempt.js`).
- **Task worktrees** — one worktree per task, branched from the base SHA, with `diff.patch` and `diff-stat.txt` captured; failed worktrees are preserved (`src/task-worktrees.js`, `src/implementation-task-patch.js`).
- **Merge / apply** — task diffs are applied via `git apply --3way`, out-of-scope edits and conflicts are detected, and per-task merge logs are written (`src/implementation-task-merge.js`).
- **Run-level resume** — `--resume <run-id>` reloads run metadata, completed cycles, provider sessions, and prior findings (`src/run-state.js`, `src/cycle-workflow.js`).

What is **not** shipped is tracked below.

## Remaining Work

### Spec-first implementation (not started)

There is no `implement` command and no spec loop. The current fix loops (`review --fix`, `quality --fix`) treat synthesis as the spec, which is acceptable for narrow findings but leaves standalone implementation objectives ungated.

Open scope:

- A spec draft → review → revise → approve flow before any write-capable implementer runs.
- `--spec-only`, `--approve-spec`, `--max-spec-cycles` flags.
- An approval gate suitable for both interactive and CI use.

### Per-task resume semantics (partial)

`--resume` currently operates at cycle granularity. It does not yet:

- skip individual tasks already marked `merged` within a cycle,
- retry `failed` / `validation-failed` / `merge-conflict` tasks in a fresh worktree,
- restart validation or re-review from the last safe per-task checkpoint.

### Resume / retry flags (not shipped)

`--rerun-task <id>`, `--skip-task <id>`, `--merge-only`, `--retry-failed`, and `--keep-task-worktrees` are not implemented. These become useful once per-task resume lands.

### `typeCheckAllowlist` drain — `assessment-cycle.js` blocked by callsites

`src/assessment-cycle.js` is internally typed (typedefs and JSDoc on every helper) but cannot graduate from `typeCheckAllowlist` on its own: adding it to the `include` array pulls its imports — `cycle-implementation.js`, `cycle-synthesis.js`, `implementation.js`, `implementation-task-attempt.js`, `implementation-task-context.js`, `implementation-task-merge.js`, `run-state.js`, `task-worktrees.js` — into the type-check set, and those callsites surface real type errors (missing `retryDelayMs` on the implementation runner argument, loose `{}` destructure shapes, untyped `git`/`process-runner` adapter return values). The next step here is callsite typing in those files, not further work inside `assessment-cycle.js`.

## Open Questions

- Should `implement` be a new command, or should `room implementation-plan` evolve into it?
- Which spec reviewers are required by default?
- Should approval be interactive by default, with `--spec-only` for non-interactive terminals?
- Can `review --fix` and `quality --fix` keep skipping the spec loop, or should large fixes still require an approval gate?
- Should task worktrees branch from the original cycle base or from the integration workspace after prior successful merges?
- On a single task failure, should the default be stop-all, merge-successes, or ask?
