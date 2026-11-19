import type { ConflictRegion, ConflictView, HeadState, InProgressOperation } from '../types/git'

/** Lines kept for one marker block. A region without a choice stays undecided. */
export type RegionChoice = { ours: boolean[]; theirs: boolean[]; base: boolean }
export type Choices = Record<number, RegionChoice>
export type PresetKind = 'ours' | 'theirs' | 'both' | 'base'
export type ChoiceKind = PresetKind | 'custom'

export function presetChoice(region: ConflictRegion, kind: PresetKind): RegionChoice {
  return {
    ours: region.ours.map(() => kind === 'ours' || kind === 'both'),
    theirs: region.theirs.map(() => kind === 'theirs' || kind === 'both'),
    base: kind === 'base',
  }
}

export function choiceKind(choice: RegionChoice): ChoiceKind {
  if (choice.base) return 'base'
  const allOurs = choice.ours.every(Boolean)
  const noOurs = !choice.ours.some(Boolean)
  const allTheirs = choice.theirs.every(Boolean)
  const noTheirs = !choice.theirs.some(Boolean)
  if (allOurs && noTheirs) return 'ours'
  if (noOurs && allTheirs) return 'theirs'
  if (allOurs && allTheirs) return 'both'
  return 'custom'
}

/**
 * The working file with every decided marker block replaced by its chosen
 * lines. Undecided blocks keep their markers, so the result never pretends a
 * conflict was settled.
 */
export function assembleRegions(
  working: string,
  regions: ConflictRegion[],
  choices: Choices,
): string {
  const lines = working.split('\n')
  const out: string[] = []
  let cursor = 0
  for (const region of regions) {
    out.push(...lines.slice(cursor, region.start - 1))
    const choice = choices[region.index]
    if (!choice) {
      out.push(...lines.slice(region.start - 1, region.end))
    } else if (choice.base) {
      out.push(...region.base)
    } else {
      out.push(...region.ours.filter((_, index) => choice.ours[index]))
      out.push(...region.theirs.filter((_, index) => choice.theirs[index]))
    }
    cursor = region.end
  }
  out.push(...lines.slice(cursor))
  return out.join('\n')
}

export type DiffToken = { text: string; changed: boolean }
export type DiffCell = { kind: 'same' | 'change' | 'pad'; tokens: DiffToken[] }
export type DiffRow = { ours: DiffCell; theirs: DiffCell }

function tokenize(line: string): string[] {
  return line.match(/[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g) ?? [line]
}

/** Token diff used to paint only the words that differ inside a paired line. */
function diffTokens(left: string[], right: string[]): [DiffToken[], DiffToken[]] {
  const n = left.length
  const m = right.length
  const scores: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      scores[i][j] = left[i] === right[j]
        ? scores[i + 1][j + 1] + 1
        : Math.max(scores[i + 1][j], scores[i][j + 1])
    }
  }
  const ours: DiffToken[] = []
  const theirs: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ours.push({ text: left[i], changed: false })
      theirs.push({ text: right[j], changed: false })
      i += 1
      j += 1
    } else if (scores[i + 1][j] >= scores[i][j + 1]) {
      ours.push({ text: left[i], changed: true })
      i += 1
    } else {
      theirs.push({ text: right[j], changed: true })
      j += 1
    }
  }
  while (i < n) ours.push({ text: left[i++], changed: true })
  while (j < m) theirs.push({ text: right[j++], changed: true })
  return [ours, theirs]
}

/**
 * Pair both sides of one conflict by index. Equal lines stay plain; differing
 * lines carry a token diff; a side that ran out of lines is an empty pad.
 */
export function pairConflictLines(ours: string[], theirs: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  const count = Math.max(ours.length, theirs.length)
  for (let index = 0; index < count; index += 1) {
    const left = ours[index]
    const right = theirs[index]
    if (left === undefined) {
      rows.push({
        ours: { kind: 'pad', tokens: [] },
        theirs: { kind: 'change', tokens: [{ text: right ?? '', changed: true }] },
      })
    } else if (right === undefined) {
      rows.push({
        ours: { kind: 'change', tokens: [{ text: left, changed: true }] },
        theirs: { kind: 'pad', tokens: [] },
      })
    } else if (left === right) {
      const tokens = [{ text: left, changed: false }]
      rows.push({
        ours: { kind: 'same', tokens },
        theirs: { kind: 'same', tokens: [{ text: right, changed: false }] },
      })
    } else {
      const [leftTokens, rightTokens] = diffTokens(tokenize(left), tokenize(right))
      rows.push({
        ours: { kind: 'change', tokens: leftTokens },
        theirs: { kind: 'change', tokens: rightTokens },
      })
    }
  }
  return rows
}

/** Lines a decided region contributes, in ours-then-theirs order. */
export function chosenLines(region: ConflictRegion, choice: RegionChoice | undefined): string[] | null {
  if (!choice) return null
  if (choice.base) return region.base
  return [
    ...region.ours.filter((_, index) => choice.ours[index]),
    ...region.theirs.filter((_, index) => choice.theirs[index]),
  ]
}

export type SortieLine = {
  /** 1-based line in the working file, or the first content line of a choice. */
  number: number
  end?: number
  text: string
  role: 'context' | 'focus' | 'pending'
}

/**
 * A short window of the resolution: the active conflict's chosen lines, plus a
 * few lines of surrounding context. Undecided conflicts stay an empty slot.
 */
export function sortieWindow(
  working: string,
  regions: ConflictRegion[],
  choices: Choices,
  regionIndex: number,
  context = 2,
): SortieLine[] {
  const source = working.split('\n')
  const items: SortieLine[] = []
  let cursor = 0
  let activeAt = -1
  for (const region of regions) {
    for (let index = cursor; index < region.start - 1 && index < source.length; index += 1) {
      items.push({ number: index + 1, text: source[index] ?? '', role: 'context' })
    }
    if (region.index === regionIndex) activeAt = items.length
    const picked = chosenLines(region, choices[region.index])
    if (region.index === regionIndex) {
      if (!picked || picked.length === 0) {
        items.push({ number: region.start, end: region.end, text: '', role: 'pending' })
      } else {
        picked.forEach((text, offset) => {
          items.push({ number: region.start + 1 + offset, text, role: 'focus' })
        })
      }
    } else {
      for (let number = region.start; number <= region.end; number += 1) {
        items.push({ number, text: source[number - 1] ?? '', role: 'context' })
      }
    }
    cursor = region.end
  }
  for (let index = cursor; index < source.length; index += 1) {
    items.push({ number: index + 1, text: source[index] ?? '', role: 'context' })
  }
  if (activeAt < 0) return []
  let end = activeAt
  while (end < items.length && items[end]?.role !== 'context') end += 1
  const from = Math.max(0, activeAt - context)
  const to = Math.min(items.length, end + context)
  return items.slice(from, to)
}

/** Same rule as the backend's `marker_lines`: column-zero markers only. */
export function countMarkers(content: string): number {
  let count = 0
  for (const line of content.split('\n')) {
    if (
      line.startsWith('<<<<<<< ')
      || line.startsWith('||||||| ')
      || line.startsWith('>>>>>>> ')
      || line === '======='
      || line.startsWith('=======\r')
    ) {
      count += 1
    }
  }
  return count
}

/** Git's fixed label for the stash side of `git stash apply/pop` conflicts. */
const STASH_THEIRS = 'Stashed changes'

export type SideNames = {
  /** Where the conflict comes from, for the context line. */
  source: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'stash' | 'unknown'
  /** Readable name of "ours", when one can be derived. */
  ours?: string
  /** Readable name of "theirs", when one can be derived. */
  theirs?: string
}

/**
 * Name both sides from the marker labels and the repository state, so the UI
 * can say "master" and "your stash" instead of "ours" and "theirs".
 */
export function sideNames(
  view: ConflictView | null,
  head: HeadState | undefined,
  operation: InProgressOperation | undefined,
): SideNames {
  const region = view?.regions?.[0]
  const oursLabel = region?.oursLabel?.trim() || undefined
  const theirsLabel = region?.theirsLabel?.trim() || undefined
  const branch = head?.kind === 'branch' ? head.name : undefined
  const current = !oursLabel || oursLabel === 'HEAD' || oursLabel === 'Updated upstream'
    ? branch
    : oursLabel
  if (!operation && theirsLabel === STASH_THEIRS) {
    return { source: 'stash', ours: current }
  }
  switch (operation?.kind) {
    case 'rebase':
      // During a rebase "ours" is the new base and "theirs" the replayed commit.
      return { source: 'rebase', theirs: theirsLabel }
    case 'merge':
      return { source: 'merge', ours: current, theirs: theirsLabel }
    case 'cherryPick':
    case 'revert':
      return { source: operation.kind, ours: current, theirs: theirsLabel }
    case 'sequencer':
      return { source: operation.sequencer, ours: current, theirs: theirsLabel }
    default:
      return { source: 'unknown', ours: current, theirs: theirsLabel }
  }
}
