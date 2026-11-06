import { useEffect, useState } from 'react'
import { preferenceGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import {
  AUTO_FETCH_OPTIONS,
  AUTO_FETCH_PREFERENCE,
  AUTO_FETCH_PROMPTED_PREFERENCE,
  autoFetchPromptDue,
  dismissAutoFetchPrompt,
  saveAutoFetchMinutes,
} from '../lib/autoFetch'
import styles from './AutoFetchPrompt.module.css'

/**
 * One-time banner offering the background fetch interval.
 *
 * Shown once per installation, the first time a repository is open, including
 * on installs that predate it. Any answer (an interval, "Off" or "Later")
 * records that it was asked, so it never comes back; the interval stays
 * editable in Settings and in the Sync panel.
 */
export function AutoFetchPrompt() {
  const { t } = useI18n()
  const [due, setDue] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      preferenceGet(AUTO_FETCH_PROMPTED_PREFERENCE),
      preferenceGet(AUTO_FETCH_PREFERENCE),
    ])
      .then(([prompted, minutes]) => {
        if (!cancelled) {
          setDue(autoFetchPromptDue(prompted, minutes))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (!due) {
    return null
  }

  const answer = (action: () => Promise<void>) => {
    setError(null)
    void action()
      .then(() => setDue(false))
      .catch((cause: unknown) => setError(errorMessage(cause)))
  }

  return (
    <div className={styles.prompt} role="region" aria-label={t('workbench.autoFetch.aria')}>
      <div className={styles.text}>
        <strong>{t('workbench.autoFetch.title')}</strong>
        <span>{t('workbench.autoFetch.body')}</span>
        {error ? <span role="alert" className={styles.error}>{error}</span> : null}
      </div>
      <div className={styles.actions}>
        {AUTO_FETCH_OPTIONS.filter((option) => option.value !== '1').map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => answer(() => saveAutoFetchMinutes(option.value))}
          >
            {t(option.labelKey)}
          </button>
        ))}
        <button type="button" onClick={() => answer(dismissAutoFetchPrompt)}>
          {t('workbench.autoFetch.later')}
        </button>
      </div>
    </div>
  )
}
