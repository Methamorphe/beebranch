/**
 * Activity log: one entry per IPC command, with duration and outcome.
 *
 * Recorder lives at the single IPC choke point (`ipc/client.ts`), so every
 * action the application performs is covered without wiring each command. The
 * log is bounded, kept in memory only, and never stores arguments: an argument
 * may carry a token or file content.
 */

export const ACTIVITY_LIMIT = 2000

export type ActivityOutcome = 'ok' | 'failed'

export type ActivityEntry = {
  id: number
  /** Epoch milliseconds. */
  timestamp: number
  /** IPC command name, e.g. `commit_create`. */
  command: string
  /** Repository the command targeted, when the call carried one. */
  repoId?: string
  durationMs: number
  outcome: ActivityOutcome
  /** Stable error code for a failed call. */
  code?: string
}

export type ActivityScope = 'application' | 'repository'

let nextId = 1
let entries: ActivityEntry[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

/** Commands that belong to a repository panel, by naming convention. */
export function activityScope(entry: ActivityEntry): ActivityScope {
  return entry.repoId ? 'repository' : 'application'
}

export function recordActivity(input: Omit<ActivityEntry, 'id' | 'timestamp'>) {
  entries.push({ ...input, id: nextId++, timestamp: Date.now() })
  if (entries.length > ACTIVITY_LIMIT) {
    // Trim in place: copying the whole ring on every command would make the
    // hot path quadratic during a busy session.
    entries.splice(0, entries.length - ACTIVITY_LIMIT)
  }
  notify()
}

/** Read the log, newest first. */
export function activitySnapshot(repoId?: string): ActivityEntry[] {
  const visible = repoId
    ? entries.filter((entry) => entry.repoId === repoId)
    : entries.filter((entry) => !entry.repoId)
  return [...visible].reverse()
}

export function clearActivity() {
  entries = []
  notify()
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test and diagnostics hook: forget everything, including the id counter. */
export function resetActivity() {
  entries = []
  nextId = 1
  notify()
}
