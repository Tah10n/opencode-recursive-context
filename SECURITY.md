# Security Policy

`opencode-recursive-context` is intentionally read-only. It should not execute
shell commands, run generated code, write files, install packages, start
background services, or access the network.

## Reporting a vulnerability

Use GitHub private vulnerability reporting if it is enabled for the repository.
If it is not enabled, contact the maintainers through a non-public channel
before sharing exploit details. Do not include real credentials, tokens, private
keys, or customer data in reports or reproduction cases.

## Supported versions

Security fixes are handled on the default branch until the project publishes a
stable release line.

## Local security checks

Run the full local verification suite before publishing or reviewing security
changes:

```sh
npm ci
npm run verify
```

The test suite covers worktree confinement, traversal and absolute-path
rejection, symlink/junction escape rejection, broken link handling, secret-like
path refusal, generated path refusal, malformed UTF-8 and binary-like file
refusal, bounded search excerpts, hash mismatch handling, snapshot fingerprints,
abort/deadline behavior, host ceilings, tool exposure, and multi-worktree
isolation.

## Security boundary

Secret refusal is path/name based, not content DLP. Do not rely on this plugin
to detect credentials stored in ordinary source files. Host permissions,
repository hygiene, and agent tool grants remain required controls.

The plugin is best-effort against filesystem races within Node/platform limits:
reads use read-only handles and compare before/after handle metadata, but no
cross-platform claim is made that every TOCTOU race is impossible.
