import { useCallback, useEffect, useState } from 'react'
import {
  worktreeAdd,
  worktreeList,
  worktreeLock,
  worktreePrune,
  worktreeRemove,
  worktreeUnlock,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { WorktreeEntry, WorktreeReport } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
  onOpenRepo: (path: string) => void
}

export function WorktreesPanel({ repoId, generation, onMutated, onOpenRepo }: Props) {
  const [report, setReport] = useState<WorktreeReport | null>(null)
  const [path, setPath] = useState('')
  const [reference, setReference] = useState('HEAD')
  const [newBranch, setNewBranch] = useState('')
  const [detach, setDetach] = useState(false)
  const [lockReason, setLockReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<WorktreeEntry | null>(null)

  const load = useCallback(async () => {
    try {
      setReport(await worktreeList(repoId, true))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, generation])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={p2.page}>
      <div className={p2.stack} style={{ flex: 1, maxWidth: 1050 }}>
        <div className={p2.between}>
          <h2 className={p2.cardTitle}>Worktrees</h2>
          <div className={p2.row}>
            <button
              type="button"
              className={p2.secondary}
              disabled={busy}
              onClick={() => void run('Prune (simulation) terminé.', () => worktreePrune(repoId, true))}
            >
              Prune (simulation)
            </button>
            <button
              type="button"
              className={p2.secondary}
              disabled={busy}
              onClick={() => void run('Prune terminé.', () => worktreePrune(repoId, false))}
            >
              Prune
            </button>
          </div>
        </div>
        <p className={p2.notice}>
          Chaque worktree possède sa session et son statut. Ouvrez-le dans un
          onglet pour travailler dessus sans changer de répertoire.
        </p>
        {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
        {notice ? <p className={p2.notice}>{notice}</p> : null}

        <div className={p2.table}>
          <div className={p2.tableHead}>
            <span>Chemin</span>
            <span>Branche</span>
            <span>État</span>
            <span />
          </div>
          {report?.entries.length ? null : (
            <div className={p2.empty} style={{ padding: 20 }}>
              Chargement…
            </div>
          )}
          {report?.entries.map((entry) => (
            <div key={entry.path} className={p2.tableRow}>
              <div style={{ minWidth: 0 }}>
                <div className={p2.listSub} style={{ color: 'var(--text)' }}>
                  {entry.path.split('/').pop() ?? entry.path}
                  {entry.main ? ' · principal' : ''}
                </div>
                <div className={p2.listSub}>{entry.path}</div>
              </div>
              <span className={p2.mono}>
                {entry.branch ?? (entry.detached ? 'detached' : '—')}
              </span>
              <span>
                {entry.locked !== undefined ? (
                  <span className={p2.warn}>verrouillé</span>
                ) : entry.dirty === undefined ? (
                  <span className={p2.muted}>statut inconnu</span>
                ) : entry.dirty ? (
                  <span className={p2.warn}>{entry.changedFiles} fichier(s)</span>
                ) : (
                  <span className={p2.good}>propre</span>
                )}
              </span>
              <span className={p2.row}>
                <button
                  type="button"
                  className={p2.secondary}
                  disabled={busy}
                  onClick={() => onOpenRepo(entry.path)}
                >
                  Ouvrir
                </button>
                {entry.main ? null : (
                  <>
                    {entry.locked !== undefined ? (
                      <button
                        type="button"
                        className={p2.ghost}
                        disabled={busy}
                        onClick={() =>
                          void run('Déverrouillé.', () => worktreeUnlock({ repoId, path: entry.path }))
                        }
                      >
                        Déverrouiller
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={p2.ghost}
                        disabled={busy}
                        onClick={() =>
                          void run('Verrouillé.', () =>
                            worktreeLock({
                              repoId,
                              path: entry.path,
                              reason: lockReason.trim() || undefined,
                            }),
                          )
                        }
                      >
                        Verrouiller
                      </button>
                    )}
                    <button
                      type="button"
                      className={p2.danger}
                      disabled={busy}
                      onClick={() => setPendingRemove(entry)}
                    >
                      Retirer
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        <h3 className={p2.sectionTitle}>Créer un worktree</h3>
        <div className={p2.row}>
          <label className={p2.field} style={{ flex: 2 }}>
            Chemin absolu
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/Users/you/src/project-feature"
              spellCheck={false}
            />
          </label>
          <label className={p2.field}>
            Référence
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="HEAD ou feature/x"
              spellCheck={false}
            />
          </label>
          <label className={p2.field}>
            Nouvelle branche (optionnel)
            <input
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
              placeholder="feature/nouvelle"
              spellCheck={false}
            />
          </label>
          <label className={p2.checkbox}>
            <input type="checkbox" checked={detach} onChange={(event) => setDetach(event.target.checked)} />
            detached
          </label>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || !path.trim() || !reference.trim()}
            onClick={() =>
              void run('Worktree créé.', async () => {
                await worktreeAdd({
                  repoId,
                  path: path.trim(),
                  reference: reference.trim(),
                  newBranch: newBranch.trim() || undefined,
                  detach,
                })
                setPath('')
                setNewBranch('')
              })
            }
          >
            Créer
          </button>
        </div>
        <label className={p2.field} style={{ maxWidth: 420 }}>
          Raison de verrouillage (optionnel)
          <input
            value={lockReason}
            onChange={(event) => setLockReason(event.target.value)}
            placeholder="maintenance, disque externe…"
          />
        </label>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Retirer un worktree"
        consequence={`Le worktree ${pendingRemove?.path ?? ''} sera retiré. Git refuse si des modifications non commitées existent, sauf suppression forcée.`}
        irreversible
        typed={pendingRemove?.dirty ? pendingRemove.path : undefined}
        confirmLabel="Retirer"
        busy={busy}
        onCancel={() => setPendingRemove(null)}
        onConfirm={(typed) => {
          const target = pendingRemove
          setPendingRemove(null)
          if (!target) {
            return
          }
          void run('Worktree retiré.', () =>
            worktreeRemove({
              repoId,
              path: target.path,
              force: Boolean(target.dirty),
              confirmation: {
                acknowledged: true,
                typed: target.dirty ? typed : undefined,
              },
            }),
          )
        }}
      />
    </div>
  )
}
