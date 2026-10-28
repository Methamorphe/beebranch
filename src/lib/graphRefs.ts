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
}

function mirrorsUpstream(upstream: string, remote: RefEntry): boolean {
  return upstream === remote.fullName || upstream === remote.name
}

/**
 * `main` and `origin/main` on the same commit describe one branch. A
 * remote-tracking ref that only mirrors a local branch present on the commit
 * adds nothing to the badge, and nothing to disambiguate in a hover menu.
 * Ahead/behind branches sit on different commits, so they never fold.
 */
export function foldUpstreamRefs(decorated: GraphRefDecoration[]): FoldedCommitRefs {
  const upstreams = decorated.flatMap(({ entry }) =>
    entry?.kind === 'branch' && entry.upstream ? [entry.upstream] : [],
  )
  const visible = decorated.filter(
    ({ entry }) =>
      !(entry?.kind === 'remoteBranch' && upstreams.some((upstream) => mirrorsUpstream(upstream, entry))),
  )
  return { visible, hidden: decorated.length - visible.length }
}
