import type { MessageKey } from '../i18n'

/** Persisted choice for a checkout that has to stash local changes. */
export const CHECKOUT_STASH_PREFERENCE = 'git.checkoutStash'

export const CHECKOUT_STASH_MODES = ['keep', 'reapply'] as const

export type CheckoutStashMode = (typeof CHECKOUT_STASH_MODES)[number]

export type CheckoutResult = {
  stashPopped: boolean
  stashKept: boolean
  stashConflicts: string[]
}

export function isCheckoutStashMode(value: string | null | undefined): value is CheckoutStashMode {
  return value === 'keep' || value === 'reapply'
}

/** Notice for a checkout that stashed local changes, or `null` when it did not. */
export function checkoutStashMessage(result: CheckoutResult): MessageKey | null {
  if (result.stashConflicts.length > 0) return 'workbench.notice.checkoutStashConflicts'
  if (result.stashKept) return 'workbench.notice.checkoutStashKept'
  if (result.stashPopped) return 'workbench.notice.checkoutStashReapplied'
  return null
}
