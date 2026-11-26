/**
 * Diff display mode: hunks only, unified, or side by side.
 *
 * The viewer remounts when a file is saved or the working copy refreshes, so
 * the choice lives in a module cache, `localStorage` for an instant restore,
 * and the preference store so it follows the user across sessions.
 */

export const DIFF_MODE_PREFERENCE = 'ui.diff.mode'

export const DIFF_MODES = ['hunk', 'inline', 'split'] as const

export type DiffMode = (typeof DIFF_MODES)[number]

export const DEFAULT_DIFF_MODE: DiffMode = 'inline'

const CHANGED_EVENT = 'beebranch:diff-mode-changed'

let current: DiffMode | null = null
/** Bumped only when the user picks a mode, so a late preference read cannot overwrite it. */
let userEpoch = 0

export function isDiffMode(value: string | null | undefined): value is DiffMode {
  return value != null && (DIFF_MODES as readonly string[]).includes(value)
}

export function parseDiffMode(value: string | null | undefined): DiffMode {
  return isDiffMode(value) ? value : DEFAULT_DIFF_MODE
}

function readLocal(): DiffMode {
  if (typeof window === 'undefined') return DEFAULT_DIFF_MODE
  try {
    return parseDiffMode(window.localStorage.getItem(DIFF_MODE_PREFERENCE))
  } catch {
    return DEFAULT_DIFF_MODE
  }
}

function writeLocal(mode: DiffMode) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DIFF_MODE_PREFERENCE, mode)
  } catch {
    // The preference store still holds the value.
  }
}

function publish(mode: DiffMode) {
  if (current === mode) return
  current = mode
  writeLocal(mode)
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

export function getDiffMode(): DiffMode {
  if (current === null) current = readLocal()
  return current
}

export function diffModeEpoch(): number {
  return userEpoch
}

/** User choice: later preference reads that started earlier are ignored. */
export function rememberDiffMode(mode: DiffMode) {
  userEpoch += 1
  publish(mode)
  writeLocal(mode)
}

/**
 * Apply a value just read from the preference store.
 * An empty store keeps the cached / localStorage choice so a remount does not
 * flash back to Unified. Returns false when the user picked a mode after this
 * read started.
 */
export function applyStoredDiffMode(raw: string | null | undefined, seenEpoch: number): boolean {
  if (seenEpoch !== userEpoch) return false
  if (raw == null) return true
  publish(parseDiffMode(raw))
  return true
}

export function onDiffModeChanged(listener: (mode: DiffMode) => void): () => void {
  const handler = () => listener(getDiffMode())
  window.addEventListener(CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHANGED_EVENT, handler)
}
