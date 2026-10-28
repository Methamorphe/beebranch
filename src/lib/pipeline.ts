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
