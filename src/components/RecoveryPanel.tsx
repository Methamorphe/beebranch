import { useCallback, useEffect, useState } from 'react'
import { operationJournal, recoveryList, undoAcknowledge, undoFailed } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { dateFromSeconds, formatDateTime, t, useI18n } from '../i18n'
import { undoActionLabel } from '../lib/undoLabel'
import type { OperationRecord, RecoveryItem, UndoEntry } from '../types/git'
import shared from './p1.module.css'
import styles from './RecoveryPanel.module.css'

type Props = {
  onOpenRepo: (path: string) => void
}

function operationLabel(item: RecoveryItem): string {
  const state = item.state
  if (!state?.operation) {
    return t('ops.recovery.noOperation')
  }
  switch (state.operation.kind) {
    case 'merge':
      return t('ops.recovery.mergeInterrupted')
    case 'rebase':
      return t('ops.recovery.rebaseInterrupted', { variant: state.operation.variant })
    case 'cherryPick':
      return t('ops.recovery.cherryPickInterrupted')
    case 'revert':
      return t('ops.recovery.revertInterrupted')
    case 'sequencer':
      return t('ops.recovery.sequencerInterrupted', { sequencer: state.operation.sequencer })
    case 'bisect':
      return t('ops.recovery.bisectRunning')
  }
}

export function RecoveryPanel({ onOpenRepo }: Props) {
  const { t } = useI18n()
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [journal, setJournal] = useState<OperationRecord[]>([])
  const [failed, setFailed] = useState<UndoEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextItems, nextJournal, nextFailed] = await Promise.all([
        recoveryList() as Promise<RecoveryItem[]>,
        operationJournal(100),
        undoFailed(50),
      ])
      setItems(nextItems)
      setJournal(nextJournal)
      setFailed(nextFailed)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h2>{t('ops.recovery.title')}</h2>
          <p>{t('ops.recovery.intro')}</p>
        </div>
        <button type="button" onClick={() => void reload()} className={styles.refresh}>
          {t('ops.recovery.refresh')}
        </button>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className={styles.empty}>{t('ops.recovery.loading')}</p>
      ) : null}

      {!loading && items.length === 0 ? (
        <p className={styles.empty}>{t('ops.recovery.empty')}</p>
      ) : null}

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.operation.id} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.kind}>{item.operation.kind}</span>
              <span className={styles.state}>{item.operation.state}</span>
              <span className={styles.date}>
                {formatDateTime(dateFromSeconds(item.operation.updatedAt))}
              </span>
            </div>
            <p className={styles.path}>{item.operation.repoPath ?? t('ops.recovery.unknownRepo')}</p>
            <p className={styles.opState}>{operationLabel(item)}</p>
            {item.locks.length > 0 ? (
              <ul className={styles.locks}>
                {item.locks.map((lock) => (
                  <li key={lock}>
                    {t('ops.recovery.lockDetectedPrefix')} <code>{lock}</code>{' '}
                    {t('ops.recovery.lockDetectedSuffix')}
                  </li>
                ))}
              </ul>
            ) : null}
            {item.operation.detail ? (
              <pre className={styles.detail}>{item.operation.detail}</pre>
            ) : null}
            <p className={styles.remediation}>{item.remediation}</p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={!item.repoAvailable || !item.operation.repoPath}
                onClick={() => {
                  if (item.operation.repoPath) {
                    onOpenRepo(item.operation.repoPath)
                  }
                }}
              >
                {t('ops.recovery.openRepo')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <section className={shared.card} style={{ marginTop: 16 }} aria-labelledby="undo-recovery-title">
        <h2 id="undo-recovery-title">{t('ops.recovery.failedTitle')}</h2>
        <p className={shared.notice}>
          {t('ops.recovery.failedNoticePrefix')}
          <code> git reflog </code> {t('ops.recovery.failedNoticeSuffix')}
        </p>
        <div className={shared.list}>
          {failed.map((record) => (
            <div key={record.id} className={shared.item}>
              <div>
                <span>
                  {undoActionLabel(record)} · {record.state}
                </span>
                <span className={shared.mono}>
                  {record.step ? t('ops.recovery.undoStep', { step: record.step }) : ''}
                  {record.command ? ` · ${record.command}` : ''}
                  {record.recoverySha ? ` · sha ${record.recoverySha}` : ''}
                  {record.detail ? ` · ${record.detail}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() =>
                  void undoAcknowledge(record.id).then(() => void reload())
                }
              >
                {t('ops.recovery.acknowledge')}
              </button>
            </div>
          ))}
          {failed.length === 0 ? (
            <p className={shared.notice}>{t('ops.recovery.noFailedUndo')}</p>
          ) : null}
        </div>
      </section>

      <section className={`${shared.card}`} style={{ marginTop: 16 }}>
        <h2>{t('ops.recovery.journalTitle')}</h2>
        <p className={shared.notice}>
          {t('ops.recovery.journalNotice')}
        </p>
        <div className={shared.list}>
          {journal.map((record) => (
            <div key={record.id} className={shared.item}>
              <div>
                <span>
                  {record.kind} · {record.state}
                </span>
                <span className={shared.mono}>
                  {formatDateTime(dateFromSeconds(record.updatedAt))}
                  {record.repoPath ? ` · ${record.repoPath}` : ''}
                  {record.detail ? ` · ${record.detail}` : ''}
                </span>
              </div>
              {record.errorCode ? (
                <span className={`${shared.badge} ${shared.error}`}>{record.errorCode}</span>
              ) : null}
            </div>
          ))}
          {journal.length === 0 ? (
            <p className={shared.notice}>{t('ops.recovery.journalEmpty')}</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
