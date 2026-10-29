import type { SyncOutcome } from '../types/git'

/**
 * Describe what a pull actually did, from the outcome of `sync_pull`.
 *
 * A pull that exits successfully can still integrate nothing ("Already up to
 * date"), so the branch position is reported instead of a bare "terminé".
 * The notice area is narrow: the decisive fact comes first.
 */
export function pullNotice(outcome: SyncOutcome | null | undefined): string {
  const behind = outcome?.behindUpstream
  if (typeof behind === 'number' && behind > 0) {
    return `Pull incomplet : ${behind} commit${behind > 1 ? 's' : ''} encore en retard.`
  }
  const before = outcome?.headBefore
  const after = outcome?.headAfter
  if (before && after) {
    if (before === after) {
      return 'Pull : déjà à jour.'
    }
    return `Pull : ${before.slice(0, 8)} → ${after.slice(0, 8)}.`
  }
  return 'Pull terminé.'
}
