# Security Notes

This plugin is intended for safe broad context gathering.

Important constraints:

- Use `fs.realpath` on roots and targets.
- Reject real paths outside the current worktree.
- Skip symbolic links during directory walks.
- Refuse secret-like path segments before opening a file.
- Refuse binary-like files.
- Bound file count, file size, line count, and match text.

The regression tests cover traversal rejection, symlink escape rejection,
secret-like path refusal, binary-like file refusal, generated directory skips,
case-sensitive search behavior, and bounded search excerpts.

If a future change adds writes, shell execution, network access, or package
installation, treat it as a different plugin with a different threat model.
