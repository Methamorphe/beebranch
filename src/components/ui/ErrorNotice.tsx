import { useState } from 'react'
import { t } from '../../i18n'
import type { PresentedError } from '../../ipc/client'
import type { ErrorAction } from '../../lib/errorRecovery'
import styles from './ErrorNotice.module.css'

type Props = {
  error: PresentedError
  action?: ErrorAction
  /** Inside a toast the chrome is already there. */
  embedded?: boolean
}

/** Title, the next step, and the technical output behind a disclosure. */
export function ErrorNotice({ error, action, embedded = false }: Props) {
  const [open, setOpen] = useState(false)
  const technical = [error.detail, error.code].filter((part) => part && part.length > 0).join('\n\n')

  return (
    <div className={embedded ? styles.embedded : styles.notice} role={embedded ? undefined : 'alert'}>
      <p className={styles.message}>{error.message}</p>
      {error.remediation ? <p className={styles.hint}>{error.remediation}</p> : null}
      {action || technical ? (
        <div className={styles.row}>
          {action ? (
            <button type="button" className={styles.action} onClick={action.run}>
              {action.label}
            </button>
          ) : null}
          {technical ? (
            <button
              type="button"
              className={styles.details}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t('common.hide') : t('common.details')}
            </button>
          ) : null}
        </div>
      ) : null}
      {open && technical ? <pre className={styles.output}>{technical}</pre> : null}
    </div>
  )
}
