# Changelog

All notable changes to this project are documented here.

## Unreleased

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
