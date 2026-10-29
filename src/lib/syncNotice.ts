import { plural, t } from '../i18n'
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
    return plural(
      'common.pull.incomplete.one',
      'common.pull.incomplete.other',
      behind,
    )
  }
  const before = outcome?.headBefore
  const after = outcome?.headAfter
  if (before && after) {
    if (before === after) {
      return t('common.pull.upToDate')
    }
    return t('common.pull.range', { before: before.slice(0, 8), after: after.slice(0, 8) })
  }
  return t('common.pull.done')
}
