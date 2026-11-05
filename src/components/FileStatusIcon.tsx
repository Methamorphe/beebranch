import { STATUS_LETTERS, letterFromStatus, type FileStatus } from '../lib/paths'

const PATHS: Record<string, string[]> = {
  M: ['m12 3 3 3-8 8-4 1 1-4z', 'M10 5l3 3'],
  A: ['M12 5v14M5 12h14'],
  D: ['M5 12h14'],
  R: ['M4 12h16', 'm14 6 6 6-6 6'],
  C: ['M8 8h13v13H8z', 'M16 8V3H3v13h5'],
  U: ['m12 3 10 18H2z', 'M12 9v5', 'M12 17v.1'],
  T: ['M4 7h16M9 7v10M15 7v10'],
  N: ['M12 5v14M5 12h14'],
  '?': ['M12 5v14M5 12h14'],
  '!': ['m12 3 10 18H2z', 'M12 9v5', 'M12 17v.1'],
}

/** Git letter used to pick the file-status icon. */
export function statusIconCode(kind?: string, letter?: string) {
  if (letter) {
    return letterFromStatus(letter)
  }
  if (kind && kind in STATUS_LETTERS) {
    return STATUS_LETTERS[kind as FileStatus]
  }
  if (kind === 'untracked') return 'N'
  if (kind === 'unmerged') return 'U'
  if (kind === 'typeChanged') return 'T'
  return letterFromStatus(kind ?? 'M')
}

/** Pencil / plus / minus (and kin) for a file change, tinted by the parent. */
export function FileStatusIcon({
  kind,
  letter,
  className,
}: {
  kind?: string
  letter?: string
  className?: string
}) {
  const code = statusIconCode(kind, letter)
  const paths = PATHS[code] ?? PATHS.M
  return (
    <svg
      className={className}
      data-mark="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
