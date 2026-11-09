import {
  ArrowRight,
  Copy,
  Minus,
  Pencil,
  Plus,
  Replace,
  TriangleExclamationPoint,
  type LucideIcon,
} from 'lucide-react'
import { STATUS_LETTERS, letterFromStatus, type FileStatus } from '../lib/paths'
import { AppIcon } from './IconSvg'

const ICONS: Record<string, LucideIcon> = {
  M: Pencil,
  A: Plus,
  D: Minus,
  R: ArrowRight,
  C: Copy,
  U: TriangleExclamationPoint,
  T: Replace,
  N: Plus,
  '?': Plus,
  '!': TriangleExclamationPoint,
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
  return <AppIcon className={className} icon={ICONS[code] ?? Pencil} size={14} />
}
