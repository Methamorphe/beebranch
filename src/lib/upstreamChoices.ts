/**
 * Candidates for the branch menu's upstream selector.
 *
 * Setting an upstream names which remote copy this local branch tracks
 * (`origin/main`, `github/main`). The selector therefore lists that same
 * branch on each remote, not every remote-tracking ref in the repository.
 */

import type { RefEntry } from '../types/git'

/** Branch name after the remote prefix: `origin/feature/x` → `feature/x`. */
export function remoteTrackingBranchName(entry: RefEntry): string | undefined {
  if (entry.kind !== 'remoteBranch') return undefined
  const remote = entry.remote ?? entry.name.split('/')[0]
  if (!remote) return undefined
  const prefix = `${remote}/`
  if (!entry.name.startsWith(prefix)) return undefined
  const short = entry.name.slice(prefix.length)
  return short.length > 0 ? short : undefined
}

/** True when `upstream` already points at this remote-tracking branch. */
export function isCurrentUpstream(upstream: string | undefined, remote: RefEntry): boolean {
  if (!upstream) return false
  return upstream === remote.fullName || upstream === remote.name
}

/**
 * Remote-tracking branches that are copies of `localName` on a remote.
 * Symbolic refs (`origin/HEAD`) are dropped: they name no branch of their own.
 */
export function upstreamChoices(entries: RefEntry[], localName: string): RefEntry[] {
  return entries
    .filter((entry) => {
      if (entry.kind !== 'remoteBranch' || entry.symref) return false
      const short = remoteTrackingBranchName(entry)
      return short === localName && short !== 'HEAD'
    })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
}
