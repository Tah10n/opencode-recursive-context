# opencode-recursive-context

Safe read-only context tools for OpenCode agents.

This project is based on the ideas from
[alexzhang13/rlm](https://github.com/alexzhang13/rlm), but it deliberately does
not expose a Python or JavaScript REPL. It gives agents bounded ways to inspect
a worktree without dumping the whole project into the root conversation:

- `context_outline` - compact worktree outline and local guidance hints.
- `context_files` - scoped file inventory.
- `context_search` - literal text search with bounded excerpts.
- `context_read` - line-bounded text reader.

The goal is to support recursive-context orchestration: map first, read only
the relevant slices, delegate narrow read-only checks, and keep the root model
focused on decisions.

## Requirements

- Node.js 22.22.2 or newer on the Node 22 release line, Node.js 24.15.0 or
  newer on the Node 24 release line, or Node.js 26 and newer.
- OpenCode with the `@opencode-ai/plugin` API compatible with this package.

## Usage

Install this package as an OpenCode plugin, then add it to the relevant
OpenCode plugin list for the agents that should receive the `context_*` tools.
During local development, load the package from this repository after running
`npm run build`.

The host OpenCode profile decides which agents receive these tools and when
they should use them. This package only exposes the read-only capability layer.

## Agent Prompt Example

Use this instruction block in an OpenCode agent that should rely on the
recursive-context tools during broad repository reviews:

```md
When auditing a large repository, map the worktree before reading files
directly.

1. Call `context_outline` first to identify local guidance and a representative
   file sample.
2. Use `context_files` to narrow the relevant directories or file groups.
3. Use `context_search` for literal evidence before opening files.
4. Use `context_read` only for focused line ranges that are relevant to the
   current question.
5. Do not use these tools to read secret-like paths, generated directories,
   dependency directories, or unrelated files.
6. Report findings with file paths, line references, evidence, and any remaining
   verification gaps.
```

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

## Acknowledgements

The project is based on the Recursive Language Models concept and article from
[alexzhang13/rlm](https://github.com/alexzhang13/rlm). This implementation keeps
the recursive-context idea while replacing general code execution with bounded,
read-only OpenCode tools.
