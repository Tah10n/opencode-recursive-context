# opencode-recursive-context

High-assurance read-only recursive context tools for OpenCode agents.

`opencode-recursive-context` is based on the ideas from
[alexzhang13/rlm](https://github.com/alexzhang13/rlm), but it deliberately does
not expose a Python or JavaScript REPL. Instead, it gives agents bounded tools
for mapping, searching, fingerprinting, and reading a worktree without dumping
the whole project into the root conversation.

The goal is simple: map first, read only the relevant slices, compare hashes or
fingerprints when stale context matters, delegate narrow checks when needed, and
keep the root model focused on decisions.

For the host orchestration profile that decides when these read-only context
tools should be used, see
[`opencode-harness`](https://github.com/Tah10n/opencode-harness).

## What It Provides

| Tool | Use it for | Safety bounds |
| --- | --- | --- |
| `context_outline` | A compact worktree outline, enabled tool list, and local guidance hints. | Returns schema v2 metadata, relative paths, and no absolute worktree path. |
| `context_map` | A project map with guidance, manifests, CI files, languages, roles, directories, and optional symbol samples. | Recomputes from the current worktree for each call and reports coverage/fingerprints. |
| `context_files` | Scoped file inventories before choosing focused reads. | Skips VCS, dependency, generated, cache, and secret-like paths; returns a metadata fingerprint. |
| `context_search` | Literal evidence search with optional path, extension, and context-line filters. | Skips large, unreadable, binary-like, and secret-like files; returns per-file content hashes and truncation reasons. |
| `context_batch_read` | Multiple bounded line-range reads in one call. | Applies per-file safety checks, expected hash checks, total byte/line caps, and consistency metadata. |
| `context_read` | Line-bounded reads of specific text files. | Confines paths to the worktree and rejects traversal, symlink/junction escapes, oversized files, malformed UTF-8, binary-like files, and secret-like paths. |
| `context_symbols` | Heuristic symbol discovery for TypeScript, JavaScript, Python, and Java. | Uses deterministic text patterns, no runtime language server or index; reports unsupported-language coverage. |
| `context_related` | Heuristic related-file discovery for imports, imported-by files, likely tests, siblings, and same-basename files. | Resolves only within the current worktree and reports evidence/confidence per relation. |

## Requirements

- Node.js 22.22.2 or newer on the Node 22 release line, Node.js 24.15.0 or
  newer on the Node 24 release line, or Node.js 26 and newer.
- OpenCode with the `@opencode-ai/plugin` API compatible with this package.

## Quick Start

From this repository checkout:

```sh
npm ci
npm run build
npm run verify
```

After publishing the package, install it where your OpenCode configuration loads
plugins:

```sh
npm install opencode-recursive-context
```

During local development, point OpenCode at the built package output after
running `npm run build`. The package export is `dist/index.js`.

## OpenCode Setup

Add this package to your OpenCode plugin list using the plugin format supported
by your installed OpenCode version. The default toolset is `minimal`:

- `context_outline`
- `context_files`
- `context_search`
- `context_read`

Use `toolset: "advanced"` or an explicit `enabledTools` allowlist when an agent
also needs map, batch-read, symbols, and related-file tools. Then grant only the
exposed tools to agents that need broad read-only repository context.

Typical advanced agent tool permissions:

```yaml
tools:
  context_outline: allow
  context_map: allow
  context_files: allow
  context_search: allow
  context_batch_read: allow
  context_read: allow
  context_symbols: allow
  context_related: allow
```

The host OpenCode profile decides which agents receive these tools and when they
should use them. This package only exposes the capability layer.

See [docs/plugin-options.md](docs/plugin-options.md) for toolsets, host
ceilings, and additive path policy options.

## Output and Consistency

JSON tool results use schema version 2 and include:

- `schemaVersion`, `tool`, `worktree: "."`, and `scope`;
- `snapshot` fingerprints for metadata or content observed during the call;
- `coverage` counters and detailed truncation flags;
- applied `limits` and actual `usage`;
- tool-specific results.

`context_read` keeps text output by default for compatibility. Set
`format: "json"` to receive hashes, selected range metadata, UTF-8 encoding,
before/after file metadata, and read-stability fields.

For stale-context protection, use `expectedSha256` on reads and
`expectedSnapshotFingerprint` on `context_search`. Broad tools also accept
`verifySnapshot` and `requireStableSnapshot`.

Reference docs:

- [docs/output-schema.md](docs/output-schema.md)
- [docs/snapshot-consistency.md](docs/snapshot-consistency.md)
- [docs/tool-limits.md](docs/tool-limits.md)
- [docs/semantic-coverage.md](docs/semantic-coverage.md)
- [docs/plugin-options.md](docs/plugin-options.md)

## Agent Prompt Example

Use this instruction block in an OpenCode agent that should rely on the
recursive-context tools during broad repository reviews:

```md
When auditing a large repository, map the worktree before reading files
directly.

1. Call `context_outline` or `context_map` first to identify local guidance,
   manifests, CI files, source/test directories, and likely entry points.
2. Use `context_related` and `context_symbols` to find connected files before
   reading broad areas of the tree.
3. Use `context_search` for literal evidence, with `pathContains`,
   `extensions`, and `contextLines` when they reduce noise.
4. Use `context_batch_read` for several focused ranges, or `context_read` for a
   single focused range. Use `format: "json"` when you need hashes or
   consistency metadata.
5. Compare `snapshot.fingerprint` or `sha256` when verifying that later reads
   refer to the same observed state.
6. Treat `context_symbols` and `context_related` as heuristic orientation, not
   complete semantic analysis.
7. Do not use these tools to read secret-like paths, generated directories,
   dependency directories, or unrelated files.
8. Report findings with file paths, line references, evidence, and any remaining
   verification gaps.
```

## Multiple Projects

The plugin is stateless across tool calls. Each tool derives the current root
from the OpenCode host context (`context.worktree || context.directory`) and
recomputes inventories, symbols, maps, and related-file groups for that root.

This means a user can work with many unrelated projects as long as the OpenCode
host supplies the correct worktree for each session. The plugin never stores a
global "last project", persistent index, related-file graph, or symbol cache.
Outputs use `worktree: "."` plus relative paths, so they do not expose absolute
local paths or user names.

## Safety Model

- Read-only tools only.
- No shell execution.
- No generated-code REPL.
- No network access.
- No writes.
- No persistent cache or global mutable project state.
- Paths are confined to the current OpenCode worktree.
- Real paths are checked so symlinks or junctions cannot escape the worktree.
- Common dependency, generated, cache, and VCS directories are skipped.
- Secret-like files and paths are refused before reading.
- Secret protection is path/name based; it is not content DLP.
- Files must be valid UTF-8 text. NUL bytes, malformed UTF-8, and
  control-heavy binary-like content are refused.
- File count, file size, total bytes, total lines, matches, batch ranges,
  directories, and duration are bounded by host ceilings.

See [docs/security.md](docs/security.md) for the detailed security notes.

## Development

Install dependencies and run the full verification suite:

```sh
npm ci
npm run verify
```

Useful scripts:

- `npm run build` - compile TypeScript from `src` to `dist`.
- `npm run typecheck` - type-check without emitting files.
- `npm test` - build and run the Node.js test suite.
- `npm run pack:check` - dry-run the npm package contents.
- `npm run verify` - run typecheck, tests, and package dry-run.

Keep the plugin read-only. Changes that add writes, shell execution, network
access, package installation, or background indexing should be treated as a
different plugin with a different threat model.

## Package Contents

The package entrypoint is `dist/index.js`, with TypeScript declarations emitted
to `dist/index.d.ts`. The npm package includes:

- `dist`
- `src`
- `docs`
- `README.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `LICENSE`

## Release Checklist

Before publishing or pushing a release branch:

```sh
npm ci
npm run verify
npm audit --audit-level=moderate --cache .cache/npm
npm pack --dry-run --json --cache .cache/npm
```

Repository metadata is configured in `package.json`; update it if the GitHub
repository moves. Do not bump the package version without a release decision.

## Acknowledgements

The project is based on the Recursive Language Models concept and article from
[alexzhang13/rlm](https://github.com/alexzhang13/rlm). This implementation keeps
the recursive-context idea while replacing general code execution with bounded,
read-only OpenCode tools.
