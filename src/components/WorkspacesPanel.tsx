import { useCallback, useEffect, useRef, useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { normalizeRepoPath } from '../lib/workspace'
import { t, useI18n } from '../i18n'
import { errorMessage } from '../ipc/client'
import {
  toolOpen,
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
  PullStrategy,
  Workspace,
  WorkspaceRepoStatus,
  WorkspaceSyncResult,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'
import styles from './WorkspacesPanel.module.css'
import { ViewIcon } from './ViewIcon'

type Props = {
  onOpenRepo: (path: string) => void
  activeWorkspaceId: string | null
  onActivateWorkspace: (workspaceId: string) => void
  onWorkspacesChanged: (workspaces: Workspace[]) => void
}

const REPO_LIMIT = 20

/**
 * Folder paths of a `.code-workspace` document.
 *
 * Anything that is not a valid document yields no path: importing never
 * guesses, and the caller reports an empty import.
 */
function codeWorkspacePaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('folders' in parsed)) {
      return []
    }
    const folders = parsed.folders
    if (!Array.isArray(folders)) {
      return []
    }
    return folders
      .map((folder) => {
        if (!folder || typeof folder !== 'object' || !('path' in folder)) {
          return null
        }
        const path = folder.path
        return typeof path === 'string' && path.trim() ? path.trim() : null
      })
      .filter((path): path is string => path !== null)
  } catch {
    return []
  }
}

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
  const { t, plural } = useI18n()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<WorkspaceRepoStatus[]>([])
  const [results, setResults] = useState<WorkspaceSyncResult[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [draftPaths, setDraftPaths] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [rename, setRename] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [pendingPull, setPendingPull] = useState(false)
  /** Paths picked for the next batch action; empty means every repository. */
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [strategy, setStrategy] = useState<PullStrategy>('auto')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')

  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null

  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await workspaceList()
      setWorkspaces(next)
      onWorkspacesChanged(next)
      setSelectedId((current) => currentExists(next, current)
        ? current : next.find((workspace) => workspace.id === activeWorkspaceId)?.id ?? next[0]?.id ?? null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [activeWorkspaceId, onWorkspacesChanged])

  const statusRequest = useRef(0)

  // Responses are applied only while they still answer the selected
  // workspace: switching workspace A → B must never display A's repositories
  // under B's header.
  const loadStatus = useCallback(async (workspaceId: string) => {
    const token = ++statusRequest.current
    try {
      const next = await workspaceStatus(workspaceId)
      if (statusRequest.current !== token) {
        return
      }
      setStatuses(next)
    } catch (cause) {
      if (statusRequest.current !== token) {
        return
      }
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
    setSelectedPaths([])
    setRename('')
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
        { repoPaths: selectedPaths, strategy },
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

  const pickRepositories = async (forDraft: boolean) => {
    const target = selected
    if (!forDraft && !target) return
    setPicking(true)
    setError(null)
    try {
      const chosen = await openNativeDialog({
        directory: true, multiple: true,
        title: t('workspaces.panel.pickTitle'),
      })
      if (!chosen) return
      const existing = forDraft ? draftPaths : target!.repos.map((repo) => repo.path)
      const known = new Set(existing.map(normalizeRepoPath))
      const paths = (Array.isArray(chosen) ? chosen : [chosen]).filter((path) => {
        const normalized = normalizeRepoPath(path)
        if (known.has(normalized)) return false
        known.add(normalized)
        return true
      })
      if (known.size > REPO_LIMIT) {
        setError(t('workspaces.panel.limitReached', { limit: REPO_LIMIT }))
        return
      }
      if (forDraft) setDraftPaths((current) => [...current, ...paths])
      else if (paths.length) await run(t('workspaces.panel.repoAdded'), async () => {
        const failures: string[] = []
        for (const path of paths) {
          try { await workspaceAddRepo(target!.id, path) }
          catch (cause) { failures.push(errorMessage(cause)) }
        }
        await reload()
        await loadStatus(target!.id)
        if (failures.length) setError(failures.join(' · '))
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPicking(false)
    }
  }

  const createWorkspace = () => void run(t('workspaces.panel.created', { name: name.trim() }), async () => {
    const created = await workspaceCreate(name.trim())
    const failures: string[] = []
    for (const path of draftPaths) {
      try { await workspaceAddRepo(created.id, path) }
      catch (cause) { failures.push(errorMessage(cause)) }
    }
    await reload()
    setSelectedId(created.id)
    setName(''); setDraftPaths([]); setCreating(false)
    if (failures.length) setError(failures.join(' · '))
  })

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div><span className={styles.eyebrow}>Beebranch</span><h2>{t('workspaces.panel.title')}</h2><p>{t('workspaces.panel.intro')}</p></div>
        <button type="button" className={shared.primary} disabled={busy || picking} onClick={() => {
          setCreating(true); setName(''); setDraftPaths([]); setError(null); setNotice(null)
        }}>+ {t('workspaces.panel.new')}</button>
      </header>
      <div className={styles.body}>
      <section className={styles.workspaceList} aria-labelledby="workspace-list-title">
        <div className={shared.row}>
          <h2 id="workspace-list-title">{t('workspaces.panel.yours')}</h2>
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
              disabled={busy || picking}
              aria-current={!creating && workspace.id === selectedId ? 'true' : undefined}
              className={`${shared.item} ${!creating && workspace.id === selectedId ? shared.itemSelected : ''}`}
              onClick={() => { setSelectedId(workspace.id); setCreating(false); setError(null); setNotice(null) }}
            >
              <span>
                {workspace.name}
                {workspace.id === activeWorkspaceId ? (
                  <span className={shared.badge} style={{ marginLeft: 8 }}>
                    {t('workspaces.panel.active')}
                  </span>
                ) : null}
              </span>
              <span className={shared.mono}>{plural('workspaces.panel.repoCount.one', 'workspaces.panel.repoCount.other', workspace.repos.length, { count: workspace.repos.length })}</span>
            </button>
          ))}
          {workspaces.length === 0 ? (
            <p className={shared.notice}>{t('workspaces.panel.empty')}</p>
          ) : null}
        </div>
      </section>
      <div className={styles.main}>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {creating || !selected ? <form className={styles.creation} onSubmit={(event) => { event.preventDefault(); if (name.trim() && !busy && !picking) createWorkspace() }}>
          <div className={styles.creationTitle}><ViewIcon view="workspaces" /><h3>{t('workspaces.panel.new')}</h3><p>{t('workspaces.panel.createIntro')}</p></div>
          <label className={shared.field}>{t('workspaces.panel.nameLabel')}
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus
              placeholder={t('workspaces.panel.namePlaceholder')} aria-label={t('workspaces.panel.nameAria')} disabled={busy} />
          </label>
          <button type="button" className={styles.folderPicker} disabled={busy || picking || draftPaths.length >= REPO_LIMIT} onClick={() => void pickRepositories(true)}>
            <ViewIcon view="worktrees" /><span><strong>{t('workspaces.panel.pickRepos')}</strong><small>{t('workspaces.panel.pickHint')}</small></span><span aria-hidden="true">+</span>
          </button>
          <div className={styles.draftList}>
            {draftPaths.map((path) => <div key={path} className={styles.draftRepo}>
              <ViewIcon view="graph" /><div><strong>{path.split(/[\\/]/).filter(Boolean).at(-1)}</strong><span title={path}>{path}</span></div>
              <button type="button" disabled={busy} aria-label={t('workspaces.panel.removeDraft', { path })} onClick={() => setDraftPaths((current) => current.filter((value) => value !== path))}>×</button>
            </div>)}
          </div>
          <div className={styles.createActions}><button type="submit" className={shared.primary} disabled={busy || picking || !name.trim()}>{busy ? t('common.loading') : t('workspaces.panel.create')}</button>
            {selected ? <button type="button" className={shared.secondary} disabled={busy} onClick={() => setCreating(false)}>{t('common.cancel')}</button> : null}
            <span>{t('workspaces.panel.repoLimit', { count: draftPaths.length, limit: REPO_LIMIT })}</span>
          </div>
        </form> : null}
      {selected && !creating ? (
        <>
          <section className={styles.workspaceDetail} aria-labelledby="workspace-detail-title">
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
            <button type="button" className={shared.primary} disabled={busy || picking || selected.repos.length >= REPO_LIMIT} onClick={() => void pickRepositories(false)}>
              + {t('workspaces.panel.pickRepos')}
            </button>
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
            <details className={styles.manualPath}><summary>{t('workspaces.panel.manualPath')}</summary>
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
            </details>
            <details className={styles.batchActions}><summary>{t('workspaces.panel.batchActions')}</summary>
            <div className={shared.row}>
              <label className={shared.field}>
                {t('workspaces.panel.strategyLabel')}
                <select
                  value={strategy}
                  aria-label={t('workspaces.panel.strategyAria')}
                  onChange={(event) => setStrategy(event.target.value as PullStrategy)}
                >
                  <option value="auto">{t('ops.sync.strategy.auto')}</option>
                  <option value="ffOnly">{t('ops.sync.strategy.ffOnly')}</option>
                  <option value="rebase">{t('ops.sync.strategy.rebase')}</option>
                  <option value="merge">{t('ops.sync.strategy.merge')}</option>
                </select>
              </label>
              <span className={shared.notice}>
                {selectedPaths.length === 0
                  ? t('workspaces.panel.selectionAll', { count: selected.repos.length })
                  : t('workspaces.panel.selectionSome', {
                      count: selectedPaths.length,
                      total: selected.repos.length,
                    })}
              </span>
              <button
                type="button"
                className={shared.small}
                onClick={() => setSelectedPaths([])}
                disabled={busy || selectedPaths.length === 0}
              >
                {t('workspaces.panel.selectAll')}
              </button>
              <button
                type="button"
                className={shared.small}
                disabled={busy || statuses.length === 0}
                title={t('workspaces.panel.openEditorHint')}
                onClick={() => {
                  const targets = statuses.filter(
                    (status) =>
                      status.available &&
                      Boolean(status.repoId) &&
                      (selectedPaths.length === 0 || selectedPaths.includes(status.path)),
                  )
                  if (targets.length === 0) {
                    return
                  }
                  void run(
                    t('workspaces.panel.openEditorDone', { count: targets.length }),
                    async () => {
                      let failed = 0
                      for (const target of targets) {
                        if (!target.repoId) {
                          continue
                        }
                        try {
                          await toolOpen({ repoId: target.repoId, kind: 'editor' })
                        } catch {
                          failed += 1
                        }
                      }
                      if (failed > 0) {
                        setError(t('workspaces.panel.openEditorPartial', { failed }))
                      }
                    },
                  )
                }}
              >
                {t('workspaces.panel.openEditor')}
              </button>
              <button
                type="button"
                className={shared.small}
                disabled={busy}
                title={t('workspaces.panel.exportHint')}
                onClick={() => {
                  const codeWorkspace = JSON.stringify(
                    {
                      folders: selected.repos.map((repo) => ({ path: repo.path })),
                    },
                    null,
                    2,
                  )
                  void navigator.clipboard
                    .writeText(codeWorkspace)
                    .then(() => setNotice(t('workspaces.panel.exported')))
                    .catch(() => setError(t('workspaces.panel.clipboardUnavailable')))
                }}
              >
                {t('workspaces.panel.export')}
              </button>
              <button
                type="button"
                className={shared.small}
                disabled={busy}
                onClick={() => {
                  setImportText('')
                  setImportOpen(true)
                }}
              >
                {t('workspaces.panel.import')}
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
            </details>
          </section>

          <section className={styles.repoSection} aria-labelledby="workspace-status-title">
            <h2 id="workspace-status-title">{t('workspaces.panel.statusTitle')}</h2>
            <div className={shared.list}>
              {statuses.map((status) => (
                <div key={status.path} className={styles.repoRow}>
                  <label className={shared.checkbox}>
                    <input
                      type="checkbox"
                      checked={selectedPaths.includes(status.path)}
                      aria-label={t('workspaces.panel.selectRepoAria', {
                        name: status.name ?? status.path,
                      })}
                      onChange={(event) =>
                        setSelectedPaths((current) =>
                          event.target.checked
                            ? [...current, status.path]
                            : current.filter((value) => value !== status.path),
                        )
                      }
                    />
                  </label>
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

      </div>
      </div>
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
        title={t('workspaces.panel.pullTitle', {
          count: selectedPaths.length || (selected?.repos.length ?? 0),
        })}
        consequence={t('workspaces.panel.pullConsequence')}
        confirmLabel={t('workspaces.panel.pullConfirm')}
        busy={busy}
        onCancel={() => setPendingPull(false)}
        onConfirm={() => {
          setPendingPull(false)
          void sync('pull')
        }}
      />

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        busy={busy}
        titleId="workspace-import-title"
      >
        <h2 id="workspace-import-title">{t('workspaces.panel.importTitle')}</h2>
        <p className={shared.notice}>{t('workspaces.panel.importHint')}</p>
        <textarea
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          aria-label={t('workspaces.panel.importAria')}
          placeholder={'{ "folders": [{ "path": "/src/project" }] }'}
          spellCheck={false}
          disabled={busy}
        />
        <div className={shared.row}>
          <button
            type="button"
            className={shared.ghost}
            onClick={() => setImportOpen(false)}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={shared.primary}
            disabled={busy || !importText.trim()}
            onClick={() => {
              if (!selected) {
                return
              }
              const paths = codeWorkspacePaths(importText)
              if (paths.length === 0) {
                setError(t('workspaces.panel.importEmpty'))
                return
              }
              setImportOpen(false)
              void run(t('workspaces.panel.importDone', { count: paths.length }), async () => {
                let added = 0
                let failed = 0
                for (const path of paths) {
                  try {
                    await workspaceAddRepo(selected.id, path)
                    added += 1
                  } catch {
                    failed += 1
                  }
                }
                setImportText('')
                await reload()
                await loadStatus(selected.id)
                if (failed > 0) {
                  setError(t('workspaces.panel.importPartial', { added, failed }))
                }
              })
            }}
          >
            {t('workspaces.panel.importSubmit')}
          </button>
        </div>
      </Dialog>
    </div>
  )
}

function currentExists(workspaces: Workspace[], id: string | null): boolean {
  return Boolean(id && workspaces.some((workspace) => workspace.id === id))
}
