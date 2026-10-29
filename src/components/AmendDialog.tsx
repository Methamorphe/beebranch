import { useEffect, useState } from 'react'
import { commitCreate, commitGet, refsGet } from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { CommitDetail } from '../types/git'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import styles from './AmendDialog.module.css'
import shared from './p1.module.css'

type Props = {
  repoId: string
  sha: string
  subject: string
  /** Files already staged; they become part of the amended commit. */
  staged: number
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  onClose: () => void
  onAmended: (sha: string) => void
}

/**
 * Amend the current HEAD commit. Git can only rewrite HEAD, so the caller
 * offers this dialog only for that commit; the backend keeps running hooks,
 * signing and the undo entry through the regular amend path.
 */
export function AmendDialog({
  repoId,
  sha,
  subject,
  staged,
  branch,
  onClose,
  onAmended,
}: Props) {
  const { t, plural } = useI18n()
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorOutput, setErrorOutput] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void commitGet(repoId, sha)
      .then((result) => {
        if (cancelled) return
        setDetail(result.data)
        setMessage(result.data.message.trimEnd())
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, sha])

  /** The reader caps messages at 64k chars: editing a capped text would drop
   * the tail, so that case amends the staged changes only. */
  const keepMessage = detail?.messageTruncated === true
  const trimmed = message.trim()
  const messageChanged = detail !== null && !keepMessage && trimmed !== detail.message.trim()
  const changes = staged > 0 || messageChanged
  const canSubmit =
    detail !== null && !loading && !busy && changes && (keepMessage || trimmed.length > 0)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setErrorOutput(null)
    try {
      // Git amends whatever HEAD points at now, not the commit this dialog was
      // opened for. Refuse if HEAD moved meanwhile instead of rewriting another
      // commit.
      const head = await refsGet(repoId)
      if (head.data.head?.oid !== sha) {
        setError(
          t('commit.amend.headMoved'),
        )
        setBusy(false)
        return
      }
      const result = await commitCreate({
        repoId,
        message: keepMessage ? '' : message,
        amend: true,
        keepMessage,
      })
      onAmended(result.data.sha)
    } catch (cause) {
      setError(errorMessage(cause))
      setErrorOutput(errorDetail(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="amend-title">
      <h2 id="amend-title">{t('commit.amend.title', { target: subject.trim() || sha.slice(0, 10) })}</h2>
      <p className={styles.warning} role="note">
        {t('commit.amend.rewritesHistory')} <code>{sha.slice(0, 10)}</code>{' '}
        {t('commit.amend.replaced')}{' '}
        {branch
          ? t('commit.amend.branchHint', { branch })
          : t('commit.amend.detachedHint')}
      </p>

      {loading ? (
        <p className={shared.notice} role="status">{t('commit.amend.loading')}</p>
      ) : keepMessage ? (
        <p className={shared.notice}>
          {t('commit.amend.truncatedNotice')}
        </p>
      ) : (
        <label className={shared.field}>
          {t('commit.amend.messageLabel')}
          <textarea
            className={shared.textarea}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-label={t('commit.amend.messageAria')}
            spellCheck
            disabled={busy}
          />
        </label>
      )}

      <p className={shared.notice}>
        {staged > 0
          ? plural('commit.amend.staged.one', 'commit.amend.staged.other', staged)
          : t('commit.amend.noStaged')}
      </p>
      {!loading && !changes ? (
        <p className={shared.notice}>
          {t('commit.amend.noChanges')}
        </p>
      ) : null}

      {error ? (
        <div className={shared.danger} role="alert">
          <p>{error}</p>
          {errorOutput ? <pre className={shared.output}>{errorOutput}</pre> : null}
        </div>
      ) : null}

      <div className={shared.dialogActions}>
        <Button type="button" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? t('commit.amend.amending') : t('commit.amend.submit')}
        </Button>
      </div>
    </Dialog>
  )
}
