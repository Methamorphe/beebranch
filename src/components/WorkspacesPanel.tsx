import { useCallback, useEffect, useRef, useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { formatNumber, t, useI18n } from '../i18n'
import { errorMessage } from '../ipc/client'
import { errorCopy } from '../i18n/errors'
import {
  toolOpen,
  workspaceAddRepo,
  workspaceCreate,
  workspaceDelete,
  workspaceList,
  workspaceRemoveRepo,
  workspaceRename,
  workspaceIconImage,
  workspaceSetIcon,
  workspaceStatus,
  workspaceSync,
  type CloneInput,
} from '../ipc/commands'
import { WORKSPACE_REPO_LIMIT, normalizeRepoPath, type WorkspaceAttach } from '../lib/workspace'
import { cachedWorkspaceImage, rememberWorkspaceImage } from '../lib/workspaceIcon'
import type { PullStrategy, Workspace, WorkspaceRepoStatus, WorkspaceSyncResult } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ConfirmBar } from './ConfirmBar'
import { Dialog } from './ui/Dialog'
import { FileStatusIcon } from './FileStatusIcon'
import { ToolbarIcon } from './ToolbarIcon'
import { WorkspaceCloneDialog } from './WorkspaceCloneDialog'
import { WorkspaceIconDialog, type DraftWorkspaceIcon } from './WorkspaceIconDialog'
import { WorkspaceMark } from './WorkspaceMark'
import shared from './p1.module.css'
import styles from './WorkspacesPanel.module.css'

function syncFailure(code: string | undefined, message: string): string {
  if (!code) return message
  const copy = errorCopy({ code, category: 'internal', message, retryable: false })
  return copy.remediation ? `${copy.message} ${copy.remediation}` : copy.message
}

type Props = {
  onOpenRepo: (path: string) => void
  activeWorkspaceId: string | null
  onActivateWorkspace: (workspaceId: string) => void | Promise<void>
  onWorkspacesChanged: (workspaces: Workspace[]) => void
  onClone: (input: CloneInput, attach: WorkspaceAttach) => Promise<string>
  onPickDirectory?: (defaultPath?: string) => Promise<string | null>
  onOpenProvider?: (provider: 'gitlab' | 'github') => void
}

function codeWorkspacePaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('folders' in parsed)) return []
    const folders = parsed.folders
    if (!Array.isArray(folders)) return []
    return folders
      .map((folder) => {
        if (!folder || typeof folder !== 'object' || !('path' in folder)) return null
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
  if (head?.kind === 'branch') return head.name + (head.upstream ? ` → ${head.upstream}` : '')
  if (head?.kind === 'detached') return `HEAD ${head.sha.slice(0, 8)}`
  return t('workspaces.panel.unknownBranch')
}

function ChangeCounts({ worktree }: { worktree?: { staged: number; unstaged: number; untracked: number; conflicted: number } }) {
  const { plural } = useI18n()
  const staged = worktree?.staged ?? 0
  const modified = worktree?.unstaged ?? 0
  const added = worktree?.untracked ?? 0
  const conflicted = worktree?.conflicted ?? 0
  const stats = [
    {
      kind: 'staged',
      count: staged,
      icon: <ToolbarIcon name="check" size={14} />,
      label: plural('workbench.graph.staged.one', 'workbench.graph.staged.other', staged, { count: formatNumber(staged) }),
    },
    {
      kind: 'modified',
      count: modified,
      icon: <FileStatusIcon letter="M" />,
      label: plural('workbench.graph.unstaged.one', 'workbench.graph.unstaged.other', modified, { count: formatNumber(modified) }),
    },
    {
      kind: 'new',
      count: added,
      icon: <FileStatusIcon letter="A" />,
      label: plural('workbench.graph.untracked.one', 'workbench.graph.untracked.other', added, { count: formatNumber(added) }),
    },
    ...(conflicted > 0
      ? [{
          kind: 'conflicted',
          count: conflicted,
          icon: <FileStatusIcon letter="U" />,
          label: plural('shell.statusBar.conflicts.one', 'shell.statusBar.conflicts.other', conflicted, { count: formatNumber(conflicted) }),
        }]
      : []),
  ]
  return (
    <span className={styles.changes}>
      {stats.map((stat) => (
        <span key={stat.kind} className={styles.change} data-kind={stat.kind} data-empty={stat.count === 0} title={stat.label}>
          {stat.icon}
          <span>{formatNumber(stat.count)}</span>
        </span>
      ))}
    </span>
  )
}

function repoLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function WorkspacesPanel({
  onOpenRepo,
  activeWorkspaceId,
  onActivateWorkspace,
  onWorkspacesChanged,
  onClone,
  onPickDirectory,
  onOpenProvider,
}: Props) {
  const { t, plural } = useI18n()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<WorkspaceRepoStatus[]>([])
  const [results, setResults] = useState<WorkspaceSyncResult[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [draftPaths, setDraftPaths] = useState<string[]>([])
  const [draftIcon, setDraftIcon] = useState<DraftWorkspaceIcon>({ kind: 'none' })
  const [picking, setPicking] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  const skipRenameSave = useRef(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [pendingPull, setPendingPull] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [strategy, setStrategy] = useState<PullStrategy>('auto')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [cloneOpen, setCloneOpen] = useState(false)
  const [iconOpen, setIconOpen] = useState(false)
  const [iconValue, setIconValue] = useState<DraftWorkspaceIcon>({ kind: 'none' })

  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null
  const showCreator = creating || workspaces.length === 0
  const memberCount = showCreator ? draftPaths.length : selected?.repos.length ?? 0
  const atLimit = memberCount >= WORKSPACE_REPO_LIMIT

  const publish = (next: Workspace[]) => {
    setWorkspaces(next)
    onWorkspacesChanged(next)
  }

  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await workspaceList()
      setWorkspaces(next)
      onWorkspacesChanged(next)
      setSelectedId((current) =>
        current && next.some((workspace) => workspace.id === current)
          ? current
          : next.find((workspace) => workspace.id === activeWorkspaceId)?.id ?? next[0]?.id ?? null,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [activeWorkspaceId, onWorkspacesChanged])

  const statusRequest = useRef(0)
  const loadStatus = useCallback(async (workspaceId: string) => {
    const token = ++statusRequest.current
    try {
      const next = await workspaceStatus(workspaceId)
      if (statusRequest.current !== token) return
      setStatuses(next)
    } catch (cause) {
      if (statusRequest.current !== token) return
      setError(errorMessage(cause))
      setStatuses([])
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    setStatuses([])
    setResults([])
    setSelectedPaths([])
    setRename(null)
    if (selectedId && !creating) void loadStatus(selectedId)
  }, [selectedId, creating, loadStatus])

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

  const startCreate = () => {
    setCreating(true)
    setName('')
    setDraftPaths([])
    setDraftIcon({ kind: 'none' })
    setPath('')
    setRename(null)
    setError(null)
    setNotice(null)
  }

  const openIcon = () => {
    if (showCreator) {
      setIconValue(draftIcon)
      setIconOpen(true)
      return
    }
    if (selected?.iconKind === 'lucide' && selected.iconKey) {
      setIconValue({ kind: 'lucide', key: selected.iconKey })
    } else if (selected?.iconKind === 'image') {
      const cached = cachedWorkspaceImage(selected.id, selected.updatedAt)
      setIconValue(cached
        ? { kind: 'image', pngBase64: '', previewUrl: cached }
        : { kind: 'none' })
      if (!cached) {
        const id = selected.id
        const updatedAt = selected.updatedAt
        void workspaceIconImage(id).then((url) => {
          if (!url) return
          rememberWorkspaceImage(id, updatedAt, url)
          setIconValue({ kind: 'image', pngBase64: '', previewUrl: url })
        }).catch(() => undefined)
      }
    } else {
      setIconValue({ kind: 'none' })
    }
    setIconOpen(true)
  }

  const changeIcon = (next: DraftWorkspaceIcon) => {
    setIconValue(next)
    if (showCreator) {
      setDraftIcon(next)
      return
    }
    if (!selected || (next.kind === 'image' && !next.pngBase64)) return
    const workspaceId = selected.id
    void run(t('workspaces.panel.iconSaved'), async () => {
      const updated = await workspaceSetIcon({
        workspaceId,
        kind: next.kind === 'none' ? 'none' : next.kind,
        key: next.kind === 'lucide' ? next.key : undefined,
        pngBase64: next.kind === 'image' ? next.pngBase64 : undefined,
      })
      if (next.kind === 'image') {
        rememberWorkspaceImage(updated.id, updated.updatedAt, next.previewUrl)
      }
      await reload()
    })
  }

  const pickRepositories = async (forDraft: boolean) => {
    const target = selected
    if (!forDraft && !target) return
    setPicking(true)
    setError(null)
    try {
      const chosen = await openNativeDialog({
        directory: true,
        multiple: true,
        title: t('workspaces.panel.pickTitle'),
      })
      if (!chosen) return
      const existing = forDraft ? draftPaths : target!.repos.map((repo) => repo.path)
      const known = new Set(existing.map(normalizeRepoPath))
      const paths = (Array.isArray(chosen) ? chosen : [chosen]).filter((entry) => {
        const normalized = normalizeRepoPath(entry)
        if (known.has(normalized)) return false
        known.add(normalized)
        return true
      })
      if (known.size > WORKSPACE_REPO_LIMIT) {
        setError(t('workspaces.panel.limitReached', { limit: WORKSPACE_REPO_LIMIT }))
        return
      }
      if (forDraft) setDraftPaths((current) => [...current, ...paths])
      else if (paths.length) await run(t('workspaces.panel.repoAdded'), async () => {
        const failures: string[] = []
        for (const entry of paths) {
          try { await workspaceAddRepo(target!.id, entry) }
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

  const addManualPath = () => {
    const entry = path.trim()
    if (!entry) return
    if (showCreator) {
      const known = new Set(draftPaths.map(normalizeRepoPath))
      if (known.has(normalizeRepoPath(entry))) {
        setPath('')
        return
      }
      if (draftPaths.length >= WORKSPACE_REPO_LIMIT) {
        setError(t('workspaces.panel.limitReached', { limit: WORKSPACE_REPO_LIMIT }))
        return
      }
      setDraftPaths((current) => [...current, entry])
      setPath('')
      return
    }
    if (!selected) return
    void run(t('workspaces.panel.repoAdded'), async () => {
      await workspaceAddRepo(selected.id, entry)
      setPath('')
      await reload()
      await loadStatus(selected.id)
    })
  }

  const createWorkspace = () => void run(t('workspaces.panel.created', { name: name.trim() }), async () => {
    const created = await workspaceCreate(name.trim())
    const failures: string[] = []
    try {
      if (draftIcon.kind === 'lucide') {
        await workspaceSetIcon({ workspaceId: created.id, kind: 'lucide', key: draftIcon.key })
      } else if (draftIcon.kind === 'image') {
        const updated = await workspaceSetIcon({
          workspaceId: created.id,
          kind: 'image',
          pngBase64: draftIcon.pngBase64,
        })
        rememberWorkspaceImage(updated.id, updated.updatedAt, draftIcon.previewUrl)
      }
      for (const entry of draftPaths) {
        try { await workspaceAddRepo(created.id, entry) }
        catch (cause) { failures.push(errorMessage(cause)) }
      }
    } finally {
      const next = await workspaceList()
      publish(next)
      setSelectedId(created.id)
      setName('')
      setDraftPaths([])
      setDraftIcon({ kind: 'none' })
      setCreating(false)
    }
    if (failures.length) setError(failures.join(' · '))
    await onActivateWorkspace(created.id)
  })

  const saveRename = () => {
    if (skipRenameSave.current) {
      skipRenameSave.current = false
      return
    }
    if (!selected || rename === null) return
    const nextName = rename.trim()
    if (!nextName || nextName === selected.name) {
      setRename(null)
      return
    }
    void run(t('workspaces.panel.renamed'), async () => {
      await workspaceRename(selected.id, nextName)
      setRename(null)
      await reload()
    })
  }

  const cloneInto = async (input: CloneInput) => {
    const attachWorkspaceId = showCreator ? null : selected?.id ?? null
    if (attachWorkspaceId === null && draftPaths.length >= WORKSPACE_REPO_LIMIT) {
      throw new Error(t('workspaces.panel.limitReached', { limit: WORKSPACE_REPO_LIMIT }))
    }
    setBusy(true)
    setError(null)
    try {
      const cloned = await onClone(input, {
        attachWorkspaceId,
        showTab: !showCreator && attachWorkspaceId === activeWorkspaceId,
      })
      if (!attachWorkspaceId) {
        setDraftPaths((current) =>
          current.some((entry) => normalizeRepoPath(entry) === normalizeRepoPath(cloned))
            ? current
            : [...current, cloned],
        )
        return
      }
      // The shell may already have recorded the clone. Adding again is a no-op
      // when the path is already a member, and it covers a missed attach.
      await workspaceAddRepo(attachWorkspaceId, cloned)
      await reload()
      await loadStatus(attachWorkspaceId)
    } catch (cause) {
      setError(errorMessage(cause))
      throw cause
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
      setNotice(t(action === 'fetch' ? 'workspaces.panel.syncFetched' : 'workspaces.panel.syncUpdated', {
        ok: next.length - failures,
        total: next.length,
        failures: failures > 0 ? t('workspaces.panel.syncFailures', { count: failures }) : '',
      }))
      await loadStatus(selected.id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const scoped = selectedPaths.length > 0
  const pullLabel = scoped
    ? t('workspaces.panel.pullSome', { count: selectedPaths.length })
    : t('workspaces.panel.pullAll')
  const fetchLabel = scoped
    ? t('workspaces.panel.fetchSome', { count: selectedPaths.length })
    : t('workspaces.panel.fetchAll')

  const addBar = (
    <div className={styles.addBar}>
      <button
        type="button"
        className={shared.secondary}
        disabled={busy || picking || atLimit}
        onClick={() => void pickRepositories(showCreator)}
      >
        {t('workspaces.panel.pickRepos')}
      </button>
      <button
        type="button"
        className={shared.secondary}
        disabled={busy || picking || atLimit}
        onClick={() => setCloneOpen(true)}
      >
        {t('workspaces.panel.addClone')}
      </button>
      <div className={styles.pathRow}>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={t('workspaces.panel.pathPlaceholder')}
          aria-label={t('workspaces.panel.pathAria')}
          disabled={busy || atLimit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addManualPath()
            }
          }}
        />
        <button type="button" className={shared.secondary} disabled={busy || !path.trim() || atLimit} onClick={addManualPath}>
          {t('common.add')}
        </button>
      </div>
    </div>
  )

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Beebranch</span>
          <h2>{t('workspaces.panel.title')}</h2>
          <p>{t('workspaces.panel.intro')}</p>
        </div>
      </header>
      <div className={styles.body}>
        <section className={styles.workspaceList} aria-labelledby="workspace-list-title">
          <div className={styles.listHead}>
            <h2 id="workspace-list-title">{t('workspaces.panel.yours')}</h2>
            <span className={shared.badge}>{workspaces.length}</span>
            <button type="button" className={shared.secondary} onClick={() => void reload()}>{t('common.reload')}</button>
          </div>
          <div className={styles.list} role="list">
            {workspaces.map((workspace) => {
              const current = !showCreator && workspace.id === selectedId
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="listitem"
                  disabled={busy || picking}
                  aria-current={current ? 'true' : undefined}
                  data-active={workspace.id === activeWorkspaceId ? 'true' : undefined}
                  className={`${styles.listItem} ${current ? styles.listItemSelected : ''}`}
                  onClick={() => {
                    setSelectedId(workspace.id)
                    setCreating(false)
                    setError(null)
                    setNotice(null)
                  }}
                >
                  <WorkspaceMark
                    name={workspace.name}
                    iconKind={workspace.iconKind}
                    iconKey={workspace.iconKey}
                    workspaceId={workspace.id}
                    updatedAt={workspace.updatedAt}
                    size={28}
                  />
                  <span className={styles.meta}>
                    <span className={styles.itemName}>{workspace.name}</span>
                    <span className={styles.count}>
                      {plural('workspaces.panel.repoCount.one', 'workspaces.panel.repoCount.other', workspace.repos.length, { count: workspace.repos.length })}
                    </span>
                  </span>
                </button>
              )
            })}
            {workspaces.length === 0 ? <p className={styles.empty}>{t('workspaces.panel.empty')}</p> : null}
          </div>
          <button type="button" className={styles.newWorkspace} disabled={busy || picking} onClick={startCreate}>
            <ToolbarIcon name="plus" size={14} /> {t('workspaces.panel.new')}
          </button>
        </section>

        <div className={styles.main}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

          {showCreator ? (
            <form
              className={styles.creation}
              onSubmit={(event) => {
                event.preventDefault()
                if (name.trim() && !busy && !picking) createWorkspace()
              }}
            >
              <div className={styles.creationTitle}>
                <h3>{t('workspaces.panel.new')}</h3>
                <p>{t('workspaces.panel.createIntro')}</p>
              </div>
              <div className={styles.identity}>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={openIcon}
                  aria-label={t('workspaces.panel.iconAria', { name: name.trim() || t('workspaces.panel.new') })}
                >
                  <WorkspaceMark
                    name={name.trim() || '?'}
                    iconKind={draftIcon.kind === 'none' ? null : draftIcon.kind}
                    iconKey={draftIcon.kind === 'lucide' ? draftIcon.key : null}
                    imageUrl={draftIcon.kind === 'image' ? draftIcon.previewUrl : null}
                    size={28}
                  />
                </button>
                <label className={shared.field}>
                  {t('workspaces.panel.nameLabel')}
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoFocus
                    placeholder={t('workspaces.panel.namePlaceholder')}
                    aria-label={t('workspaces.panel.nameAria')}
                    disabled={busy}
                  />
                </label>
              </div>
              {addBar}
              <div className={styles.draftList}>
                {draftPaths.map((entry) => (
                  <div key={entry} className={styles.draftRepo}>
                    <div>
                      <strong>{repoLeaf(entry)}</strong>
                      <span title={entry}>{entry}</span>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('workspaces.panel.removeDraft', { path: entry })}
                      onClick={() => setDraftPaths((current) => current.filter((value) => value !== entry))}
                    >
                      <ToolbarIcon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className={styles.createActions}>
                <button type="submit" className={shared.primary} disabled={busy || picking || !name.trim()}>
                  {busy ? t('common.loading') : t('workspaces.panel.create')}
                </button>
                {workspaces.length > 0 ? (
                  <button type="button" className={shared.secondary} disabled={busy} onClick={() => setCreating(false)}>
                    {t('common.cancel')}
                  </button>
                ) : null}
                <span>{t('workspaces.panel.repoLimit', { count: draftPaths.length, limit: WORKSPACE_REPO_LIMIT })}</span>
              </div>
            </form>
          ) : null}

          {selected && !showCreator ? (
            <>
              <section className={styles.workspaceDetail} aria-labelledby="workspace-detail-title">
                <div className={styles.detailHead}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={openIcon}
                    aria-label={t('workspaces.panel.iconAria', { name: selected.name })}
                  >
                    <WorkspaceMark
                      name={selected.name}
                      iconKind={selected.iconKind}
                      iconKey={selected.iconKey}
                      workspaceId={selected.id}
                      updatedAt={selected.updatedAt}
                      size={28}
                    />
                  </button>
                  {rename !== null ? (
                    <form
                      className={styles.renameForm}
                      onSubmit={(event) => {
                        event.preventDefault()
                        saveRename()
                      }}
                    >
                      <input
                        value={rename}
                        autoFocus
                        aria-label={t('workspaces.panel.renameAria')}
                        onChange={(event) => setRename(event.target.value)}
                        onBlur={saveRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            skipRenameSave.current = true
                            setRename(null)
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <h2 id="workspace-detail-title"><button type="button" className={styles.nameButton} title={t('workspaces.panel.renameHint')} onClick={() => setRename(selected.name)}>{selected.name}</button></h2>
                  )}
                  <span className={styles.limit}>
                    {t('workspaces.panel.repoLimit', { count: selected.repos.length, limit: WORKSPACE_REPO_LIMIT })}
                  </span>
                  <div className={styles.detailActions}>
                  <ActionMenu
                    label={t('workspaces.panel.sync')}
                    triggerContent={`${t('workspaces.panel.sync')} · ${pullLabel}`}
                    triggerClassName={styles.syncTrigger}
                    menuClassName={styles.syncMenu}
                  >
                    <div className={styles.syncBody}>
                    <p className={styles.syncHint}>{t('workspaces.panel.syncHint')}</p>
                    <label>
                      {t('workspaces.panel.strategyLabel')}
                      <select
                        value={strategy}
                        aria-label={t('workspaces.panel.strategyAria')}
                        onChange={(event) => setStrategy(event.target.value as PullStrategy)}
                      >
                        <option value="auto">{t('workspaces.panel.strategy.auto')}</option>
                        <option value="ffOnly">{t('workspaces.panel.strategy.ffOnly')}</option>
                        <option value="rebase">{t('workspaces.panel.strategy.rebase')}</option>
                        <option value="merge">{t('workspaces.panel.strategy.merge')}</option>
                      </select>
                    </label>
                    <span className={styles.selection}>
                      {selectedPaths.length === 0
                        ? t('workspaces.panel.selectionAll', { count: selected.repos.length })
                        : t('workspaces.panel.selectionSome', { count: selectedPaths.length, total: selected.repos.length })}
                    </span>
                    {selectedPaths.length > 0 ? (
                      <button type="button" className={shared.small} disabled={busy} onClick={() => setSelectedPaths([])}>
                        {t('workspaces.panel.selectAll')}
                      </button>
                    ) : null}
                    <button type="button" disabled={busy || selected.repos.length === 0} onClick={() => void sync('fetch')}>
                      {fetchLabel}
                    </button>
                    <button type="button" disabled={busy || selected.repos.length === 0} onClick={() => setPendingPull(true)}>
                      {pullLabel}
                    </button>
                    </div>
                  </ActionMenu>
                  {selected.id === activeWorkspaceId ? (
                    <span className={styles.statusPill}>{t('workspaces.panel.activeState')}</span>
                  ) : (
                    <button
                      type="button"
                      className={shared.primary}
                      disabled={busy}
                      onClick={() => void onActivateWorkspace(selected.id)}
                    >
                      {t('workspaces.panel.activate')}
                    </button>
                  )}
                  <ActionMenu label={t('workspaces.panel.actions')}>
                    <button
                      type="button"
                      onClick={() => {
                        const codeWorkspace = JSON.stringify(
                          { folders: selected.repos.map((repo) => ({ path: repo.path })) },
                          null,
                          2,
                        )
                        void navigator.clipboard.writeText(codeWorkspace)
                          .then(() => setNotice(t('workspaces.panel.exported')))
                          .catch(() => setError(t('workspaces.panel.clipboardUnavailable')))
                      }}
                    >
                      {t('workspaces.panel.export')}
                    </button>
                    <button type="button" onClick={() => { setImportText(''); setImportOpen(true) }}>
                      {t('workspaces.panel.import')}
                    </button>
                    <button
                      type="button"
                      disabled={busy || statuses.length === 0}
                      title={t('workspaces.panel.openEditorHint')}
                      onClick={() => {
                        const targets = statuses.filter((status) =>
                          status.available && Boolean(status.repoId) &&
                          (selectedPaths.length === 0 || selectedPaths.includes(status.path)),
                        )
                        if (targets.length === 0) return
                        void run(t('workspaces.panel.openEditorDone', { count: targets.length }), async () => {
                          let failed = 0
                          for (const target of targets) {
                            if (!target.repoId) continue
                            try { await toolOpen({ repoId: target.repoId, kind: 'editor' }) }
                            catch { failed += 1 }
                          }
                          if (failed > 0) setError(t('workspaces.panel.openEditorPartial', { failed }))
                        })
                      }}
                    >
                      {t('workspaces.panel.openEditor')}
                    </button>
                  </ActionMenu>
                  <ActionMenu
                    label={t('workspaces.panel.dangerZone')}
                    triggerContent={t('workspaces.panel.dangerZone')}
                    triggerClassName={styles.dangerTrigger}
                  >
                    <button type="button" className={styles.menuDanger} onClick={() => setPendingDelete(true)}>
                      {t('common.delete')}
                    </button>
                  </ActionMenu>
                  </div>
                </div>
                {addBar}
              </section>

              <section className={styles.repoSection} aria-labelledby="workspace-status-title">
                <div className={styles.statusHead}>
                  <h2 id="workspace-status-title">{t('workspaces.panel.statusTitle')}</h2>
                  <button type="button" className={shared.small} disabled={busy} onClick={() => void loadStatus(selected.id)}>
                    {t('workspaces.panel.refreshStatus')}
                  </button>
                </div>
                <div className={styles.repos}>
                  {statuses.map((status) => (
                    <div key={status.path} className={styles.repoRow}>
                      <label className={shared.checkbox}>
                        <input
                          type="checkbox"
                          checked={selectedPaths.includes(status.path)}
                          aria-label={t('workspaces.panel.selectRepoAria', { name: status.name ?? status.path })}
                          onChange={(event) => setSelectedPaths((current) =>
                            event.target.checked
                              ? [...current, status.path]
                              : current.filter((value) => value !== status.path),
                          )}
                        />
                      </label>
                      <div className={styles.repoBody}>
                        <span>{status.name ?? repoLeaf(status.path)}</span>
                        <span className={styles.repoPath} title={status.path}>{status.path}</span>
                        {status.available ? (
                          <span className={styles.repoStatus}>
                            <span className={styles.branch}>{headLabel(status)}</span>
                            <ChangeCounts worktree={status.state?.worktree} />
                          </span>
                        ) : (
                          <span className={styles.repoError}>{status.error}</span>
                        )}
                      </div>
                      <div className={styles.repoActions}>
                        <button type="button" className={shared.small} disabled={!status.available} onClick={() => onOpenRepo(status.path)}>
                          {t('common.open')}
                        </button>
                        <button
                          type="button"
                          className={shared.small}
                          disabled={busy}
                          onClick={() => void run(t('workspaces.panel.repoRemoved'), async () => {
                            await workspaceRemoveRepo(selected.id, status.path)
                            await reload()
                            await loadStatus(selected.id)
                          })}
                        >
                          {t('common.remove')}
                        </button>
                      </div>
                    </div>
                  ))}
                  {statuses.length === 0 ? <p className={styles.empty}>{t('workspaces.panel.noRepos')}</p> : null}
                </div>
              </section>

              {results.length > 0 ? (
                <section className={styles.results} aria-labelledby="workspace-results-title">
                  <h2 id="workspace-results-title">{t('workspaces.panel.resultsTitle')}</h2>
                  <div className={styles.repos}>
                    {results.map((result) => {
                      const detail = result.ok
                        ? result.message.trim()
                        : syncFailure(result.errorCode, result.message)
                      return (
                        <div key={result.path} className={styles.resultRow} data-ok={result.ok ? 'true' : 'false'}>
                          <span className={styles.resultMark} aria-hidden="true">{result.ok ? '✓' : '✗'}</span>
                          <div className={styles.repoBody}>
                            <span className={styles.resultName}>{result.name ?? result.path}</span>
                            {detail ? <span className={styles.resultMessage}>{detail}</span> : null}
                          </div>
                          <span className={result.ok ? styles.resultOk : styles.resultFail}>
                            {result.ok ? t('workspaces.panel.ok') : t('workspaces.panel.failed')}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <WorkspaceIconDialog
        open={iconOpen}
        name={showCreator ? name : selected?.name ?? ''}
        value={iconValue}
        busy={busy}
        onClose={() => setIconOpen(false)}
        onChange={changeIcon}
      />
      <WorkspaceCloneDialog
        open={cloneOpen}
        busy={busy}
        draft={showCreator}
        onClose={() => setCloneOpen(false)}
        onClone={cloneInto}
        onPickDirectory={onPickDirectory}
        onOpenProvider={onOpenProvider}
      />
      <ConfirmBar
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
      <ConfirmBar
        open={pendingPull}
        title={t('workspaces.panel.pullTitle', { count: selectedPaths.length || (selected?.repos.length ?? 0) })}
        consequence={t('workspaces.panel.pullConsequence')}
        confirmLabel={pullLabel}
        busy={busy}
        onCancel={() => setPendingPull(false)}
        onConfirm={() => {
          setPendingPull(false)
          void sync('pull')
        }}
      />
      <Dialog open={importOpen} onClose={() => setImportOpen(false)} busy={busy} titleId="workspace-import-title">
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
          <button type="button" className={shared.ghost} onClick={() => setImportOpen(false)} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={shared.primary}
            disabled={busy || !importText.trim()}
            onClick={() => {
              if (!selected) return
              const paths = codeWorkspacePaths(importText)
              if (paths.length === 0) {
                setError(t('workspaces.panel.importEmpty'))
                return
              }
              setImportOpen(false)
              void run(t('workspaces.panel.importDone', { count: paths.length }), async () => {
                let added = 0
                let failed = 0
                for (const entry of paths) {
                  try {
                    await workspaceAddRepo(selected.id, entry)
                    added += 1
                  } catch {
                    failed += 1
                  }
                }
                setImportText('')
                await reload()
                await loadStatus(selected.id)
                if (failed > 0) setError(t('workspaces.panel.importPartial', { added, failed }))
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
