/** Split a repository path so the file name survives truncation. */
export function splitPath(path: string) {
  const index = path.lastIndexOf('/')
  return index < 0
    ? { directory: '', name: path }
    : { directory: path.slice(0, index + 1), name: path.slice(index + 1) }
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'

export const STATUS_LETTERS: Record<FileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
}

export const STATUS_LABELS: Record<FileStatus, string> = {
  modified: 'modifié',
  added: 'ajouté',
  deleted: 'supprimé',
  renamed: 'renommé',
  copied: 'copié',
}

const GIT_LETTERS: Record<string, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  C: 'C',
  U: 'U',
  T: 'T',
  '?': '?',
}

/** Status letter from a `git status` code (`M`, `AM`, `?`, …). */
export function letterFromStatus(status: string) {
  return GIT_LETTERS[status.slice(0, 1)] ?? status.slice(0, 1)
}

export function statusLabel(status: string) {
  const letter = letterFromStatus(status)
  switch (letter) {
    case 'M':
      return 'modifié'
    case 'A':
      return 'ajouté'
    case 'D':
      return 'supprimé'
    case 'R':
      return 'renommé'
    case 'C':
      return 'copié'
    case 'U':
      return 'non fusionné'
    case 'T':
      return 'type changé'
    case '?':
      return 'non suivi'
    default:
      return status
  }
}
