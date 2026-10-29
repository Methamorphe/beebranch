import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import styles from './p1.module.css'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

type Props = {
  open: boolean
  title: string
  consequence: string
  irreversible?: boolean
  /** Exact text the user must type; omit for a simple acknowledgement. */
  typed?: string
  confirmLabel?: string
  busy?: boolean
  /** Extra controls (choices) rendered between the consequence and the actions. */
  children?: ReactNode
  onCancel: () => void
  onConfirm: (typed: string) => void
}

export function ConfirmDialog({
  open,
  title,
  consequence,
  irreversible = false,
  typed,
  confirmLabel,
  busy = false,
  children,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) {
      setValue('')
    }
  }, [open])

  if (!open) {
    return null
  }

  const ready = !typed || value === typed

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      busy={busy}
      titleId="confirm-title"
      kind="alertdialog"
    >
        <h2 id="confirm-title">{title}</h2>
        <p>{consequence}</p>
        {children}
        {irreversible ? (
          <p className={styles.danger}>
            {t('shell.confirm.irreversible')}
          </p>
        ) : null}
        {typed ? (
          <label className={styles.field}>
            {t('shell.confirm.typeBefore')} <code>{typed}</code> {t('shell.confirm.typeAfter')}
            <input
              value={value}
            data-autofocus
              onChange={(event) => setValue(event.target.value)}
                  spellCheck={false}
              aria-label={t('shell.confirm.typeAria', { value: typed })}
            />
          </label>
        ) : null}
        <div className={styles.dialogActions}>
          <Button type="button" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => ready && onConfirm(value)}
            disabled={!ready || busy}
          >
            {busy ? t('shell.confirm.busy') : (confirmLabel ?? t('shell.confirm.defaultLabel'))}
          </Button>
        </div>
    </Dialog>
  )
}
