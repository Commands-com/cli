# Next Big Unlock: Task Worktrees and Resumable Implementation

## Summary

The next major unlock for `review --fix` and `quality --fix` is moving from one shared implementation workspace to one isolated workspace per planned task.

Today the CLI can fan out implementation work:

```text
audit/review -> synthesis -> implementation plan -> N implementers -> validation -> re-review
```

But all implementers currently share one workspace: either the current repo or one `--worktree` checkout. That is useful, but it makes write-capable retries and partial failures risky. If task 4 fails after editing files, the whole batch is hard to reason about.

The next model should be:

```text
base snapshot
  -> spec loop
  -> approval gate
  -> orchestrator plan
  -> task worktree per task
  -> one implementer per task worktree
  -> validate each task diff
  -> apply clean task diffs back to the integration workspace
  -> run tests
  -> re-review
```

This turns a fix loop into a local, resumable implementation farm.

## Current State

Current strengths:

- Provider fan-out works for review and quality.
- Quality synthesis produces a terminal score and synopsis.
- Fix loops default to 3 cycles.
- The orchestrator plans non-overlapping implementation tasks.
- `--max-implementers` is a cap, default `15`.
- Implementer calls retry transient provider failures.
- Provider failures write useful artifacts.
- `--worktree` can isolate the entire fix loop from the original repo.

Current limitation:

- All implementers in a batch write into the same workspace.
- A failed implementer can leave partial edits beside successful implementers.
- Retrying write-capable tasks is still scary because the retry may run over partial state.
- Resume cannot yet skip already successful implementation tasks.

## Goal

Make each implementation task independently runnable, retryable, inspectable, and mergeable.

The goal is not just parallelism. The real value is isolation and checkpointing:

- A failed task does not contaminate successful tasks.
- A completed task can be skipped on resume.
- A retry can happen in a fresh task worktree.
- Successful task diffs can be validated before they touch the integration workspace.
- The run directory becomes the source of truth for what happened.

## Spec-First Implementation

Standalone implementation should start with a spec, not file edits.

For `review --fix` and `quality --fix`, the synthesized findings already act like a narrow spec. For a standalone implementation command, the initial objective is usually too ambiguous. The CLI should turn the objective into a concrete implementation spec, review that spec from multiple perspectives, refine it over one or more cycles, and ask for approval before any write-capable implementers run.

Conceptually, this merges the current `product-spec` / `implementation-plan` room behavior into the implementation flow:

```text
objective
  -> spec room
  -> spec synthesis
  -> spec critique
  -> revised spec
  -> approval gate
  -> task plan
  -> task worktrees
  -> implementers
  -> validation
```

The implementation command should feel like:

```sh
commands-com implement "add resumable task worktrees" --test "npm test"
```

Default behavior:

- draft a spec
- run spec reviewers
- revise until the spec is clear enough or the spec cycle cap is reached
- write the final spec to the run directory
- ask for approval before applying edits
- after approval, plan tasks and run implementers

Possible approval options:

```sh
--approve-spec
--spec-only
--max-spec-cycles 3
--no-spec-review
```

The approval gate is important because implementation objectives can change product behavior. The CLI should not silently convert a vague request into broad code edits.

Suggested spec artifact layout:

```text
cycle-1/
  spec/
    draft.md
    reviewers/
      product.md
      architecture.md
      test-strategy.md
      risk.md
    synthesis.md
    revised.md
    approval.json
```

Suggested `approval.json` shape:

```json
{
  "state": "approved",
  "approvedAt": "2026-04-24T20:00:00.000Z",
  "approvedBy": "cli",
  "specPath": "cycle-1/spec/revised.md"
}
```

For non-interactive use, `--spec-only` should stop after the spec and exit cleanly. CI or scripted use can pass `--approve-spec` only when the caller intentionally wants edits without an interactive prompt.

## Proposed Execution Model

### 1. Establish a Base Snapshot

At the start of a fix cycle, record:

- `baseRef`
- `baseSha`
- `integrationWorkspace`
- current repo status
- cycle number

If `--worktree` is set, the integration workspace is the existing isolated worktree. Otherwise, it is the current repo.

Task worktrees should branch from the same `baseSha` or from the current integration workspace snapshot for that cycle. The safer default is `baseSha`, then apply task diffs back into the integration workspace explicitly.

### 2. Produce or Load the Approved Spec

For `review --fix` and `quality --fix`, this spec may be the synthesis plus prior findings. For standalone `implement`, this should be a first-class reviewed spec artifact.

The task planner should consume the approved spec, not the raw objective.

### 3. Plan Tasks

The orchestrator returns task records:

```json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Extract provider runner",
      "files": ["src/providers.js", "src/provider-runner.js"],
      "instructions": "Move process execution behind a provider runner module."
    }
  ]
}
```

The CLI still sanitizes:

- task IDs
- file paths
- duplicate file ownership
- `.commands-com` paths
- absolute paths
- path traversal

Unknown or overlapping file ownership should serialize or require manual approval.

### 4. Create Task Worktrees

For each task, create:

```text
.commands-com/worktrees/<run-id>/<cycle>/<task-id>/
```

Each task worktree gets:

- the same base commit
- the same repo-relative cwd scope
- only that task prompt
- write-capable provider tools

The task prompt should say:

- this task owns only its assigned files
- other tasks are running elsewhere
- do not edit files outside the assignment
- stop and explain if the assignment is incomplete

### 5. Run Implementers

Each task writes artifacts:

```text
cycle-1/tasks/task-3/
  status.json
  prompt.md
  output.md
  error.md
  attempts/
    attempt-1-error.md
  worktree-path.txt
  diff.patch
  diff-stat.txt
```

Suggested `status.json` shape:

```json
{
  "id": "task-3",
  "title": "Extract provider runner",
  "state": "succeeded",
  "attempt": 2,
  "provider": "codex",
  "worktree": ".commands-com/worktrees/run/cycle-1/task-3",
  "files": ["src/providers.js", "src/provider-runner.js"],
  "startedAt": "2026-04-24T20:00:00.000Z",
  "completedAt": "2026-04-24T20:05:00.000Z",
  "baseSha": "abc123",
  "diffPath": "cycle-1/tasks/task-3/diff.patch"
}
```

States:

- `planned`
- `running`
- `succeeded`
- `failed`
- `skipped`
- `merged`
- `merge-conflict`
- `validation-failed`

### 6. Validate Task Diffs

After an implementer succeeds, inspect the task worktree diff.

Validation should check:

- diff is non-empty when a task claims success
- changed files are inside the assigned `files` list
- no `.commands-com` files are included
- no generated run artifacts are included
- task worktree is based on the expected `baseSha`

If a task edits outside its ownership, mark it `validation-failed` and do not merge it automatically.

### 7. Merge or Apply Diffs

The integration step should apply each task diff into the integration workspace.

Possible strategies:

- `git apply --3way <task.patch>`
- `git merge --no-ff <task-branch>`
- `git cherry-pick <task-commit>`

Recommended first implementation:

1. Capture task diff with `git diff`.
2. Apply with `git apply --3way`.
3. If clean, mark task `merged`.
4. If conflict, mark task `merge-conflict` and stop or continue with non-conflicting tasks based on a flag.

Even when the orchestrator claims file ownership is disjoint, the CLI should verify. The merge layer is the safety net.

### 8. Run Validation

After merged task diffs are applied:

- run `--test` if provided
- collect post-implementation context
- re-run review or quality

If validation fails, feed the failure into the next cycle as prior findings.

## Resume Semantics

Add:

```sh
commands-com review --resume <run-id>
commands-com quality --resume <run-id>
```

Resume should:

- load run metadata
- load cycle/task statuses
- skip tasks marked `merged`
- retry tasks marked `failed`, `validation-failed`, or `merge-conflict` only when safe
- avoid rerunning completed provider audits unless explicitly requested
- preserve original provider/model/options unless overridden

Useful resume flags:

```sh
--resume <run-id>
--rerun-task <task-id>
--skip-task <task-id>
--retry-failed
--merge-only
--keep-task-worktrees
```

Default resume behavior should be conservative:

- do not overwrite successful task outputs
- do not delete failed task worktrees
- do not merge a diff with conflicts
- do not retry a task with uncommitted task-worktree changes unless the retry creates a fresh worktree

## Retry Semantics

Provider-call retries are useful for transient failures. Task-level retries are safer when each attempt can use a fresh worktree.

Recommended behavior:

```text
attempt 1 -> task worktree A -> transient failure
attempt 2 -> fresh task worktree B -> success
```

Keep both attempts:

```text
cycle-1/tasks/task-3/attempts/1/
cycle-1/tasks/task-3/attempts/2/
```

This avoids retrying over unknown partial edits.

## CLI UX

Example output:

```text
[quality] cycle 1: implementation plan (6 task(s), 1 batch(es), cap 15)
[quality] cycle 1: task worktrees (6)
[quality] cycle 1: implementers batch 1/1 (6 task(s))
[quality] cycle 1: task-1 succeeded
[quality] cycle 1: task-2 retry 1/1 after transient codex failure
[quality] cycle 1: task-2 succeeded
[quality] cycle 1: applying task diffs
[quality] cycle 1: merged 6/6 task diffs
[quality] cycle 1: npm test
```

Failure output:

```text
[quality] cycle 1: task-4 failed
[quality] resume: commands-com quality --resume 20260424-...
[quality] artifact: .commands-com/runs/.../cycle-1/tasks/task-4/error.md
```

## Run Layout

Proposed layout:

```text
.commands-com/
  runs/
    <run-id>/
      metadata.json
      context.md
      cycle-1/
        synthesis.md
        implementation-plan.md
        tasks.json
        tasks/
          task-1/
            status.json
            prompt.md
            output.md
            diff.patch
            diff-stat.txt
            worktree-path.txt
            attempts/
              1/
                status.json
                output.md
                error.md
          task-2/
            status.json
        merge/
          task-1.apply.log
          task-2.apply.log
        test.log
        post-implementation-context.md
  worktrees/
    <run-id>/
      cycle-1/
        task-1/
        task-2/
```

## Safety Rules

- Never merge a task diff that edits outside assigned files without explicit approval.
- Never merge `.commands-com` artifacts from task worktrees.
- Never assume file ownership is clean just because the orchestrator said so.
- Do not auto-delete failed task worktrees.
- Prefer fresh worktrees for retries.
- Continue to respect dirty-tree protection.
- Preserve `--worktree` as the safest integration workspace mode.

## LangGraph Fit

LangGraph is not required to build the primitive. The primitive is:

- task worktrees
- task status files
- task diffs
- merge/apply status
- resume behavior

LangGraph becomes valuable if the hand-rolled control flow grows into a workflow runtime:

- formal state machine
- durable node checkpoints
- human approval interrupts
- conditional branching
- workflow inspection
- UI-friendly run graph

Suggested sequencing:

1. Build the spec loop and approval gate for standalone implementation.
2. Build task worktrees and task status files.
3. Add `--resume`.
4. Add task diff apply/merge checks.
5. Add per-task retry using fresh worktrees.
6. Re-evaluate LangGraph once the state machine is clear.

If the workflow remains simple, plain run artifacts are enough. If we add human gates, branching retries, partial merges, and visual run inspection, LangGraph starts to earn its keep.

## Implementation Plan

Phase 0: spec-first implementation

- Add an `implement` command or implementation mode.
- Draft a spec from the objective.
- Run spec reviewers using the room machinery.
- Synthesize and revise the spec.
- Add `--spec-only`, `--approve-spec`, and `--max-spec-cycles`.
- Require approval before write-capable implementers run.

Phase 1: task state model

- Add `tasks.json`.
- Add per-task `status.json`.
- Add status helpers for reading/writing task state.
- Keep current shared-workspace execution.

Phase 2: task worktrees

- Create worktree per task.
- Run implementer in the task worktree.
- Capture `diff.patch` and `diff-stat.txt`.
- Preserve task worktrees on failure.

Phase 3: merge/apply

- Apply successful task diffs into the integration workspace.
- Detect out-of-scope edits.
- Detect conflicts.
- Record merge logs.

Phase 4: resume

- Add `--resume <run-id>`.
- Skip merged tasks.
- Retry failed tasks in fresh worktrees.
- Re-run validation and re-review from the last safe checkpoint.

Phase 5: polish

- Add `--rerun-task`, `--skip-task`, and `--merge-only`.
- Improve terminal summaries.
- Add docs and examples.
- Decide whether LangGraph is worth introducing.

## Open Questions

- Should `implement` be a new command, or should `room implementation-plan` evolve into it?
- Which spec reviewers are required by default: product, architecture, test strategy, risk, docs?
- Should approval be interactive by default, or should non-interactive terminals stop with `--spec-only` style output?
- Can `review --fix` and `quality --fix` skip the spec loop because synthesis is already a scoped spec, or should large fixes still require an approval gate?
- Should task worktrees branch from the original cycle base or from the integration workspace after prior successful merges?
- Should task implementers commit their changes, or should the CLI capture raw diffs only?
- Should the default on one task failure be stop-all, merge-successes, or ask?
- How strict should out-of-scope file edits be when a task discovers a necessary shared helper?
- Should `--worktree` create one integration worktree plus task worktrees, or should task worktrees apply directly back to the original repo when dirty-tree checks pass?
- How much of `--resume` should work without provider CLIs installed?
