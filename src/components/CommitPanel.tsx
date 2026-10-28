import { useEffect, useState } from 'react'
import { commitConfig, commitCreate, statusGet } from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import type { CommitConfigView, CommitOutcome, StatusReport } from '../types/git'
import shared from './p1.module.css'
import styles from './CommitPanel.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
  compact?: boolean
}

const drafts = new Map<string, string>()

const TEMPLATE = 'Résumé court\n\nCorps du message (optionnel).\n'

export function CommitPanel({ repoId, generation, onMutated, compact = false }: Props) {
  const [message, setDraftMessage] = useState(() => drafts.get(repoId) ?? '')
  const setMessage = (next: string) => { drafts.set(repoId, next); setDraftMessage(next) }
  const [amend, setAmend] = useState(false)
  const [keepMessage, setKeepMessage] = useState(false)
  const [allowEmpty, setAllowEmpty] = useState(false)
  const [config, setConfig] = useState<CommitConfigView | null>(null)
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorOutput, setErrorOutput] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([commitConfig(repoId), statusGet(repoId)])
      .then(([configValue, statusValue]) => {
        if (!cancelled) {
          setConfig(configValue)
          setStatus(statusValue.data)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation])

  const submit = async () => {
    setBusy(true)
    setError(null)
    setErrorOutput(null)
    setOutcome(null)
    try {
      const result = await commitCreate({
        repoId,
        message,
        amend,
        keepMessage: amend && keepMessage,
        allowEmpty,
      })
      setOutcome(result.data)
      setMessage('')
      setAmend(false)
      setKeepMessage(false)
      setAllowEmpty(false)
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
      setErrorOutput(errorDetail(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? styles.compact : shared.root}>
      <div className={compact ? styles.stack : shared.columns}>
        <section className={shared.card}>
          <h2>Nouveau commit</h2>
          <textarea
            className={shared.textarea}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Résumé du commit

Description (facultative)"
            aria-label="Message de commit"
            spellCheck
          />
          <details className={styles.options}><summary>Options du commit{amend ? ' · amend actif' : ''}{allowEmpty ? ' · commit vide autorisé' : ''}</summary><div className={shared.row}>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={amend}
                onChange={(event) => setAmend(event.target.checked)}
              />
              Amend
            </label>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={amend && keepMessage}
                disabled={!amend}
                onChange={(event) => setKeepMessage(event.target.checked)}
              />
              Conserver le message
            </label>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={allowEmpty}
                onChange={(event) => setAllowEmpty(event.target.checked)}
              />
              Autoriser un commit vide
            </label>
          </div>
          <details className={styles.identity}><summary>Identité et signature</summary>
          {config ? (
            <div className={shared.stack}>
              <span>
                <strong>{config.name}</strong> · {config.email}
              </span>
              <span>
                Signature : {config.signing ? 'activée par Git' : 'non configurée'}
                {config.signingKey ? ` · clé ${config.signingKey}` : ''}
                {config.signingFormat ? ` · format ${config.signingFormat}` : ''}
              </span>
            </div>
          ) : (
            <p className={shared.notice}>Lecture de la configuration…</p>
          )}

          <p className={shared.notice}>Les hooks et la signature configurés dans Git sont respectés.</p>          </details>
          <button type="button" className={shared.secondary} disabled={busy} onClick={() => setMessage(TEMPLATE)}>Utiliser un modèle</button>
          </details>
          <button type="button" className={`${shared.primary} ${styles.submit}`}
            disabled={busy || !status || status.counts.conflicted > 0 || (!allowEmpty && !amend && status.counts.staged === 0) || (!message.trim() && !(amend && keepMessage))}
            onClick={() => void submit()}>
            {busy ? 'Création…' : amend ? 'Amender le commit' : allowEmpty && !status?.counts.staged ? 'Créer un commit vide' : status?.counts.staged ? `Créer le commit · ${status.counts.staged} fichier(s)` : 'Préparez des fichiers pour committer'}
          </button>
          {status?.counts.conflicted ? <p className={shared.danger}>Résolvez les conflits avant de committer.</p> : null}
          {error ? (
            <div className={shared.danger} role="alert" style={{ marginTop: 10 }}>
              <p>{error}</p>
              {errorOutput ? <pre className={shared.output}>{errorOutput}</pre> : null}
            </div>
          ) : null}
          {outcome ? (
            <div style={{ marginTop: 10 }}>
              <p className={shared.success} role="status">
                Commit <code>{outcome.sha.slice(0, 12)}</code> créé
                {outcome.signed ? ' (signé)' : ''}.
              </p>
              {outcome.output ? <pre className={shared.output}>{outcome.output}</pre> : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
