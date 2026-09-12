# Agent guide

## Scope

This is a small TypeScript Pi extension. Keep changes focused; the extension entry point and most behavior live in `index.ts`.

## Workflow

1. Read `README.md`, `package.json`, and the relevant code/tests before changing behavior.
2. Add or update focused tests in `index.test.ts` for observable logic changes.
3. Run the applicable verification commands from `package.json` before finishing.
4. Update `README.md` for user-facing behavior and `CHANGELOG.md` for released-facing changes.

## Conventions

- Use TypeScript with the repository's strict compiler configuration.
- Match the existing tab indentation and double-quote style in TypeScript files.
- Preserve the `todo_write` tool contract: task IDs are assigned by the extension, and at most one task may be `in_progress`.
- Keep session state restoration backward-compatible; include migration coverage when changing persisted task data.
- Treat `package.json` scripts as the source of truth for verification commands.

## Verification

Run the smallest relevant checks first, then run both of these before completing a code change:

```bash
npm test
npm run typecheck
```
