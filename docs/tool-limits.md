# Tool Limits

The plugin enforces hard aggregate limits. Host plugin options define ceilings;
tool arguments can only lower those ceilings.

Limit fields:

- `maxFiles`
- `maxBytesPerFile`
- `maxTotalBytes`
- `maxTotalLines`
- `maxMatches`
- `maxDurationMs`
- `maxDirectories`
- `maxBatchRanges`
- `maxSymbols`
- `maxRelationships`

Every JSON result reports the applied `limits` and actual `usage`.

## Deadlines

Tools use a bounded deadline derived from `maxDurationMs`. The implementation
checks the deadline before and between filesystem operations and inside large
line scans. Deadline failures return `error: "deadline-exceeded"` with partial
coverage marked.

## Cancellation

All tools honor `context.abort` before the operation starts, during directory
walks, before file operations, between files, and inside larger scans. Abort is
reported as `AbortError` and is not counted as an unreadable file.

## Truncation

Detailed truncation flags distinguish:

- inventory limits;
- result and match limits;
- byte and line limits;
- deadline limits;
- excerpt truncation;
- context-before and context-after truncation;
- symbol and relationship limits;
- snapshot changes.

This prevents a shortened match excerpt from looking like an incomplete file
scan, and prevents incomplete coverage from looking like a complete negative
result.

Unreadable, binary-like, malformed UTF-8, and oversized candidate files also
make `coverage.partial` and the legacy `truncated` field true, even when no
inventory or result-count limit was reached.
