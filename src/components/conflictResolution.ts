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
