/**
 * Branch list model for the left-hand navigation panel.
 *
 * Local and remote branches are returned separately, sorted, with the current
 * branch pinned on top of the local group. Symbolic refs (`origin/HEAD`) are
 * dropped: they name no branch of their own and would duplicate one.
 */

import type { RefEntry } from '../types/git'

export type BranchGroups = {
  local: RefEntry[]
  remote: RefEntry[]
}

export function filterBranches(
  entries: RefEntry[],
  query: string,
  current: string | null = null,
): BranchGroups {
  const needle = query.trim().toLowerCase()
  const local: RefEntry[] = []
  const remote: RefEntry[] = []
  for (const entry of entries) {
    if (entry.symref) {
      continue
    }
    if (entry.kind === 'branch') {
      if (needle && !entry.name.toLowerCase().includes(needle)) {
        continue
      }
      local.push(entry)
    } else if (entry.kind === 'remoteBranch') {
      const name = entry.name.toLowerCase()
      const remoteName = (entry.remote ?? '').toLowerCase()
      if (needle && !name.includes(needle) && !remoteName.includes(needle)) {
        continue
      }
      remote.push(entry)
    }
  }
  const byName = (a: RefEntry, b: RefEntry) => a.name.localeCompare(b.name)
  local.sort((a, b) => {
    if (a.name === current) return -1
    if (b.name === current) return 1
    return byName(a, b)
  })
  remote.sort(byName)
  return { local, remote }
}
