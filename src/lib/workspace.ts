/**
 * Canonical spelling of a worktree path, mirroring `RepoId::from_path` in
 * `beebranch-core`. A workspace stores the `fs::canonicalize` output recorded
 * when the repository was added, while an open session reports the path Git
 * discovered. Both may spell the same directory differently on Windows —
 * verbatim prefix, separator style, drive-letter case, trailing separator —
 * so tab reuse compares normalized keys.
 *
 * POSIX paths are returned untouched: a backslash is an ordinary file-name
 * character there, and rewriting it would change the identity of every
 * macOS/Linux repository.
 */
export function normalizeRepoPath(path: string): string {
  const verbatim = path.startsWith('\\\\?\\UNC\\')
    ? `\\\\${path.slice(8)}`
    : path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')
      ? path.slice(4)
      : path

  const hasDrive = /^[A-Za-z]:/.test(verbatim)
  if (!hasDrive && !verbatim.startsWith('\\\\')) {
    return verbatim
  }

  let normalized = verbatim.replace(/\\/g, '/')
  if (hasDrive) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1)
  }
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
