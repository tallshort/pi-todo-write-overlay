# Contributing

## Prerequisites

- A supported Node.js LTS release (CI currently uses Node.js 22).
- npm.

## Setup

```bash
npm install
```

## Change workflow

1. Read `AGENTS.md` and inspect the relevant implementation and tests.
2. Keep a change narrowly scoped and retain backward compatibility for persisted session state.
3. Add or update tests for changed behavior.
4. Document user-visible behavior in `README.md` and add an unreleased changelog entry when appropriate.
5. Run the verification suite below.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

`build` currently runs the TypeScript type check because Pi loads the extension's TypeScript source directly.

## Pull requests

Describe the behavior change, testing performed, and any compatibility or configuration impact. Keep generated files and `node_modules/` out of commits.
