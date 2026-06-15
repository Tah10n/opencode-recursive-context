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

The test suite covers worktree confinement, traversal rejection, symlink escape
rejection, secret-like path refusal, binary-like file refusal, and bounded search
excerpts.
