import { useCallback, useEffect, useState } from 'react'
import {
  submoduleAdd,
  submoduleList,
  submoduleSync,
  submoduleUpdate,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { SubmoduleReport, SubmoduleState } from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

function stateLabel(state: SubmoduleState): { text: string; className: string } {
  switch (state) {
    case 'upToDate':
      return { text: 'à jour', className: p2.good }
    case 'modified':
      return { text: 'pointeur modifié', className: p2.warn }
    case 'notInitialized':
      return { text: 'non initialisé', className: p2.muted }
    case 'conflict':
      return { text: 'conflit', className: p2.bad }
  }
}

export function SubmodulesPanel({ repoId, generation, onMutated }: Props) {
  const [report, setReport] = useState<SubmoduleReport | null>(null)
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [remote, setRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setReport(await submoduleList(repoId))
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
    <div className={p2.pageColumn}>
      <div className={p2.between}>
        <h2 className={p2.cardTitle}>Sous-modules</h2>
        <div className={p2.row}>
          <label className={p2.checkbox}>
            <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
            récursif
          </label>
          <label className={p2.checkbox}>
            <input type="checkbox" checked={remote} onChange={(event) => setRemote(event.target.checked)} />
            suivre la branche distante
          </label>
          <button
            type="button"
            className={p2.secondary}
            disabled={busy}
            onClick={() =>
              void run('Submodules initialisés / mis à jour.', () =>
                submoduleUpdate({ repoId, init: true, recursive, remote }),
              )
            }
          >
            Init / Update
          </button>
          <button
            type="button"
            className={p2.secondary}
            disabled={busy}
            onClick={() => void run('Configuration synchronisée.', () => submoduleSync({ repoId, recursive }))}
          >
            Sync
          </button>
        </div>
      </div>
      <p className={p2.notice}>
        Les opérations récursives sont bornées et n’avancent un pointeur que sur
        action explicite.
      </p>
      {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
      {notice ? <p className={p2.notice}>{notice}</p> : null}

      <div className={p2.split} style={{ overflow: 'auto' }}>
        <div className={p2.splitMain}>
          <div className={p2.table}>
            <div className={p2.tableHead}>
              <span>Chemin</span>
              <span>Commit</span>
              <span>État</span>
              <span />
            </div>
            {report?.entries.map((entry) => {
              const label = stateLabel(entry.state)
              return (
                <div key={entry.path} className={p2.tableRow}>
                  <div style={{ minWidth: 0 }}>
                    <div className={p2.mono}>{entry.path}</div>
                    <div className={p2.listSub}>{entry.describe ?? (entry.nested ? 'imbriqué' : '')}</div>
                  </div>
                  <span className={p2.listSub}>{entry.sha.slice(0, 10)}</span>
                  <span className={label.className}>{label.text}</span>
                  <span className={p2.row}>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() =>
                        void run(`Pointeur mis à jour pour ${entry.path}.`, () =>
                          submoduleUpdate({
                            repoId,
                            path: entry.path,
                            init: true,
                            recursive: false,
                            remote,
                          }),
                        )
                      }
                    >
                      Update
                    </button>
                    <button
                      type="button"
                      className={p2.ghost}
                      disabled={busy}
                      onClick={() =>
                        void run(`Configuration synchronisée pour ${entry.path}.`, () =>
                          submoduleSync({ repoId, path: entry.path, recursive: false }),
                        )
                      }
                    >
                      Sync
                    </button>
                  </span>
                </div>
              )
            })}
            {report && report.entries.length === 0 ? (
              <p className={p2.notice} style={{ padding: 12 }}>
                Aucun sous-module dans ce dépôt.
              </p>
            ) : null}
          </div>
          {report?.truncated ? (
            <p className={p2.warn}>Liste plafonnée à 500 sous-modules.</p>
          ) : null}
        </div>

        <div className={p2.splitSide}>
          <h3 className={p2.cardTitle}>Ajouter un sous-module</h3>
          <label className={p2.field}>
            URL
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://gitlab.example.com/team/sdk.git"
              spellCheck={false}
            />
          </label>
          <label className={p2.field}>
            Chemin
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="vendor/sdk" spellCheck={false} />
          </label>
          <label className={p2.field}>
            Branche suivie (optionnel)
            <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" spellCheck={false} />
          </label>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || !url.trim() || !path.trim()}
            onClick={() =>
              void run('Sous-module ajouté.', async () => {
                await submoduleAdd({
                  repoId,
                  url: url.trim(),
                  path: path.trim(),
                  branch: branch.trim() || undefined,
                })
                setUrl('')
                setPath('')
                setBranch('')
              })
            }
          >
            Ajouter
          </button>
          <p className={p2.notice}>
            Les URL avec mot de passe et les protocoles exotiques sont refusés.
          </p>
        </div>
      </div>
    </div>
  )
}
