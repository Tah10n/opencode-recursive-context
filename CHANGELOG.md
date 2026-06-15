# Changelog

All notable changes to this project are documented here.

## Unreleased

- Added `context_map`, `context_batch_read`, `context_symbols`, and
  `context_related` read-only tools.
- Extended `context_search` with `pathContains`, `extensions`, and
  `contextLines`.
- Added multi-project isolation tests for identical relative paths across
  different worktrees.
- Hardened direct read paths so generated, dependency, cache, and VCS
  directories are refused consistently.
- Applied `context_search` path and extension filters before the file scan
  limit, and enforced `context_related.maxResults` across all result groups.
- Documented the Recursive Language Models inspiration from
  [alexzhang13/rlm](https://github.com/alexzhang13/rlm).
- Added an agent prompt example for broad repository audits.
- Removed absolute worktree paths from `context_outline` output.
- Updated `@opencode-ai/plugin` to `1.17.7`.

## 0.1.0

- Initial release with read-only `context_outline`, `context_files`,
  `context_search`, and `context_read` tools.
- Added worktree confinement, realpath checks, symlink escape rejection,
  secret-like path refusal, binary-like file refusal, and bounded output.
- Added TypeScript build output, Node.js tests, CI, security notes, and npm
  package dry-run verification.
