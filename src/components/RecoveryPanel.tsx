import { useCallback, useEffect, useState } from 'react'
import { operationJournal, recoveryList, undoAcknowledge, undoFailed } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { OperationRecord, RecoveryItem, UndoEntry } from '../types/git'
import shared from './p1.module.css'
import styles from './RecoveryPanel.module.css'

type Props = {
  onOpenRepo: (path: string) => void
}

function operationLabel(item: RecoveryItem): string {
  const state = item.state
  if (!state?.operation) {
    return 'aucune opération Git en cours'
  }
  switch (state.operation.kind) {
    case 'merge':
      return 'merge interrompu'
    case 'rebase':
      return `rebase interrompu (${state.operation.variant})`
    case 'cherryPick':
      return 'cherry-pick interrompu'
    case 'revert':
      return 'revert interrompu'
    case 'sequencer':
      return `séquence ${state.operation.sequencer} interrompue`
    case 'bisect':
      return 'bisect en cours'
  }
}

export function RecoveryPanel({ onOpenRepo }: Props) {
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
          <h2>Reprise après interruption</h2>
          <p>
            Vérifiez les opérations interrompues avant de reprendre votre travail.
            Les verrous détectés restent en place jusqu’à votre intervention.
          </p>
        </div>
        <button type="button" onClick={() => void reload()} className={styles.refresh}>
          Revalider
        </button>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className={styles.empty}>Lecture du journal…</p>
      ) : null}

      {!loading && items.length === 0 ? (
        <p className={styles.empty}>
          Aucune opération interrompue. Vous pouvez continuer à travailler.
        </p>
      ) : null}

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.operation.id} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.kind}>{item.operation.kind}</span>
              <span className={styles.state}>{item.operation.state}</span>
              <span className={styles.date}>
                {new Date(item.operation.updatedAt * 1000).toLocaleString('fr-FR')}
              </span>
            </div>
            <p className={styles.path}>{item.operation.repoPath ?? 'dépôt inconnu'}</p>
            <p className={styles.opState}>{operationLabel(item)}</p>
            {item.locks.length > 0 ? (
              <ul className={styles.locks}>
                {item.locks.map((lock) => (
                  <li key={lock}>
                    Verrou détecté : <code>{lock}</code> — vérifiez qu'aucun autre
                    processus Git ne tourne.
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
                Ouvrir le dépôt
              </button>
            </div>
          </li>
        ))}
      </ul>

      <section className={shared.card} style={{ marginTop: 16 }} aria-labelledby="undo-recovery-title">
        <h2 id="undo-recovery-title">Annulations en échec</h2>
        <p className={shared.notice}>
          Aucun fichier n'est copié par l'application. Une restauration partielle
          conserve l'étape, la commande et le SHA de récupération ; utilisez
          <code> git reflog </code> pour retrouver l'état antérieur.
        </p>
        <div className={shared.list}>
          {failed.map((record) => (
            <div key={record.id} className={shared.item}>
              <div>
                <span>
                  {record.label} · {record.state}
                </span>
                <span className={shared.mono}>
                  {record.step ? `étape ${record.step}` : ''}
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
                Marquer comme vu
              </button>
            </div>
          ))}
          {failed.length === 0 ? (
            <p className={shared.notice}>Aucune annulation en échec.</p>
          ) : null}
        </div>
      </section>

      <section className={`${shared.card}`} style={{ marginTop: 16 }}>
        <h2>Journal des opérations récentes</h2>
        <p className={shared.notice}>
          Chaque action destructive (discard, suppression de branche, force push,
          drop de stash, abort) est journalisée avec ses conséquences. Aucune
          sauvegarde applicative n'est créée.
        </p>
        <div className={shared.list}>
          {journal.map((record) => (
            <div key={record.id} className={shared.item}>
              <div>
                <span>
                  {record.kind} · {record.state}
                </span>
                <span className={shared.mono}>
                  {new Date(record.updatedAt * 1000).toLocaleString('fr-FR')}
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
            <p className={shared.notice}>Journal vide.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
