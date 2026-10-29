import { useCallback, useEffect, useState } from 'react'
import { t, useI18n } from '../i18n'
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
  activeWorkspaceId: string | null
  onActivateWorkspace: (workspaceId: string) => void
  onWorkspacesChanged: (workspaces: Workspace[]) => void
}

const REPO_LIMIT = 20

function headLabel(status: WorkspaceRepoStatus): string {
  const head = status.state?.head
  if (head?.kind === 'branch') {
    return head.name + (head.upstream ? ` → ${head.upstream}` : '')
  }
  if (head?.kind === 'detached') return `HEAD ${head.sha.slice(0, 8)}`
  return t('workspaces.panel.unknownBranch')
}

export function WorkspacesPanel({
  onOpenRepo,
  activeWorkspaceId,
  onActivateWorkspace,
  onWorkspacesChanged,
}: Props) {
  const { t } = useI18n()
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
      onWorkspacesChanged(next)
      setSelectedId((current) => current ?? next[0]?.id ?? null)
      if (next[0] && !currentExists(next, selectedId)) {
        setSelectedId(next[0].id)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [selectedId, onWorkspacesChanged])

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
        t(action === 'fetch' ? 'workspaces.panel.syncFetched' : 'workspaces.panel.syncUpdated', {
          ok: next.length - failures,
          total: next.length,
          failures: failures > 0 ? t('workspaces.panel.syncFailures', { count: failures }) : '',
        }),
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
          <h2 id="workspace-list-title">{t('workspaces.panel.title')}</h2>
          <span className={shared.badge}>{workspaces.length}</span>
          <button type="button" className={shared.secondary} onClick={() => void reload()}>
            {t('common.reload')}
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
              <span>
                {workspace.name}
                {workspace.id === activeWorkspaceId ? (
                  <span className={shared.badge} style={{ marginLeft: 8 }}>
                    {t('workspaces.panel.active')}
                  </span>
                ) : null}
              </span>
              <span className={shared.mono}>{t('workspaces.panel.repoCount', { count: workspace.repos.length })}</span>
            </button>
          ))}
          {workspaces.length === 0 ? (
            <p className={shared.notice}>{t('workspaces.panel.empty')}</p>
          ) : null}
        </div>
        <div className={shared.row} style={{ marginTop: 12, marginBottom: 0 }}>
          <label className={shared.field}>
            {t('workspaces.panel.nameLabel')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('workspaces.panel.namePlaceholder')}
              aria-label={t('workspaces.panel.nameAria')}
            />
          </label>
          <button
            type="button"
            className={shared.primary}
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(t('workspaces.panel.created', { name }), async () => {
                const created = await workspaceCreate(name.trim())
                setName('')
                await reload()
                setSelectedId(created.id)
              })
            }
          >
            {t('common.create')}
          </button>
        </div>
      </section>

      {selected ? (
        <>
          <section className={shared.card} aria-labelledby="workspace-detail-title">
            <div className={shared.row}>
              <h2 id="workspace-detail-title">{selected.name}</h2>
              <span className={shared.notice}>
                {t('workspaces.panel.repoLimit', { count: selected.repos.length, limit: REPO_LIMIT })}
              </span>
              <button
                type="button"
                className={shared.primary}
                disabled={busy}
                onClick={() => onActivateWorkspace(selected.id)}
              >
                {t('workspaces.panel.openTabs')}
              </button>
              <button
                type="button"
                className={shared.secondary}
                onClick={() => {
                  setRename(selected.name)
                }}
              >
                {t('common.rename')}
              </button>
              <button
                type="button"
                className={shared.dangerButton}
                onClick={() => setPendingDelete(true)}
              >
                {t('common.delete')}
              </button>
            </div>
            {rename ? (
              <div className={shared.row}>
                <input
                  className={shared.field}
                  value={rename}
                  onChange={(event) => setRename(event.target.value)}
                  aria-label={t('workspaces.panel.renameAria')}
                />
                <button
                  type="button"
                  className={shared.primary}
                  disabled={busy || !rename.trim()}
                  onClick={() =>
                    void run(t('workspaces.panel.renamed'), async () => {
                      await workspaceRename(selected.id, rename.trim())
                      setRename('')
                      await reload()
                    })
                  }
                >
                  {t('common.save')}
                </button>
                <button type="button" className={shared.secondary} onClick={() => setRename('')}>
                  {t('common.cancel')}
                </button>
              </div>
            ) : null}
            <div className={shared.row}>
              <label className={shared.field}>
                {t('workspaces.panel.pathLabel')}
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={t('workspaces.panel.pathPlaceholder')}
                  aria-label={t('workspaces.panel.pathAria')}
                />
              </label>
              <button
                type="button"
                className={shared.primary}
                disabled={busy || !path.trim() || selected.repos.length >= REPO_LIMIT}
                onClick={() =>
                  void run(t('workspaces.panel.repoAdded'), async () => {
                    await workspaceAddRepo(selected.id, path.trim())
                    setPath('')
                    await reload()
                    await loadStatus(selected.id)
                  })
                }
              >
                {t('common.add')}
              </button>
            </div>
            <div className={shared.row}>
              <button
                type="button"
                className={shared.secondary}
                disabled={busy || selected.repos.length === 0}
                onClick={() => void sync('fetch')}
              >
                {t('workspaces.panel.fetchAll')}
              </button>
              <button
                type="button"
                className={shared.primary}
                disabled={busy || selected.repos.length === 0}
                onClick={() => setPendingPull(true)}
              >
                {t('workspaces.panel.pullAll')}
              </button>
              <button
                type="button"
                className={shared.secondary}
                disabled={busy}
                onClick={() => void loadStatus(selected.id)}
              >
                {t('workspaces.panel.refreshStatus')}
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
            <h2 id="workspace-status-title">{t('workspaces.panel.statusTitle')}</h2>
            <div className={shared.list}>
              {statuses.map((status) => (
                <div key={status.path} className={shared.item}>
                  <div>
                    <span>{status.name ?? status.path}</span>
                    <span className={shared.mono}>{status.path}</span>
                    <span className={shared.mono}>
                      {status.available
                        ? t('workspaces.panel.statusCounts', {
                            head: headLabel(status),
                            staged: status.state?.worktree.staged ?? 0,
                            unstaged: status.state?.worktree.unstaged ?? 0,
                            untracked: status.state?.worktree.untracked ?? 0,
                          })
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
                      {t('common.open')}
                    </button>
                    <button
                      type="button"
                      className={shared.small}
                      disabled={busy}
                      onClick={() =>
                        void run(t('workspaces.panel.repoRemoved'), async () => {
                          await workspaceRemoveRepo(selected.id, status.path)
                          await reload()
                          await loadStatus(selected.id)
                        })
                      }
                    >
                      {t('common.remove')}
                    </button>
                  </div>
                </div>
              ))}
              {statuses.length === 0 ? (
                <p className={shared.notice}>{t('workspaces.panel.noRepos')}</p>
              ) : null}
            </div>
          </section>

          {results.length > 0 ? (
            <section className={shared.card} aria-labelledby="workspace-results-title">
              <h2 id="workspace-results-title">{t('workspaces.panel.resultsTitle')}</h2>
              <div className={shared.list}>
                {results.map((result) => (
                  <div key={result.path} className={shared.item}>
                    <div>
                      <span>
                        {result.ok ? '✓' : '✗'} {result.name ?? result.path}
                      </span>
                      <span className={shared.mono}>
                        {result.ok
                          ? result.message || t('workspaces.panel.success')
                          : `${result.errorCode ?? t('workspaces.panel.error')} · ${result.message}`}
                      </span>
                    </div>
                    <span className={result.ok ? shared.badge : shared.danger}>
                      {result.ok ? t('workspaces.panel.ok') : t('workspaces.panel.failed')}
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
        title={t('workspaces.panel.deleteTitle', { name: selected?.name ?? '' })}
        consequence={t('workspaces.panel.deleteConsequence')}
        confirmLabel={t('workspaces.panel.deleteConfirm')}
        busy={busy}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          const target = selected
          setPendingDelete(false)
          if (!target) return
          void run(t('workspaces.panel.deleted'), async () => {
            await workspaceDelete(target.id)
            await reload()
          })
        }}
      />
      <ConfirmDialog
        open={pendingPull}
        title={t('workspaces.panel.pullTitle', { count: selected?.repos.length ?? 0 })}
        consequence={t('workspaces.panel.pullConsequence')}
        confirmLabel={t('workspaces.panel.pullConfirm')}
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
