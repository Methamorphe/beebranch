import type { CommitSummary, RefEntry } from '../types/git'

/** A comparison label reads better with the 8-character form of a SHA. */
export function shortRevision(revision: string) {
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 8) : revision
}

export function graphRefLabel(raw: string) {
  return raw.replace(/^HEAD -> /, '').replace(/^refs\/(heads|remotes|tags)\//, '').replace(/^tag: /, '')
}

function candidates(raw: string, entries: RefEntry[]) {
  if (raw.startsWith('refs/')) return entries.filter((entry) => entry.fullName === raw)
  const name = graphRefLabel(raw)
  if (raw.startsWith('tag: ')) return entries.filter((entry) => entry.kind === 'tag' && entry.name === name)
  if (raw.startsWith('HEAD -> ')) return entries.filter((entry) => entry.kind === 'branch' && entry.name === name)
  return entries.filter((entry) => (entry.kind === 'branch' || entry.kind === 'remoteBranch') && entry.name === name)
}

/** Never guess between a local branch and a remote ref with the same display name. */
export function resolveGraphRef(raw: string, entries: RefEntry[]): RefEntry | undefined {
  const matches = candidates(raw, entries)
  return matches.length === 1 ? matches[0] : undefined
}

function isDroppableBranch(entry: RefEntry, source: RefEntry) {
  return (
    !entry.symref &&
    (entry.kind === 'branch' || entry.kind === 'remoteBranch') &&
    entry.fullName !== source.fullName
  )
}

function uniqueDroppable(entries: RefEntry[], source: RefEntry): RefEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (!isDroppableBranch(entry, source) || seen.has(entry.fullName)) return false
    seen.add(entry.fullName)
    return true
  })
}

/** Local name a remote tracking branch sits on (`origin/main` → `main`). */
export function graphRefGroupKey(entry: RefEntry): string {
  if (entry.kind === 'remoteBranch') {
    const slash = entry.name.indexOf('/')
    return slash >= 0 ? entry.name.slice(slash + 1) : entry.name
  }
  return entry.name
}

/** Remote name only, once the group already says `main` (`origin/main` → `origin`). */
export function graphRefRemoteLabel(entry: RefEntry): string {
  if (entry.kind !== 'remoteBranch') return entry.name
  const slash = entry.name.indexOf('/')
  return slash >= 0 ? entry.name.slice(0, slash) : entry.name
}

/** Locals and their remotes share a heading; tags stay at the end. */
export function groupByBranchName<T>(
  items: T[],
  of: (item: T) => RefEntry | undefined,
): { name: string; items: T[] }[] {
  const groups: { name: string; items: T[] }[] = []
  const index = new Map<string, { name: string; items: T[] }>()
  const others: T[] = []
  for (const item of items) {
    const entry = of(item)
    if (!entry || (entry.kind !== 'branch' && entry.kind !== 'remoteBranch')) {
      others.push(item)
      continue
    }
    const name = graphRefGroupKey(entry)
    let group = index.get(name)
    if (!group) {
      group = { name, items: [] }
      index.set(name, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  for (const group of groups) {
    group.items.sort((left, right) => {
      const rank = (item: T) => (of(item)?.kind === 'branch' ? 0 : 1)
      return rank(left) - rank(right) || (of(left)?.name ?? '').localeCompare(of(right)?.name ?? '')
    })
  }
  if (others.length > 0) groups.push({ name: '', items: others })
  return groups
}

export function groupRefsByBranchName(entries: RefEntry[]): { name: string; items: RefEntry[] }[] {
  return groupByBranchName(entries, (entry) => entry)
}

export type GraphRemoteUrl = { name: string; url: string; direction?: string }

/** Fetch URL of a remote, then any URL of that name. */
export function graphRemoteUrl(remote: string, urls?: readonly GraphRemoteUrl[]): string | undefined {
  if (!urls || urls.length === 0) return undefined
  return (
    urls.find((item) => item.name === remote && item.direction === 'fetch')?.url ??
    urls.find((item) => item.name === remote)?.url
  )
}

function remoteHost(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || null
    } catch {
      return null
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/]+):/.exec(trimmed)
  return scp?.[1]?.toLowerCase() ?? null
}

/** Forge mark for a remote: host of its URL first, then the remote name. */
export function graphRemoteGlyph(remote: string, url?: string): 'gitlab' | 'github' | 'azure' | 'remotes' {
  const host = url ? remoteHost(url) ?? '' : ''
  const name = remote.toLowerCase()
  if (host.includes('gitlab') || name.includes('gitlab')) return 'gitlab'
  if (
    host === 'github.com' ||
    host.endsWith('.github.com') ||
    host.includes('github') ||
    name.includes('github') ||
    name === 'gh'
  ) {
    return 'github'
  }
  if (
    host === 'dev.azure.com' ||
    host === 'ssh.dev.azure.com' ||
    host.endsWith('.visualstudio.com') ||
    host.includes('azure') ||
    name.includes('azure') ||
    name.includes('ado')
  ) {
    return 'azure'
  }
  return 'remotes'
}

export type DropBranch = {
  name: string
  /** Local on this commit if there is one, otherwise a remote-tracking ref. */
  target: RefEntry
  local?: RefEntry
  remotes: RefEntry[]
}

/** One drop (or checkout) row per branch: land on the local when it sits on the same commit. */
export function dropBranchesFromRefs(entries: RefEntry[]): DropBranch[] {
  return groupRefsByBranchName(entries).flatMap((group) => {
    if (!group.name) return []
    const local = group.items.find((entry) => entry.kind === 'branch')
    const remotes = group.items.filter((entry) => entry.kind === 'remoteBranch')
    const target = local ?? remotes[0]
    return target ? [{ name: group.name, target, local, remotes }] : []
  })
}

/** Every branch a drag can land on for this commit, not only the hovered pill. */
export function dropTargetsForCommit(
  commit: CommitSummary,
  entries: RefEntry[],
  source: RefEntry,
): RefEntry[] {
  return uniqueDroppable(
    graphCommitRefs(commit, entries).flatMap(({ entry }) => (entry ? [entry] : [])),
    source,
  )
}

/** One decoration of a commit, resolved to its full ref when possible. */
export type GraphRefDecoration = {
  raw: string
  entry?: RefEntry
  key: string
}

/**
 * `origin/HEAD` (a symbolic ref pointing at the remote's default branch) is
 * part of Git's decorations but names no branch of its own: the branch it
 * points at is already decorated. Showing it doubles that branch on the badge
 * and in the hover list, so it is dropped.
 */
function isRemoteHeadSymref(entry: RefEntry | undefined) {
  return entry?.kind === 'remoteBranch' && Boolean(entry.symref)
}

/** Git's short decorations can repeat names; retain every distinct full ref. */
export function graphCommitRefs(commit: CommitSummary, entries: RefEntry[]): GraphRefDecoration[] {
  const used = new Set<string>()
  return commit.refs
    .map((raw, index) => {
      const matches = candidates(raw, entries).filter((entry) => !used.has(entry.fullName))
      const entry = matches.find((ref) => ref.targetOid === commit.sha) ?? matches[0]
      const decoration = { raw, entry, key: entry?.fullName ?? `${index}-${raw}` }
      if (entry) used.add(entry.fullName)
      return decoration
    })
    .filter(({ entry }) => !isRemoteHeadSymref(entry))
}

export function isCheckoutableRef(entry: RefEntry | undefined): entry is RefEntry {
  return Boolean(entry && !entry.symref && (entry.kind === 'branch' || entry.kind === 'remoteBranch'))
}

export type GraphRefKind = 'head' | 'local' | 'remote' | 'tag' | 'other'

/** What a decoration points at; drives the badge icon and the popover icon. */
export function graphRefKind(raw: string, entry?: RefEntry): GraphRefKind {
  if (raw.startsWith('HEAD -> ') || entry?.isHead) return 'head'
  if (entry?.kind === 'branch') return 'local'
  if (entry?.kind === 'remoteBranch') return 'remote'
  if (entry?.kind === 'tag') return 'tag'
  if (raw.startsWith('tag: ') || raw.startsWith('refs/tags/')) return 'tag'
  if (raw.startsWith('refs/remotes/')) return 'remote'
  if (raw.startsWith('refs/heads/')) return 'local'
  return 'other'
}

export type FoldedCommitRefs = {
  visible: GraphRefDecoration[]
  hidden: number
  /** Remote names (`origin`, `gitlab`) folded into each visible decoration key. */
  remotes: Map<string, string[]>
}

/**
 * Locals and remotes that share a short name on the same commit are one
 * branch. `develop`, `origin/develop` and `gitlab/develop` become one pill
 * labelled `develop`; the folded remotes become the extra glyphs. Tags stay
 * on their own. Ahead/behind copies sit on other commits, so they never fold.
 */
export function foldCommitPills(decorated: GraphRefDecoration[]): FoldedCommitRefs {
  const remotes = new Map<string, string[]>()
  const visible: GraphRefDecoration[] = []
  for (const group of groupByBranchName(decorated, (item) => item.entry)) {
    if (!group.name) {
      visible.push(...group.items)
      continue
    }
    const local = group.items.find((item) => item.entry?.kind === 'branch')
    const remoteItems = group.items.filter((item) => item.entry?.kind === 'remoteBranch')
    const survivor = local ?? remoteItems[0] ?? group.items[0]
    if (!survivor) continue
    visible.push(survivor)
    remotes.set(
      survivor.key,
      remoteItems.flatMap((item) => (item.entry ? [graphRefRemoteLabel(item.entry)] : [])),
    )
  }
  return { visible, hidden: decorated.length - visible.length, remotes }
}
