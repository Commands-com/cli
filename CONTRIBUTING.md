# Contributing

Thanks for helping shape `commands-com`.

## Development

```sh
npm install
npm test
npm run smoke
```

The mock provider is intentionally part of the product. It keeps tests and docs
fast, deterministic, and usable on machines without an AI CLI installed.

## Product Guardrails

- Report-only behavior should remain the default.
- Any workflow that edits files must require an explicit flag such as `--fix`.
- Dirty-tree edits must stay protected by default.
- Long-running workflows should always write artifacts under `.commands-com/runs`.
- Provider-specific behavior belongs behind a provider adapter, not in command code.

## Before Opening A PR

- Add or update tests for new behavior.
- Run `npm test`.
- Run `npm run smoke`.
- Keep command output stable unless the PR is intentionally changing UX.
