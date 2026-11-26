import type { CommitSummary, GraphRow } from '../types/git'

/** Follow ancestry, never lane numbers: lanes are reused throughout history. */
export function graphBranchFocus(commits: CommitSummary[], rows: GraphRow[], tip: string) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const ancestors = new Set<string>()
  const pending = [tip]
  while (pending.length) {
    const sha = pending.pop()!
    if (ancestors.has(sha)) continue
    ancestors.add(sha)
    const commit = bySha.get(sha)
    if (commit) pending.push(...commit.parents)
  }

  // Track highlighted edges separately from nodes. A highlighted rail can
  // pass through an unrelated row, and an unrelated child can join an ancestor.
  let active = new Set<number>()
  const lanes = rows.map((row, index) => {
    const top = active
    const bottom = new Set(top)
    bottom.delete(row.nodeLane)
    for (const lane of row.arrivals) bottom.delete(lane)
    if (ancestors.has(commits[index]?.sha ?? '')) {
      if (commits[index]?.parents.length) bottom.add(row.nodeLane)
      for (const lane of row.departures) bottom.add(lane)
    }
    active = new Set([...bottom].filter((lane) => row.rails.some((rail) => rail.lane === lane && rail.toBottom)))
    return { top, bottom: active }
  })
  return { ancestors, lanes }
}

export type GraphClosestBranch<T> = {
  tip: string
  distance: number
  refs: T[]
}

/**
 * Nearest branch tip that reaches each commit through any parent. Tags stay
 * out: the caller passes only branch-like labels.
 */
export function graphClosestBranches<T>(
  commits: CommitSummary[],
  tips: Iterable<readonly [string, readonly T[]]>,
  keyOf: (item: T) => string,
) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const best = new Map<string, GraphClosestBranch<T>>()
  for (const [tip, refs] of tips) {
    if (refs.length === 0) continue
    const pending: { sha: string; distance: number }[] = [{ sha: tip, distance: 0 }]
    const seen = new Set<string>()
    for (let index = 0; index < pending.length; index += 1) {
      const step = pending[index]!
      if (seen.has(step.sha)) continue
      seen.add(step.sha)
      const current = best.get(step.sha)
      if (!current || step.distance < current.distance) {
        best.set(step.sha, { tip, distance: step.distance, refs: [...refs] })
      } else if (step.distance === current.distance) {
        const keys = new Set(current.refs.map(keyOf))
        const extra = refs.filter((item) => !keys.has(keyOf(item)))
        if (extra.length > 0) {
          best.set(step.sha, { ...current, refs: [...current.refs, ...extra] })
        }
      }
      const commit = bySha.get(step.sha)
      if (!commit) continue
      for (const parent of commit.parents) {
        if (!seen.has(parent)) pending.push({ sha: parent, distance: step.distance + 1 })
      }
    }
  }
  return best
}
