# Changelog

All notable changes to this project are documented here.

## Unreleased

- Added schema version 2 JSON envelopes with `tool`, `worktree`, `scope`,
  `snapshot`, `coverage`, `limits`, and `usage` metadata.
- Added metadata/content fingerprints, optional snapshot verification, and
  `expectedSnapshotFingerprint` support for `context_search`.
- Added full-file SHA-256 reporting and `expectedSha256` mismatch handling for
  `context_read` and `context_batch_read`.
- Added read-stability checks using read-only handles, before/after metadata,
  one retry for changing files, fatal UTF-8 decoding, and stronger binary
  heuristics.
- Added hard aggregate host ceilings, caller-only-lowerable limits, deadlines,
  abort handling, and detailed truncation flags.
- Added toolsets (`minimal`, `advanced`, `all`, `none`) and explicit
  `enabledTools` exposure control. The default toolset is now `minimal`.
- Added additive plugin policy options for extra ignored directories and
  secret-like paths.
- Extended `context_symbols` and `context_related` with heuristic coverage,
  evidence/confidence metadata, and documented unsupported semantics.
- Expanded tests for schema metadata, hashes, stale snapshots, limits, tool
  exposure, encoding/binary handling, abort/deadline behavior, additive policy,
  and multi-worktree fingerprint isolation.
- Added documentation for output schema, snapshot consistency, tool limits,
  semantic coverage, and plugin options.
- Updated CI to run on Ubuntu and Windows for Node 22 and Node 24.
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
- Reworked link escape coverage to use Windows-compatible directory junctions
  and verify resolved ignored-directory targets.
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
