import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { ActionBar } from './ui/ActionBar'
import { Button } from './ui/Button'

type Props = {
  open: boolean
  title: string
  consequence: string
  irreversible?: boolean
  /**
   * Ask a second time, in the same bar, before running the action. Defaults
   * to `irreversible`; set it for destructive actions Git can still recover.
   */
  confirmTwice?: boolean
  confirmLabel?: string
  /** Visual weight of the confirming action; destructive bars stay red. */
  tone?: 'danger' | 'primary'
  busy?: boolean
  /** Extra controls (choices) rendered under the consequence. */
  children?: ReactNode
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmation shown in the action bar above the workspace. A destructive
 * action takes two clicks: the action itself, then an explicit warning step.
 */
export function ConfirmBar({
  open,
  title,
  consequence,
  irreversible = false,
  confirmTwice = irreversible,
  confirmLabel,
  tone = 'danger',
  busy = false,
  children,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useI18n()
  const [warning, setWarning] = useState(false)

  useEffect(() => {
    if (open) setWarning(false)
  }, [open])

  if (!open) {
    return null
  }

  const label = confirmLabel ?? t('shell.confirm.defaultLabel')
  const cancel = (
    <Button type="button" size="sm" onClick={onCancel} disabled={busy} data-autofocus={warning || undefined}>
      {t('common.cancel')}
    </Button>
  )

  if (warning) {
    return (
      <ActionBar
        tone="danger"
        title={t('shell.confirm.warnTitle', { action: title })}
        busy={busy}
        focusKey="warning"
        onCancel={onCancel}
        actions={
          <>
            {cancel}
            <Button type="button" size="sm" variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? t('shell.confirm.busy') : t('shell.confirm.defaultLabel')}
            </Button>
          </>
        }
      >
        <p>{consequence}</p>
        <p>{irreversible ? t('shell.confirm.irreversible') : t('shell.confirm.warnBody')}</p>
      </ActionBar>
    )
  }

  return (
    <ActionBar
      tone={tone}
      title={title}
      busy={busy}
      focusKey="ask"
      onCancel={onCancel}
      actions={
        <>
          {cancel}
          <Button
            type="button"
            size="sm"
            variant={tone}
            onClick={() => (confirmTwice ? setWarning(true) : onConfirm())}
            disabled={busy}
          >
            {busy ? t('shell.confirm.busy') : label}
          </Button>
        </>
      }
    >
      <p>{consequence}</p>
      {children}
      {irreversible ? <p>{t('shell.confirm.irreversible')}</p> : null}
    </ActionBar>
  )
}
