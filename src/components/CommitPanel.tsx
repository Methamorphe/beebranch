import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { commitConfig, commitCreate, statusGet } from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { CommitConfigView, CommitOutcome, OperationProgress, StatusReport } from '../types/git'
import shared from './p1.module.css'
import styles from './CommitPanel.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
  onUndo?: () => Promise<unknown>
  compact?: boolean
}

const drafts = new Map<string, string>()

export function CommitPanel({ repoId, generation, onMutated, onUndo, compact = false }: Props) {
  const { t, plural } = useI18n()
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
  const [copied, setCopied] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [hookLog, setHookLog] = useState<string[]>([])
  const hooking = useRef(false)

  // Git executes the hooks itself: the backend announces them and streams their
  // output while the commit runs. The listener stays mounted so the first lines
  // emitted right after `commit_create` are not missed.
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null
    void listen<OperationProgress>('op://progress', (event) => {
      if (disposed || !hooking.current || event.payload.repoId !== repoId) {
        return
      }
      const line = `[${event.payload.stream}] ${event.payload.line}`
      setHookLog((current) => [...current.slice(-199), line])
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        stop = unlisten
      }
    })
    return () => {
      disposed = true
      stop?.()
    }
  }, [repoId])

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

  const canSubmit =
    !busy &&
    Boolean(status) &&
    (status?.counts.conflicted ?? 0) === 0 &&
    (allowEmpty || amend || (status?.counts.staged ?? 0) > 0) &&
    (message.trim().length > 0 || (amend && keepMessage))

  const submit = async () => {
    if (!canSubmit) {
      return
    }
    setBusy(true)
    setError(null)
    setErrorOutput(null)
    setOutcome(null)
    setCopied(false)
    setHookLog([])
    hooking.current = true
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
      hooking.current = false
      setBusy(false)
    }
  }

  const copySha = async () => {
    if (!outcome || !navigator.clipboard) {
      return
    }
    try {
      await navigator.clipboard.writeText(outcome.sha)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const undoCommit = async () => {
    if (!onUndo) {
      return
    }
    setUndoing(true)
    try {
      await onUndo()
      setOutcome(null)
    } catch {
      // App owns the user-facing error for a failed undo.
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div className={compact ? styles.compact : shared.root}>
      <div className={compact ? styles.stack : shared.columns}>
        <section className={shared.card}>
          <h2>{t('commit.panel.title')}</h2>
          <textarea
            className={shared.textarea}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={t('commit.panel.placeholder')}
            aria-label={t('commit.panel.messageAria')}
            spellCheck
          />
          <details className={styles.options}><summary>{t('commit.panel.options')}{amend ? ` · ${t('commit.panel.optionsAmend')}` : ''}{allowEmpty ? ` · ${t('commit.panel.optionsEmpty')}` : ''}</summary><div className={shared.row}>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={amend}
                onChange={(event) => setAmend(event.target.checked)}
              />
              {t('commit.panel.amend')}
            </label>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={amend && keepMessage}
                disabled={!amend}
                onChange={(event) => setKeepMessage(event.target.checked)}
              />
              {t('commit.panel.keepMessage')}
            </label>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={allowEmpty}
                onChange={(event) => setAllowEmpty(event.target.checked)}
              />
              {t('commit.panel.allowEmpty')}
            </label>
          </div>
          <details className={styles.identity}><summary>{t('commit.panel.identity')}</summary>
          {config ? (
            <div className={shared.stack}>
              <span>
                <strong>{config.name}</strong> · {config.email}
              </span>
              <span>
                {t('commit.panel.signature', {
                  state: config.signing
                    ? t('commit.panel.signatureEnabled')
                    : t('commit.panel.signatureDisabled'),
                })}
                {config.signingKey ? ` · ${t('commit.panel.signatureKey', { key: config.signingKey })}` : ''}
                {config.signingFormat ? ` · ${t('commit.panel.signatureFormat', { format: config.signingFormat })}` : ''}
              </span>
            </div>
          ) : (
            <p className={shared.notice}>{t('commit.panel.loadingConfig')}</p>
          )}

          <p className={shared.notice}>{t('commit.panel.hooksNotice')}</p>          </details>
          <button type="button" className={shared.secondary} disabled={busy} onClick={() => setMessage(t('commit.panel.template'))}>{t('commit.panel.useTemplate')}</button>
          </details>
          <button type="button" className={`${shared.primary} ${styles.submit}`}
            disabled={!canSubmit}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title={t('commit.panel.submitTitle')}
            onClick={() => void submit()}>
            {busy
              ? t('commit.panel.creating')
              : amend
                ? t('commit.panel.amendCommit')
                : allowEmpty && !status?.counts.staged
                  ? t('commit.panel.createEmpty')
                  : status?.counts.staged
                    ? plural('commit.panel.createWithFiles.one', 'commit.panel.createWithFiles.other', status.counts.staged)
                    : t('commit.panel.needFiles')}
          </button>
          <p className={styles.shortcutHint}><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>{t('commit.panel.enterKey')}</kbd> {t('commit.panel.toCommit')}</p>
          {hookLog.length > 0 ? (
            <div className={styles.hookLog} role="status" aria-live="polite">
              <p className={styles.hookLogTitle}>
                {busy ? t('commit.panel.hooksRunning') : t('commit.panel.hooksOutput')}
              </p>
              <pre className={shared.output}>{hookLog.join('\n')}</pre>
            </div>
          ) : null}
          {status?.counts.conflicted ? <p className={shared.danger}>{t('commit.panel.conflictsHint')}</p> : null}
          {error ? (
            <div className={shared.danger} role="alert" style={{ marginTop: 10 }}>
              <p>{error}</p>
              {errorOutput && hookLog.length === 0 ? <pre className={shared.output}>{errorOutput}</pre> : null}
            </div>
          ) : null}
          {outcome ? (
            <div className={styles.successFeedback} style={{ marginTop: 10 }}>
              <p className={shared.success} role="status">
                {t('common.commit')} <code>{outcome.sha.slice(0, 12)}</code> {t('commit.panel.created')}
                {outcome.signed ? ` ${t('commit.panel.signed')}` : ''}.
              </p>
              <div className={styles.successActions}>
                <button type="button" className={shared.secondary} onClick={() => void copySha()}>
                  {copied ? t('commit.panel.shaCopied') : t('commit.panel.copySha')}
                </button>
                {onUndo ? (
                  <button type="button" className={shared.secondary} disabled={undoing} onClick={() => void undoCommit()}>
                    {undoing ? t('commit.panel.undoing') : t('commit.panel.undoCommit')}
                  </button>
                ) : null}
              </div>
              {outcome.output ? <pre className={shared.output}>{outcome.output}</pre> : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
