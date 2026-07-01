# Output Schema

JSON tool results use `schemaVersion: 2`.

Top-level fields:

- `schemaVersion`: output schema version.
- `tool`: stable tool id.
- `worktree`: always `"."`; absolute roots are not returned.
- `scope`: requested path plus relevant filters.
- `snapshot`: fingerprint metadata for observed files.
- `coverage`: counters and truncation flags.
- `limits`: applied host/caller limits.
- `usage`: files, directories, bytes, lines, matches, and ranges used.
- `truncated`: legacy boolean derived from `coverage.partial`.

`context_read` keeps text output by default. Set `format: "json"` to receive
the schema envelope.

## Snapshot

`snapshot` includes:

- `fingerprint`
- `fingerprintKind`: `metadata`, `content`, or `partial-content`
- `fingerprintScope`
- `complete`
- `stable`
- `changedDuringOperation`
- optional `beforeFingerprint` and `afterFingerprint`
- `truncationReasons`

Fingerprints are observation tokens for consistency checks. They are not
security credentials.

## Coverage

`coverage` includes:

- `candidateFiles`
- `scannedFiles`
- `bytesScanned`
- `skippedSecret`
- `skippedGenerated`
- `skippedLarge`
- `skippedUnreadable`
- `unsupportedLanguages`
- `truncation`
- `truncationReasons`
- `partial`

Detailed truncation flags separate inventory limits, match limits, line/byte
limits, deadline limits, excerpt truncation, context-line truncation, symbol and
relationship limits, and snapshot changes. The legacy `truncated` top-level
field is derived from `coverage.partial`.

`coverage.partial` is also true when candidate files are unreadable, binary-like,
malformed UTF-8, or too large to scan. This prevents complete-looking negative
results when part of the requested scope could not be inspected.

## Read Results

`context_read` JSON and each successful `context_batch_read` item include:

- `sha256`: full-file SHA-256.
- `bytes`
- `totalLines`
- `selectedRange`
- `encoding`: `utf-8` or `utf-8-bom`
- `stableDuringRead`
- `metadataBefore`
- `metadataAfter`
- `truncatedBefore`
- `truncatedAfter`
- bounded `text`

If `expectedSha256` mismatches, the result is `ok: false`,
`error: "hash-mismatch"`, and includes `actualSha256` without returning file
content.
