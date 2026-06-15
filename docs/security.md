# Security Notes

This plugin is intended for safe broad context gathering.

Important constraints:

- Use `fs.realpath` on roots and targets.
- Reject real paths outside the current worktree.
- Skip symbolic links during directory walks.
- Refuse secret-like path segments before opening a file.
- Refuse binary-like files.
- Bound file count, file size, line count, and match text.
- Keep project state request-local; do not store inventories, symbols, related
  graphs, or last-root values globally.
- Return relative paths only. Do not expose absolute worktree paths.

The regression tests cover traversal rejection, symlink escape rejection,
secret-like path refusal, binary-like file refusal, generated directory skips,
case-sensitive search behavior, bounded search excerpts, new read-only mapping
tools, and multi-project isolation across identical relative paths.

If a future change adds writes, shell execution, network access, or package
installation, persistent caching, or background indexing, treat it as a
different plugin with a different threat model.
