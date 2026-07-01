# Snapshot Consistency

The plugin has no persistent index and does not run `git`. All consistency data
comes from the filesystem during the current tool call.

## Metadata Fingerprints

Inventory-style tools compute a SHA-256 over sorted metadata entries:

- relative path
- file type
- size
- mtime
- file identity when the platform exposes it

Tools using metadata fingerprints include `context_outline`, `context_files`,
and `context_map`.

## Content Fingerprints

Tools that read content compute full-file SHA-256 values and then a request
fingerprint over:

- relative path
- content SHA-256
- selected range when applicable

If coverage is partial, the snapshot uses `fingerprintKind:
"partial-content"` and `complete: false`.

## Snapshot Verification

Broad tools accept:

- `verifySnapshot`
- `requireStableSnapshot`

`verifySnapshot` runs a second bounded metadata pass over the same scope after
the main operation. If fingerprints differ, `snapshot.changedDuringOperation`
is `true` and coverage marks `snapshotChanged`.

`requireStableSnapshot` implies verification. If the second pass differs, the
tool returns `ok: false` and `error: "stale-snapshot"`.

## Expected Fingerprints and Hashes

`context_search` accepts `expectedSnapshotFingerprint` and returns
`snapshot-mismatch` if the observed metadata fingerprint differs.

When `expectedSnapshotFingerprint` is supplied without an explicit `maxFiles`,
`context_search` uses the default `context_files` inventory limit so a default
`context_files` snapshot can be checked without a false mismatch. For larger
inventories, pass matching `limit`/`maxFiles` values to the inventory and search
calls.

`context_read` and `context_batch_read` accept `expectedSha256`. Mismatches are
explicit failures and do not return stale content as successful results.

## Limitations

Fingerprints are consistency observations, not security credentials. A changed
fingerprint tells the caller to refresh context; it is not an authorization
token or tamper-proof attestation.
