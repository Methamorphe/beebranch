import { t, type MessageKey } from '../i18n'

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

export const STATUS_LABELS: Record<FileStatus, MessageKey> = {
  modified: 'common.fileStatus.modified',
  added: 'common.fileStatus.added',
  deleted: 'common.fileStatus.deleted',
  renamed: 'common.fileStatus.renamed',
  copied: 'common.fileStatus.copied',
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
      return t('common.fileStatus.modified')
    case 'A':
      return t('common.fileStatus.added')
    case 'D':
      return t('common.fileStatus.deleted')
    case 'R':
      return t('common.fileStatus.renamed')
    case 'C':
      return t('common.fileStatus.copied')
    case 'U':
      return t('common.fileStatus.unmerged')
    case 'T':
      return t('common.fileStatus.typeChanged')
    case '?':
      return t('common.fileStatus.untracked')
    default:
      return status
  }
}
