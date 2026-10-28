import type { CommitSummary, RefEntry } from '../types/git'

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

/** Git's short decorations can repeat names; retain every distinct full ref. */
export function graphCommitRefs(commit: CommitSummary, entries: RefEntry[]) {
  const used = new Set<string>()
  return commit.refs.map((raw, index) => {
    const matches = candidates(raw, entries).filter((entry) => !used.has(entry.fullName))
    const entry = matches.find((ref) => ref.targetOid === commit.sha) ?? matches[0]
    if (entry) used.add(entry.fullName)
    return { raw, entry, key:entry?.fullName ?? `${index}-${raw}` }
  })
}

export function isCheckoutableRef(entry: RefEntry | undefined): entry is RefEntry {
  return Boolean(entry && !entry.symref && (entry.kind === 'branch' || entry.kind === 'remoteBranch'))
}
