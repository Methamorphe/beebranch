import { useEffect, useState } from 'react'
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
  onCancel: () => void
  onConfirm: (typed: string) => void
}

export function ConfirmDialog({
  open,
  title,
  consequence,
  irreversible = false,
  typed,
  confirmLabel = 'Confirmer',
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
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
        {irreversible ? (
          <p className={styles.danger}>
            Action irréversible : aucune sauvegarde applicative n'est créée.
          </p>
        ) : null}
        {typed ? (
          <label className={styles.field}>
            Saisissez <code>{typed}</code> pour confirmer
            <input
              value={value}
            data-autofocus
              onChange={(event) => setValue(event.target.value)}
                  spellCheck={false}
              aria-label={`Saisir ${typed}`}
            />
          </label>
        ) : null}
        <div className={styles.dialogActions}>
          <Button type="button" onClick={onCancel} disabled={busy}>
            Annuler
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => ready && onConfirm(value)}
            disabled={!ready || busy}
          >
            {busy ? 'Exécution…' : confirmLabel}
          </Button>
        </div>
    </Dialog>
  )
}
