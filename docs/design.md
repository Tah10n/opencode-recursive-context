# Design

`opencode-recursive-context` exposes a narrow context API instead of a general
execution environment.

## Non-goals

- No shell execution.
- No generated-code REPL.
- No network access.
- No writes.
- No semantic indexing daemon.

## Operating pattern

1. `context_outline` maps the worktree and local guidance.
2. `context_files` narrows the file surface.
3. `context_search` finds literal evidence.
4. `context_read` reads bounded line ranges.
5. The orchestrator delegates semantic checks to read-only subagents.

The plugin is a capability layer. Agent prompts decide when and how to use it.

## Package shape

The runtime package exports compiled JavaScript from `dist/index.js` and
TypeScript declarations from `dist/index.d.ts`. Source files remain in the npm
package for reviewability, but consumers should use the package export rather
than importing `src/index.ts` directly.

## Verification

`npm run verify` is the publication gate. It runs type-checking, builds the
plugin, executes the Node.js tests, and dry-runs the npm package contents.
