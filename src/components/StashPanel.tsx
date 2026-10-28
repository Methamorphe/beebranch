import { useEffect, useState } from 'react'
import {
  stashApply,
  stashCreate,
  stashDrop,
  stashList,
  stashPop,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { StashEntry } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

export function StashPanel({ repoId, generation, onMutated }: Props) {
  const [entries, setEntries] = useState<StashEntry[]>([])
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingDrop, setPendingDrop] = useState<StashEntry | null>(null)

  const load = async () => {
    try {
      setEntries(await stashList(repoId))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, generation])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = (await action()) as { data?: unknown } | undefined
      setNotice(label)
      if (result && typeof result === 'object' && 'data' in result) {
        const data = result.data
        if (typeof data === 'string' && data.length > 0) {
          setNotice(`${label} ${data}`)
        }
      }
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={shared.root}>
      <section className={shared.card}>
        <h2>Créer un stash</h2>
        <div className={shared.row}>
          <label className={shared.field}>
            Message du stash (optionnel)
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Message du stash"
              aria-label="Message du stash"
            />
          </label>
          <label className={shared.checkbox}>
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            Inclure les fichiers non suivis
          </label>
          <button
            type="button"
            className={shared.primary}
            disabled={busy}
            onClick={() =>
              void run('Stash créé.', () =>
                stashCreate({
                  repoId,
                  message: message.trim() || undefined,
                  includeUntracked,
                }),
              )
            }
          >
            Créer le stash
          </button>
        </div>
        <p className={shared.notice}>
          Les fichiers non suivis ne sont jamais inclus implicitement. Un pop en
          conflit laisse le stash intact.
        </p>
        {error ? (
          <p className={shared.danger} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className={shared.notice}>{notice}</p> : null}
      </section>

      <section className={shared.card}>
        <h2>Stashes ({entries.length})</h2>
        <div className={shared.list}>
          {entries.length === 0 ? (
            <div className={shared.empty}><strong>Aucun stash enregistré</strong><p>Mettez vos modifications de côté pour les reprendre plus tard.</p></div>
          ) : null}
          {entries.map((entry) => (
            <div key={entry.selector} className={shared.item}>
              <div>
                <span>{entry.selector} · {entry.message}</span>
                <span className={shared.mono}>
                  {entry.sha.slice(0, 12)} ·{' '}
                  {new Date(entry.timestamp * 1000).toLocaleString('fr-FR')}
                </span>
              </div>
              <div className={shared.row} style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() =>
                    void run(`Stash ${entry.selector} appliqué.`, () =>
                      stashApply(repoId, entry.selector),
                    )
                  }
                >
                  Appliquer
                </button>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() =>
                    void run(`Stash ${entry.selector} poppé.`, () =>
                      stashPop(repoId, entry.selector),
                    )
                  }
                >
                  Appliquer et retirer
                </button>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() => setPendingDrop(entry)}
                >
                  Supprimer…
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={pendingDrop !== null}
        title={`Supprimer ${pendingDrop?.selector ?? ''}`}
        consequence={`L'entrée de stash ${pendingDrop?.selector ?? ''} sera supprimée. Le commit ${pendingDrop?.sha.slice(0, 12) ?? ''} reste récupérable via le reflog Git, sans interface d'undo.`}
        irreversible
        confirmLabel="Supprimer"
        busy={busy}
        onCancel={() => setPendingDrop(null)}
        onConfirm={() => {
          const target = pendingDrop
          setPendingDrop(null)
          if (target) {
            void run(`Stash supprimé · SHA ${target.sha.slice(0, 12)}`, () =>
              stashDrop(repoId, target.selector, { acknowledged: true }),
            )
          }
        }}
      />
    </div>
  )
}
