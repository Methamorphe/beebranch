import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../ipc/client'
import {
  workspaceAddRepo,
  workspaceCreate,
  workspaceDelete,
  workspaceList,
  workspaceRemoveRepo,
  workspaceRename,
  workspaceStatus,
  workspaceSync,
} from '../ipc/commands'
import type {
  Workspace,
  WorkspaceRepoStatus,
  WorkspaceSyncResult,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import shared from './p1.module.css'

type Props = {
  onOpenRepo: (path: string) => void
}

const REPO_LIMIT = 20

function headLabel(status: WorkspaceRepoStatus): string {
  const head = status.state?.head
  if (head?.kind === 'branch') {
    return head.name + (head.upstream ? ` → ${head.upstream}` : '')
  }
  if (head?.kind === 'detached') return `HEAD ${head.sha.slice(0, 8)}`
  return 'branche inconnue'
}

export function WorkspacesPanel({ onOpenRepo }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<WorkspaceRepoStatus[]>([])
  const [results, setResults] = useState<WorkspaceSyncResult[]>([])
  const [name, setName] = useState('')
  const [rename, setRename] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [pendingPull, setPendingPull] = useState(false)

  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null

  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await workspaceList()
      setWorkspaces(next)
      setSelectedId((current) => current ?? next[0]?.id ?? null)
      if (next[0] && !currentExists(next, selectedId)) {
        setSelectedId(next[0].id)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [selectedId])

  const loadStatus = useCallback(async (workspaceId: string) => {
    try {
      setStatuses(await workspaceStatus(workspaceId))
    } catch (cause) {
      setError(errorMessage(cause))
      setStatuses([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    setStatuses([])
    setResults([])
    if (selectedId) {
      void loadStatus(selectedId)
    }
  }, [selectedId, loadStatus])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const sync = async (action: 'fetch' | 'pull') => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setResults([])
    try {
      const next = await workspaceSync(
        selected.id,
        action,
        action === 'pull' ? { acknowledged: true } : undefined,
      )
      setResults(next)
      const failures = next.filter((result) => !result.ok).length
      setNotice(
        `${next.length - failures}/${next.length} dépôt(s) ${action === 'fetch' ? 'récupéré(s)' : 'mis à jour'}${failures ? ` · ${failures} échec(s)` : ''}.`,
      )
      await loadStatus(selected.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={shared.root}>
      <section className={shared.card} aria-labelledby="workspace-list-title">
        <div className={shared.row}>
          <h2 id="workspace-list-title">Workspaces</h2>
          <span className={shared.badge}>{workspaces.length}</span>
          <button type="button" className={shared.secondary} onClick={() => void reload()}>
            Recharger
          </button>
        </div>
        <div className={shared.list} role="list">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="listitem"
              aria-current={workspace.id === selectedId ? 'true' : undefined}
              className={`${shared.item} ${workspace.id === selectedId ? shared.itemSelected : ''}`}
              onClick={() => setSelectedId(workspace.id)}
            >
              <span>{workspace.name}</span>
              <span className={shared.mono}>{workspace.repos.length} dépôt(s)</span>
            </button>
          ))}
          {workspaces.length === 0 ? (
            <p className={shared.notice}>Aucun workspace. Créez-en un ci-dessous.</p>
          ) : null}
        </div>
        <div className={shared.row} style={{ marginTop: 12, marginBottom: 0 }}>
          <label className={shared.field}>
            Nom du workspace
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nom du workspace"
              aria-label="Nom du nouveau workspace"
            />
          </label>
          <button
            type="button"
            className={shared.primary}
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(`Workspace ${name} créé.`, async () => {
                const created = await workspaceCreate(name.trim())
                setName('')
                await reload()
                setSelectedId(created.id)
              })
            }
          >
            Créer
          </button>
        </div>
      </section>

      {selected ? (
        <>
          <section className={shared.card} aria-labelledby="workspace-detail-title">
            <div className={shared.row}>
              <h2 id="workspace-detail-title">{selected.name}</h2>
              <span className={shared.notice}>
                {selected.repos.length}/{REPO_LIMIT} dépôts
              </span>
              <button
                type="button"
                className={shared.secondary}
                onClick={() => {
                  setRename(selected.name)
                }}
              >
                Renommer
              </button>
              <button
                type="button"
                className={shared.dangerButton}
                onClick={() => setPendingDelete(true)}
              >
                Supprimer
              </button>
            </div>
            {rename ? (
              <div className={shared.row}>
                <input
                  className={shared.field}
                  value={rename}
                  onChange={(event) => setRename(event.target.value)}
                  aria-label="Nouveau nom du workspace"
                />
                <button
                  type="button"
                  className={shared.primary}
                  disabled={busy || !rename.trim()}
                  onClick={() =>
                    void run('Workspace renommé.', async () => {
                      await workspaceRename(selected.id, rename.trim())
                      setRename('')
                      await reload()
                    })
                  }
                >
                  Enregistrer
                </button>
                <button type="button" className={shared.secondary} onClick={() => setRename('')}>
                  Annuler
                </button>
              </div>
            ) : null}
            <div className={shared.row}>
              <label className={shared.field}>
                Chemin du dépôt
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/chemin/absolu/vers/le/dépôt"
                  aria-label="Chemin du dépôt à ajouter"
                />
              </label>
              <button
                type="button"
                className={shared.primary}
                disabled={busy || !path.trim() || selected.repos.length >= REPO_LIMIT}
                onClick={() =>
                  void run('Dépôt ajouté au workspace.', async () => {
                    await workspaceAddRepo(selected.id, path.trim())
                    setPath('')
                    await reload()
                    await loadStatus(selected.id)
                  })
                }
              >
                Ajouter
              </button>
            </div>
            <div className={shared.row}>
              <button
                type="button"
                className={shared.secondary}
                disabled={busy || selected.repos.length === 0}
                onClick={() => void sync('fetch')}
              >
                Fetch tous les dépôts
              </button>
              <button
                type="button"
                className={shared.primary}
                disabled={busy || selected.repos.length === 0}
                onClick={() => setPendingPull(true)}
              >
                Pull tous les dépôts
              </button>
              <button
                type="button"
                className={shared.secondary}
                disabled={busy}
                onClick={() => void loadStatus(selected.id)}
              >
                Actualiser les états
              </button>
            </div>
            {error ? (
              <p className={shared.danger} role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className={shared.notice} role="status">
                {notice}
              </p>
            ) : null}
          </section>

          <section className={shared.card} aria-labelledby="workspace-status-title">
            <h2 id="workspace-status-title">État par dépôt</h2>
            <div className={shared.list}>
              {statuses.map((status) => (
                <div key={status.path} className={shared.item}>
                  <div>
                    <span>{status.name ?? status.path}</span>
                    <span className={shared.mono}>{status.path}</span>
                    <span className={shared.mono}>
                      {status.available
                        ? `${headLabel(status)} · ${status.state?.worktree.staged ?? 0} préparé(s) / ${status.state?.worktree.unstaged ?? 0} modifié(s) / ${status.state?.worktree.untracked ?? 0} nouveau(x)`
                        : status.error}
                    </span>
                  </div>
                  <div className={shared.row} style={{ marginBottom: 0 }}>
                    <button
                      type="button"
                      className={shared.small}
                      disabled={!status.available}
                      onClick={() => onOpenRepo(status.path)}
                    >
                      Ouvrir
                    </button>
                    <button
                      type="button"
                      className={shared.small}
                      disabled={busy}
                      onClick={() =>
                        void run('Dépôt retiré du workspace.', async () => {
                          await workspaceRemoveRepo(selected.id, status.path)
                          await reload()
                          await loadStatus(selected.id)
                        })
                      }
                    >
                      Retirer
                    </button>
                  </div>
                </div>
              ))}
              {statuses.length === 0 ? (
                <p className={shared.notice}>Aucun dépôt dans ce workspace.</p>
              ) : null}
            </div>
          </section>

          {results.length > 0 ? (
            <section className={shared.card} aria-labelledby="workspace-results-title">
              <h2 id="workspace-results-title">Résultat de la dernière action</h2>
              <div className={shared.list}>
                {results.map((result) => (
                  <div key={result.path} className={shared.item}>
                    <div>
                      <span>
                        {result.ok ? '✓' : '✗'} {result.name ?? result.path}
                      </span>
                      <span className={shared.mono}>
                        {result.ok
                          ? result.message || 'succès'
                          : `${result.errorCode ?? 'erreur'} · ${result.message}`}
                      </span>
                    </div>
                    <span className={result.ok ? shared.badge : shared.danger}>
                      {result.ok ? 'ok' : 'échec'}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pendingDelete}
        title={`Supprimer le workspace ${selected?.name ?? ''}`}
        consequence="Le groupe local est supprimé. Aucun dépôt, aucune branche et aucun fichier n'est modifié ou supprimé."
        confirmLabel="Supprimer le groupe"
        busy={busy}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          const target = selected
          setPendingDelete(false)
          if (!target) return
          void run('Workspace supprimé.', async () => {
            await workspaceDelete(target.id)
            await reload()
          })
        }}
      />
      <ConfirmDialog
        open={pendingPull}
        title={`Pull sur ${selected?.repos.length ?? 0} dépôt(s)`}
        consequence="Chaque dépôt propre avec upstream est mis à jour indépendamment. Un dépôt sale ou sans upstream est signalé ; les autres continuent. Aucun push n'est effectué."
        confirmLabel="Lancer les pulls"
        busy={busy}
        onCancel={() => setPendingPull(false)}
        onConfirm={() => {
          setPendingPull(false)
          void sync('pull')
        }}
      />
    </div>
  )
}

function currentExists(workspaces: Workspace[], id: string | null): boolean {
  return Boolean(id && workspaces.some((workspace) => workspace.id === id))
}
