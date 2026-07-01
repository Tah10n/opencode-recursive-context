# Security Notes

This plugin is intended for safe broad context gathering.

Important constraints:

- Use `fs.realpath` on roots and targets.
- Reject real paths outside the current worktree.
- Skip symbolic links during directory walks.
- Refuse secret-like path segments before opening a file.
- Refuse generated, dependency, cache, and VCS paths through one central policy.
- Refuse binary-like files, malformed UTF-8, and control-heavy byte streams.
- Bound file count, directories, file size, total bytes, total lines, matches,
  batch ranges, duration, and match/context text.
- Keep project state request-local; do not store inventories, symbols, related
  graphs, or last-root values globally.
- Return relative paths only. Do not expose absolute worktree paths.
- Report coverage and truncation reasons separately from excerpt truncation.
- Honor `AbortSignal` before and during filesystem operations.

## Secret boundary

Secret protection is primarily path and name policy:

- secret directories such as `.ssh`, `.aws`, `.kube`;
- secret filenames such as `.env`, `.npmrc`, `credentials.json`;
- secret extensions such as `.pem`, `.key`, `.p12`;
- additive host restrictions configured through plugin options.

This is not content DLP. A credential stored in an ordinary file such as
`src/config.ts` can be read if the host grants access and the path is not
classified as secret-like. Repository hygiene and host permissions remain part
of the security boundary. The plugin does not automatically redact source code
content because redaction can hide real defects and distort evidence.

## Read consistency

Direct reads open a file read-only, collect handle metadata before and after
reading bytes, retry once on detected metadata changes, and report
`unstable-read` if the file keeps changing. The implementation uses the
strongest no-follow open behavior available through Node on the current
platform, but it does not claim absolute TOCTOU immunity across all filesystems.

Content is decoded with a fatal UTF-8 decoder. Replacement-character decoding is
not used.

## Regression coverage

The regression tests cover traversal rejection, absolute-path rejection, symlink
and junction escape rejection, broken link handling, secret-like path refusal,
binary and malformed UTF-8 refusal, generated directory skips, bounded search
excerpts, hash mismatch handling, snapshot fingerprints, abort/deadline
behavior, tool exposure, host ceiling enforcement, heuristic symbol/related
coverage, and multi-project isolation across identical relative paths.

If a future change adds writes, shell execution, network access, or package
installation, persistent caching, or background indexing, treat it as a
different plugin with a different threat model.
