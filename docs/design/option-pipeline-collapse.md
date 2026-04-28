# Option pipeline collapse — retrospective

This note planned a consolidation of the cycle option pipeline that has
now landed. The previous three-layer pipeline
(`command-option-schema.js` declarations → `command-option-resolver.js`
resolvers → `command-options.js` readers → `mergeResumeOptions` in
`src/cycle-workflow.js`) is collapsed into a single reader boundary at
`src/command-options.js` plus a thin resume-merge step in
`src/cycle-workflow.js`. The persisted run-state field set is unchanged,
so no `RUN_STATE_VERSION` bump was required.

## Where things live now

- **Schema — `src/command-option-schema.js`.** `COMMAND_OPTIONS` remains
  the single declarative source of truth for flag names, scopes,
  aliases, `readWith`, `resumeOverrideFields`, and `resolve` field
  bindings.
- **Reader boundary — `src/command-options.js`.** Owns defaulting
  (per-option `cycleField`/`roomField` `fallback` resolvers),
  parsing/validation (dispatch through `readCommandOptionValue` to the
  right `readWith` reader), and the stored-field filter
  (`filterKnownStoredCycleOptions`) that drops unknown stored fields
  with a single one-line `logger.warn` per stored run before resume
  merge. Exports: `resolveCycleCommandOptions`,
  `resolveRoomCommandOptions`, `projectCycleCommandOptions`,
  `filterKnownStoredCycleOptions`, plus the pre-existing flag helpers.
- **Resume-merge step — `src/cycle-workflow.js`.** `mergeResumeOptions`
  applies the schema-declared `resumeOverrideFields` (via
  `CYCLE_RESUME_OPTION_OVERRIDES`, derived from the schema at module
  load) and the always-next set (`json`, `resume`). It runs as a thin
  policy step on top of the reader's output, after the env/config
  layering and the provider short-circuit
  (`shouldUseResumeProviders` / `resumeProviderOptions`). The deleted
  `src/command-option-resolver.js` is gone; its contents moved into the
  reader.

## Precedence contract (verified)

> **explicit CLI flag > stored resume > env > config > schema default**

Both stages remain — env/config layering via `resolveRuntimeOptions`
AND the explicit-flag override loop in `mergeResumeOptions`. A naive
single-pass `{ ...next, ...stored }` would silently flip CLI and stored
on resume; the override loop restores `nextOptions[field]` whenever the
caller passed the option's flag explicitly.

## Load-bearing invariants pinned by tests

- **Stored providers win on `--resume` unless provider flags are passed
  explicitly.** Cycle-2 regression invariant. Pinned by the
  providerless-resume test in `test/cycle-workflow.test.js`, which
  drives `runCycleWorkflow` end-to-end with `PATH=''` and asserts both
  that stored providers flow through and that
  `observedOptions === state.options` (object identity).
- **Env/config × CLI × stored-resume precedence on `model` and provider
  selection.** Pinned by 5 dedicated tests in
  `test/cycle-workflow.test.js` covering the cross-product of
  `COMMANDS_COM_MODEL` / `--model` / stored-resume model, and the
  no-flag-no-resume `COMMANDS_COM_PROVIDER` path.
- **Schema-derived resume override flags.** `CYCLE_RESUME_OPTION_OVERRIDES`
  is built from each option's `resumeOverrideFields` and verified to
  exclude the always-next fields (`json`, `resume`) by
  `test/cycle-workflow.test.js`.
- **`--max-cycles` fallback ordering.** The `--max-cycles` fallback
  reads already-resolved sibling fields (`fix`, `untilScore`) via the
  `resolveOptionFallback` context, so the reader must preserve schema
  declaration order. Covered by `test/command-option-resolver.test.js`
  and `test/cycle-workflow.test.js`'s mode-recompute test.

## Stale stored fields

The reader filters stored options against the schema before merge.
Fields that no longer appear in `COMMAND_OPTIONS.resolve` (cycle
resolver) or any `resumeOverrideFields` are dropped with a one-line
warning per stored run (e.g.
`resume: ignoring stored field 'foo' (no longer in schema)`). The
persisted run-state field set is preserved, so `RUN_STATE_VERSION`
remains `1`.

## Room vs cycle

The reader exports `resolveRoomCommandOptions` alongside the cycle
resolver. Room callers (`src/rooms.js`) use the room entry point only;
room-specific concepts (`participantLimit`, `synthesize`) do not leak
into cycle code.
