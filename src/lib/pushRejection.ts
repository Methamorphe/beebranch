import { errorCode } from '../ipc/client'

/** A push that Git refused, with the target the recovery needs. */
export type PushRejection = {
  repoId: string
  remote: string
  branch: string
}

/**
 * Refusals a fetch plus a divergence check can resolve.
 *
 * `git.non_fast_forward` is the remote rejecting the update; `git.push_lease_stale`
 * is `--force-with-lease` seeing a remote that moved since the expected SHA was
 * read. Both leave the local branch untouched, so the user can still choose
 * between integrating the remote and rewriting it.
 */
const RECOVERABLE: Record<string, true> = {
  'git.non_fast_forward': true,
  'git.push_lease_stale': true,
}

/** Whether a failed command is a push the user can still resolve. */
export function isPushRejection(cause: unknown): boolean {
  return RECOVERABLE[errorCode(cause)] === true
}
