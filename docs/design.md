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
- No persistent project cache or global mutable "last project" state.

## Operating pattern

1. `context_outline` or `context_map` maps the current worktree and local
   guidance.
2. `context_files`, `context_symbols`, and `context_related` narrow the file
   surface.
3. `context_search` finds literal evidence.
4. `context_batch_read` or `context_read` reads bounded line ranges.
5. The orchestrator compares hashes or snapshot fingerprints when stale context
   would matter.
6. The orchestrator delegates semantic checks to read-only subagents.

The plugin is a capability layer. Agent prompts decide when and how to use it.

## Stateless worktree model

Tools derive the root from the OpenCode host context on every call:
`context.worktree || context.directory`. Inventories, project maps, symbols, and
related-file groups are request-local and are not stored globally.

This keeps multiple user projects isolated in the same plugin process. Outputs
use relative paths and `worktree: "."`; absolute worktree paths are not
returned.

## Output model

JSON outputs use schema version 2. Every JSON result includes:

- `schemaVersion`, `tool`, `worktree: "."`, and `scope`;
- `snapshot` with a metadata, content, or partial-content fingerprint;
- `coverage` counters and detailed truncation flags;
- applied `limits` and actual `usage`.

`context_read` keeps text output by default for compatibility. Its JSON mode
uses the same schema envelope.

## Snapshot and read consistency

Inventory tools compute metadata fingerprints from sorted relative path, file
type, size, mtime, and file identity when the platform exposes it. Content tools
hash full file bytes and include selected ranges in content fingerprints.

Broad tools can run request-local second-pass snapshot verification with
`verifySnapshot`; `requireStableSnapshot` turns a detected change into an
explicit `stale-snapshot` failure. The plugin does not run `git`, keep a
background index, or treat fingerprints as security credentials.

Reads open files read-only, stat via the handle before and after the read, retry
once when metadata changes during the read, and then return `unstable-read` if
the file remains unstable. Node/platform no-follow behavior is best effort and
is documented in the security notes.

## Lightweight semantics

`context_symbols` and `context_related` intentionally avoid language servers,
AST dependencies, background indexing, or generated-code execution. They use
bounded file reads plus deterministic filename, import, and symbol patterns for
agent orientation before focused reads.

Symbols are regex-extracted heuristics, not AST parsing. Related-file results
include relationship, evidence, confidence, and language. Unsupported mechanisms
include dynamic dependency injection, reflection, runtime routing, generated
bindings, framework registries, database triggers, RPC service discovery,
non-relative alias resolution, and cross-language links.

## Tool exposure

The default `minimal` toolset exposes only `context_outline`, `context_files`,
`context_search`, and `context_read`. `advanced` and `all` expose the full tool
set. `none` exposes no tools. `enabledTools` is an explicit allowlist and takes
priority over `toolset`.

## Package shape

The runtime package exports compiled JavaScript from `dist/index.js` and
TypeScript declarations from `dist/index.d.ts`. Source files remain in the npm
package for reviewability, but consumers should use the package export rather
than importing `src/index.ts` directly.

## Verification

`npm run verify` is the publication gate. It runs type-checking, builds the
plugin, executes the Node.js tests, including multi-project isolation tests,
snapshot/hash tests, encoding tests, tool exposure tests, and dry-runs the npm
package contents.
