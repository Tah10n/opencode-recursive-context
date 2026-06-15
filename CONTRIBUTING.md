# Contributing

Thanks for helping improve `opencode-recursive-context`.

## Development workflow

```sh
npm ci
npm run verify
```

`npm run verify` is the required local gate. It runs type-checking, builds the
plugin, executes the Node.js tests, and dry-runs the npm package contents.

## Security expectations

This plugin must stay read-only:

- No shell execution.
- No generated-code REPL.
- No network access.
- No writes.
- No background indexing.

Changes touching path handling, file walking, search output, secret-like path
rules, symlink handling, or binary detection need regression tests.

## Pull requests

Keep changes focused. Include tests for behavioral changes and update
documentation when user-facing behavior, package shape, or safety boundaries
change.
