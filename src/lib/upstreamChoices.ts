/**
 * Candidates for the branch menu's upstream selector, and the remotes a push
 * can address without changing that tracking upstream.
 *
 * Setting an upstream names which remote copy this local branch tracks
 * (`origin/main`, `github/main`). The selector therefore lists that same
 * branch on each remote, not every remote-tracking ref in the repository.
 * A push destination is every remote of the repository: the branch can be
 * published there under its own name while the tracking upstream stays put.
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

/** Remote named by a tracking upstream (`refs/remotes/origin/main` → `origin`). */
export function trackingRemoteName(upstream: string | undefined): string | undefined {
  if (!upstream) return undefined
  const short = upstream.replace(/^refs\/remotes\//, '')
  const slash = short.indexOf('/')
  if (slash <= 0 || slash === short.length - 1) return undefined
  return short.slice(0, slash)
}

/** Local branch whose upstream is this remote-tracking ref, when one exists. */
export function localTracking(entries: RefEntry[], remote: RefEntry): RefEntry | undefined {
  return entries.find(
    (entry) => entry.kind === 'branch' && isCurrentUpstream(entry.upstream, remote),
  )
}

/**
 * First branch name that is not already taken. `base` itself, then
 * `base-2`, `base-3`, … A caller that wants a remote suffix puts it in `base`
 * (`feature-upstream`).
 */
export function suggestLocalName(base: string, taken: ReadonlySet<string>): string {
  const cleaned = base.trim() || 'branch'
  if (!taken.has(cleaned)) return cleaned
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${cleaned}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${cleaned}-2`
}

/** One remote that can receive `localName` under that same branch name. */
export type PushDestination = {
  remote: string
  branch: string
  /** `remote/branch`, the ref a push creates or updates. */
  target: string
  /** Remote-tracking ref when this remote already has the branch. */
  existing?: RefEntry
  /** This remote is the branch's configured tracking upstream. */
  tracking: boolean
}

/**
 * Every remote, tracking one first. A remote that does not have the branch
 * yet is still a destination: publishing it is a separate decision from
 * changing the tracking upstream.
 */
export function pushDestinations(
  entries: RefEntry[],
  remotes: readonly string[],
  localName: string,
  upstream: string | undefined,
): PushDestination[] {
  const tracking = trackingRemoteName(upstream)
  const names = [...new Set(remotes.filter((remote) => remote.length > 0))]
  names.sort((left, right) => {
    if (left === tracking) return -1
    if (right === tracking) return 1
    return left.localeCompare(right)
  })
  return names.map((remote) => {
    const existing = entries.find((entry) => {
      if (entry.kind !== 'remoteBranch' || entry.symref) return false
      return entry.remote === remote && remoteTrackingBranchName(entry) === localName
    })
    return {
      remote,
      branch: localName,
      target: `${remote}/${localName}`,
      existing,
      tracking: remote === tracking,
    }
  })
}

/** Remote names from tracking refs and from `git remote`, without duplicates. */
export function repositoryRemotes(snapshot: {
  remotes: readonly string[]
  remoteUrls?: readonly { name: string }[]
}): string[] {
  const names = new Set(snapshot.remotes)
  for (const url of snapshot.remoteUrls ?? []) {
    if (url.name) names.add(url.name)
  }
  return [...names]
}
