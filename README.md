# opencode-recursive-context

Safe read-only context tools for OpenCode agents.

This plugin is RLM-inspired, but it is deliberately not a Python or JavaScript
REPL. It gives agents bounded ways to inspect a worktree without dumping the
whole project into the root conversation:

- `context_outline` - compact worktree outline and local guidance hints.
- `context_files` - scoped file inventory.
- `context_search` - literal text search with bounded excerpts.
- `context_read` - line-bounded text reader.

The goal is to support recursive-context orchestration: map first, read only
the relevant slices, delegate narrow read-only checks, and keep the root model
focused on decisions.

## Requirements

- Node.js 22 or newer.
- OpenCode with the `@opencode-ai/plugin` API compatible with this package.

## Usage

Install this package as an OpenCode plugin, then add it to the relevant
OpenCode plugin list for the agents that should receive the `context_*` tools.
During local development, load the package from this repository after running
`npm run build`.

The host OpenCode profile decides which agents receive these tools and when
they should use them. This package only exposes the read-only capability layer.

## Safety model

- Read-only tools only.
- Paths are confined to the current OpenCode worktree.
- Real paths are checked so symlinks or junctions cannot escape the worktree.
- Common dependency, generated, cache, and VCS directories are skipped.
- Secret-like files and paths are refused before reading.
- Binary-like files are refused.
- File count, file size, line count, and match text are bounded.

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

## Publishing

Before publishing or pushing a release branch:

```sh
npm ci
npm run verify
```

The package entrypoint is `dist/index.js`, with TypeScript declarations emitted
to `dist/index.d.ts`. The npm package includes `dist`, `src`, `docs`,
`README.md`, `SECURITY.md`, and `LICENSE`.
