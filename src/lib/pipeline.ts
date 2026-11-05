import type { MessageKey } from '../i18n/translate'
import type { PipelineState } from '../types/git'

/** Unambiguous GitLab pipeline status mapping shared by every surface. */
export function pipelineState(status: string | undefined): PipelineState {
  switch ((status ?? '').toLowerCase()) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'skipped':
    case 'manual':
    case 'scheduled':
      return 'neutral'
    default:
      return 'unknown'
  }
}

/**
 * Worst state of a set of pipelines: one failing job shows a red indicator
 * even when every other workflow passed. Running and pending outrank unknown
 * so a rebuild in flight is never masked by a stale entry.
 */
export function aggregatePipelineState(statuses: (string | undefined)[]): PipelineState {
  if (statuses.length === 0) {
    return 'unknown'
  }
  const states = statuses.map(pipelineState)
  for (const candidate of ['failed', 'canceled', 'running', 'pending'] as const) {
    if (states.includes(candidate)) {
      return candidate
    }
  }
  if (states.includes('unknown')) {
    return 'unknown'
  }
  return states.includes('success') ? 'success' : 'neutral'
}

/** Pipelines that will not change anymore, for the `done/total` progress. */
export function isSettled(state: PipelineState): boolean {
  return state !== 'running' && state !== 'pending'
}

/** Display label of a pipeline ref; GitLab reports merge requests on a ref. */
export function pipelineRefLabel(refName: string | undefined): string | null {
  if (!refName) return null
  const mergeRequest = /^refs\/merge-requests\/(\d+)\/head$/.exec(refName)
  return mergeRequest ? `!${mergeRequest[1]}` : refName
}

/** Status label keys shared by the indicator, the panel and the history view. */
export const PIPELINE_STATE_KEYS: Record<PipelineState, MessageKey> = {
  pending: 'shell.pipeline.state.pending',
  running: 'shell.pipeline.state.running',
  success: 'shell.pipeline.state.success',
  failed: 'shell.pipeline.state.failed',
  canceled: 'shell.pipeline.state.canceled',
  neutral: 'shell.pipeline.state.neutral',
  unknown: 'shell.pipeline.state.unknown',
}
