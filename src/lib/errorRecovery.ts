import { t } from '../i18n'
import type { PresentedError } from '../ipc/client'

export type ErrorAction = { label: string; run: () => void }

const PUSH_RECOVERY = new Set(['git.non_fast_forward', 'git.push_lease_stale'])

/**
 * A button only when a screen already exists.
 *
 * A refused push keeps its own recovery bar, so this helper does not add a
 * second action for that case. Retry is left to the caller: it knows which
 * command to run again.
 */
export function recoveryFor(
  error: PresentedError,
  handlers: {
    onProfiles?: () => void
    onConflicts?: () => void
    onGitlab?: () => void
    onGithub?: () => void
    onRetry?: () => void
  },
): ErrorAction | undefined {
  if (PUSH_RECOVERY.has(error.code)) return undefined
  if (
    (error.code === 'git.identity_missing' || error.code === 'tag.identity_missing') &&
    handlers.onProfiles
  ) {
    return { label: t('common.openProfiles'), run: handlers.onProfiles }
  }
  if (
    (error.code === 'git.conflict' || error.code === 'git.unresolved_conflicts') &&
    handlers.onConflicts
  ) {
    return { label: t('common.showConflicts'), run: handlers.onConflicts }
  }
  if (
    (error.code === 'gitlab.auth_failed' || error.code === 'gitlab.git_credential_rejected') &&
    handlers.onGitlab
  ) {
    return { label: t('common.openGitlab'), run: handlers.onGitlab }
  }
  if (
    (error.code === 'github.auth_failed' || error.code === 'github.git_credential_rejected') &&
    handlers.onGithub
  ) {
    return { label: t('common.openGithub'), run: handlers.onGithub }
  }
  if (error.retryable && handlers.onRetry) {
    return { label: t('common.retry'), run: handlers.onRetry }
  }
  return undefined
}
