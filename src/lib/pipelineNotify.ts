import type { MessageKey } from '../i18n/translate'
import { pipelineState } from './pipeline.ts'

/** Off unless the user turns it on. One app-wide preference. */
export const PIPELINE_NOTIFY_PREFERENCE = 'ui.pipelineFailureNotifications'

const listeners = new Set<() => void>()
let enabled = false

export function pipelineNotifyEnabled(): boolean {
  return enabled
}

export function setPipelineNotifyEnabled(next: boolean): void {
  enabled = next
  for (const listener of listeners) listener()
}

export function onPipelineNotifyChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type WatchedPipeline = {
  id: number
  status: string
  refName?: string
}

export type PipelineFailure = {
  repoName: string
  ref: string
  id: number
}

/**
 * Failures that newly appeared for one repository.
 *
 * The first observation of a repository only records the current states, so
 * opening BeeBranch does not notify about pipelines that were already red.
 * A later transition to `failed`, or a pipeline id that shows up already
 * failed, produces one notice. The same failure is not repeated.
 */
export function collectPipelineFailures(
  repoId: string,
  repoName: string,
  pipelines: WatchedPipeline[],
  seen: Map<string, string>,
): PipelineFailure[] {
  const primedKey = `repo:${repoId}`
  const primed = seen.has(primedKey)
  const notices: PipelineFailure[] = []
  for (const pipeline of pipelines) {
    const key = `${repoId}:${pipeline.id}`
    const next = pipelineState(pipeline.status)
    const previous = seen.get(key)
    seen.set(key, next)
    if (!primed) continue
    if (next === 'failed' && previous !== 'failed') {
      notices.push({
        repoName,
        ref: pipeline.refName?.trim() ?? '',
        id: pipeline.id,
      })
    }
  }
  if (!primed) seen.set(primedKey, '1')
  return notices
}

export function pipelineFailureTitleKey(): MessageKey {
  return 'shell.pipeline.notifyTitle'
}

export function pipelineFailureBody(
  failure: PipelineFailure,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  if (failure.ref) {
    return t('shell.pipeline.notifyBody', {
      repo: failure.repoName,
      ref: failure.ref,
      id: failure.id,
    })
  }
  return t('shell.pipeline.notifyBodyNoRef', {
    repo: failure.repoName,
    id: failure.id,
  })
}
