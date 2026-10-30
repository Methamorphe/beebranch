import { useEffect, useState } from 'react'
import { historySquash, historySquashPreview } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { SquashPreview } from '../types/git'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  shas: string[]
  onClose: () => void
  onSquashed: () => void
}

/**
 * Confirms a squash of a contiguous selection.
 *
 * The combined message comes from the backend, which is also the component
 * that validates the selection: a merge commit or a gap is reported here
 * instead of surfacing as a failed rebase.
 */
export function SquashDialog({ repoId, shas, onClose, onSquashed }: Props) {
  const { t, plural } = useI18n()
  const [preview, setPreview] = useState<SquashPreview | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void historySquashPreview(repoId, shas)
      .then((next) => {
        if (cancelled) return
        setPreview(next)
        setMessage(next.message)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoId, shas])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await historySquash({ repoId, shas, message })
      onSquashed()
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="squash-title">
      <h2 id="squash-title">{t('workbench.squash.title')}</h2>
      <p className={shared.notice}>
        {t('workbench.squash.consequence', {
          count: plural(
            'workbench.squash.count.one',
            'workbench.squash.count.other',
            shas.length,
            { count: String(shas.length) },
          ),
        })}
      </p>

      {loading ? (
        <p className={shared.notice} role="status">
          {t('workbench.squash.loading')}
        </p>
      ) : null}

      {error ? (
        <p className={shared.danger} role="alert">
          {error}
        </p>
      ) : null}

      {!loading && preview ? (
        <>
          <ol className={shared.list}>
            {preview.commits.map((commit) => (
              <li key={commit.sha} className={shared.item}>
                <span className={`${shared.mono} ${shared.small}`}>
                  {commit.sha.slice(0, 10)}
                </span>
                <span>{commit.subject}</span>
              </li>
            ))}
          </ol>
          <label className={shared.field}>
            {t('workbench.squash.messageLabel')}
            <textarea
              className={shared.textarea}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              aria-label={t('workbench.squash.messageAria')}
              spellCheck
              disabled={busy}
            />
          </label>
        </>
      ) : null}

      <div className={shared.row}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={busy || loading || !preview || !message.trim()}
        >
          {busy ? t('workbench.squash.running') : t('workbench.squash.submit')}
        </Button>
      </div>
    </Dialog>
  )
}
