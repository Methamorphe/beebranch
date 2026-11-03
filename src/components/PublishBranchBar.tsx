import { useI18n } from '../i18n'
import { ConfirmBar } from './ConfirmBar'

/** A local branch without upstream, and the remote that should receive it. */
export type PublishTarget = { branch: string; remote: string }

type Props = {
  target: PublishTarget | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Offers the one action Git needs before a local branch can be shared: the
 * first push creates `remote/branch` and records it as the upstream. An action
 * bar rather than a detour through the sync panel keeps that decision in front
 * of the user, where the branch was just created or pushed.
 */
export function PublishBranchBar({ target, onCancel, onConfirm }: Props) {
  const { t } = useI18n()
  if (!target) {
    return null
  }
  return (
    <ConfirmBar
      open
      title={t('workbench.publish.title', { branch: target.branch })}
      consequence={t('workbench.publish.consequence', {
        branch: target.branch,
        remote: target.remote,
      })}
      confirmLabel={t('workbench.publish.confirm', {
        branch: target.branch,
        remote: target.remote,
      })}
      tone="primary"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
