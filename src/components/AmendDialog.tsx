import { useEffect, useState } from 'react'
import { commitCreate, commitGet, refsGet } from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
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
          'HEAD a changé depuis l’ouverture : Git n’amenderait plus le commit affiché. Fermez cette boîte de dialogue et relancez l’amendement.',
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
      <h2 id="amend-title">Amender {subject.trim() || sha.slice(0, 10)}</h2>
      <p className={styles.warning} role="note">
        Amender réécrit l’historique : <code>{sha.slice(0, 10)}</code> est
        remplacé par un nouveau commit.{' '}
        {branch
          ? `La branche ${branch} pointera vers le nouveau commit. S’il est déjà poussé, un push --force-with-lease sera nécessaire et les autres clones devront se resynchroniser.`
          : 'HEAD est détachée : le commit amendé ne sera référencé par aucune branche tant que vous n’en créez pas une.'}
      </p>

      {loading ? (
        <p className={shared.notice} role="status">Lecture du commit…</p>
      ) : keepMessage ? (
        <p className={shared.notice}>
          Le message dépasse la limite de lecture et n’est pas modifiable ici ;
          seules les modifications préparées seront amendées.
        </p>
      ) : (
        <label className={shared.field}>
          Message du commit
          <textarea
            className={shared.textarea}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-label="Message du commit à amender"
            spellCheck
            disabled={busy}
          />
        </label>
      )}

      <p className={shared.notice}>
        {staged > 0
          ? `${staged} fichier${staged > 1 ? 's' : ''} préparé${staged > 1 ? 's' : ''} ${staged > 1 ? 'seront inclus' : 'sera inclus'} dans le commit amendé.`
          : 'Aucune modification préparée : seul le message sera modifié. Préparez des fichiers dans l’onglet Statut pour les inclure.'}
      </p>
      {!loading && !changes ? (
        <p className={shared.notice}>
          Modifiez le message ou préparez des fichiers pour pouvoir amender.
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
          Annuler
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? 'Amendement…' : 'Amender le commit'}
        </Button>
      </div>
    </Dialog>
  )
}
