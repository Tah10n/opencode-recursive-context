# Design

`opencode-recursive-context` is based on the Recursive Language Models concept
from [alexzhang13/rlm](https://github.com/alexzhang13/rlm). It exposes a narrow
context API instead of a general execution environment.

## Non-goals

- No shell execution.
- No generated-code REPL.
- No network access.
- No writes.
- No semantic indexing daemon.

## Operating pattern

1. `context_outline` or `context_map` maps the current worktree and local guidance.
2. `context_files`, `context_symbols`, and `context_related` narrow the file surface.
3. `context_search` finds literal evidence.
4. `context_batch_read` or `context_read` reads bounded line ranges.
5. The orchestrator delegates semantic checks to read-only subagents.

The plugin is a capability layer. Agent prompts decide when and how to use it.

## Stateless worktree model

Tools derive the root from the OpenCode host context on every call:
`context.worktree || context.directory`. Inventories, project maps, symbols, and
related-file groups are request-local and are not stored globally.

This keeps multiple user projects isolated in the same plugin process. Outputs
use relative paths and `worktree: "."`; absolute worktree paths are not returned.

## Lightweight semantics

`context_symbols` and `context_related` intentionally avoid language servers,
AST dependencies, background indexing, or generated-code execution. They use
bounded file reads plus deterministic filename, import, and symbol patterns for
agent orientation before focused reads.

## Package shape

The runtime package exports compiled JavaScript from `dist/index.js` and
TypeScript declarations from `dist/index.d.ts`. Source files remain in the npm
package for reviewability, but consumers should use the package export rather
than importing `src/index.ts` directly.

## Verification

`npm run verify` is the publication gate. It runs type-checking, builds the
plugin, executes the Node.js tests, including multi-project isolation tests, and
dry-runs the npm package contents.
