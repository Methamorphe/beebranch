/**
 * Client-side find over commits already loaded in the graph.
 * Matches subject (message title), author name, and SHA prefix.
 * Full-message / unbounded history stays on Deep Search (Mod+Shift+F).
 */

export type GraphFindCommit = {
  sha: string
  subject: string
  author: { name: string }
}

/** Indices of commits matching `query` (case-insensitive). Empty query → none. */
export function matchGraphCommits(commits: GraphFindCommit[], query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const matches: number[] = []
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]
    if (!commit) {
      continue
    }
    if (
      commit.subject.toLowerCase().includes(needle) ||
      commit.author.name.toLowerCase().includes(needle) ||
      commit.sha.toLowerCase().startsWith(needle)
    ) {
      matches.push(index)
    }
  }
  return matches
}

/**
 * Next / previous match relative to the selected commit.
 * Wraps at the ends. Returns null when there are no matches.
 */
export function stepGraphFind(
  matches: number[],
  commits: GraphFindCommit[],
  selectedSha: string | undefined,
  direction: 1 | -1,
): number | null {
  if (matches.length === 0) {
    return null
  }
  const current = selectedSha
    ? commits.findIndex((commit) => commit.sha === selectedSha)
    : -1
  if (direction === 1) {
    return matches.find((index) => index > current) ?? matches[0]!
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const index = matches[i]!
    if (index < current) {
      return index
    }
  }
  return matches[matches.length - 1]!
}

/** Assert-based self-check — run via `node --import tsx src/lib/graphFind.ts` or Vite DEV. */
export function graphFindSelfCheck(): void {
  const sample: GraphFindCommit[] = [
    { sha: 'abcdef01', subject: 'Fix login', author: { name: 'Ada' } },
    { sha: 'deadbeef', subject: 'Add graph find', author: { name: 'Bob' } },
    { sha: 'cafebabe', subject: 'docs: find bar', author: { name: 'Ada' } },
  ]
  const hits = matchGraphCommits(sample, 'find')
  if (hits.length !== 2 || hits[0] !== 1 || hits[1] !== 2) {
    throw new Error('graphFind: subject match failed')
  }
  if (stepGraphFind(hits, sample, 'deadbeef', 1) !== 2) {
    throw new Error('graphFind: step forward failed')
  }
  if (stepGraphFind(hits, sample, 'cafebabe', 1) !== 1) {
    throw new Error('graphFind: wrap forward failed')
  }
  if (matchGraphCommits(sample, 'ada').length !== 2) {
    throw new Error('graphFind: author match failed')
  }
  if (matchGraphCommits(sample, 'dead').length !== 1) {
    throw new Error('graphFind: sha prefix match failed')
  }
}

if (import.meta.env?.DEV) {
  graphFindSelfCheck()
}
