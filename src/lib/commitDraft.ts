/**
 * Commit message drafts, shared by the commit panel and the WIP row of the
 * history graph.
 *
 * The draft outlives both components (switching views, closing the inspector)
 * and both editors observe the same value, so typing in the graph is visible
 * in the panel and vice versa.
 */

import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

const drafts = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()

export function readCommitDraft(repoId: string): string {
  return drafts.get(repoId) ?? ''
}

export function writeCommitDraft(repoId: string, message: string): void {
  if (readCommitDraft(repoId) === message) return
  drafts.set(repoId, message)
  listeners.get(repoId)?.forEach((listener) => listener())
}

export function subscribeCommitDraft(
  repoId: string,
  listener: Listener,
): () => void {
  const set = listeners.get(repoId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(repoId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(repoId)
  }
}

/** Read and write the draft of `repoId`, re-rendering on external changes. */
export function useCommitDraft(repoId: string): [string, (next: string) => void] {
  const subscribe = useCallback(
    (listener: Listener) => subscribeCommitDraft(repoId, listener),
    [repoId],
  )
  const message = useSyncExternalStore(
    subscribe,
    () => readCommitDraft(repoId),
    () => '',
  )
  const setMessage = useCallback(
    (next: string) => writeCommitDraft(repoId, next),
    [repoId],
  )
  return [message, setMessage]
}
