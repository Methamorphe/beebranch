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
