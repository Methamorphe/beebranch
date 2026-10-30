/**
 * Hide references and remember the graph filter.
 *
 * Purely a view filter: nothing is written to the repository. The state is
 * stored per repository under `ui.refVisibility`, so a restart restores the
 * same graph. Soloing keeps using the existing graph filter (one revision),
 * which is saved alongside.
 */
import type { RefEntry } from '../types/git'

export type GraphFilter = {
  allRefs: boolean
  revision: string
}

export type RefVisibility = {
  /** Full ref names hidden from the graph. */
  hidden: string[]
  /** Graph filter in use, restored on the next launch. */
  filter?: GraphFilter
}

export const EMPTY_VISIBILITY: RefVisibility = { hidden: [] }

export const REF_VISIBILITY_KEY = 'ui.refVisibility'

/** Entries the graph may draw: hidden ones removed, HEAD always visible. */
export function applyVisibility(
  entries: RefEntry[],
  visibility: RefVisibility,
  headRef: string | undefined,
): RefEntry[] {
  const hidden = new Set(visibility.hidden)
  return entries.filter(
    (entry) => entry.fullName === headRef || !hidden.has(entry.fullName),
  )
}

/** Read the state of one repository; unknown shapes fall back to empty. */
export function parseVisibility(raw: string | null, repoId: string): RefVisibility {
  if (!raw) {
    return EMPTY_VISIBILITY
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return EMPTY_VISIBILITY
    }
    const entry = (parsed as Record<string, unknown>)[repoId]
    if (!entry || typeof entry !== 'object') {
      return EMPTY_VISIBILITY
    }
    const candidate = entry as Partial<RefVisibility>
    const hidden = Array.isArray(candidate.hidden)
      ? candidate.hidden.filter((value): value is string => typeof value === 'string')
      : []
    const filter =
      candidate.filter &&
      typeof candidate.filter === 'object' &&
      typeof candidate.filter.revision === 'string'
        ? { allRefs: Boolean(candidate.filter.allRefs), revision: candidate.filter.revision }
        : undefined
    return filter ? { hidden, filter } : { hidden }
  } catch {
    return EMPTY_VISIBILITY
  }
}

/** Merge one repository's state into the stored map. */
export function mergeVisibility(
  raw: string | null,
  repoId: string,
  visibility: RefVisibility,
): string {
  let all: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        all = parsed as Record<string, unknown>
      }
    } catch {
      all = {}
    }
  }
  all[repoId] = visibility
  return JSON.stringify(all)
}
