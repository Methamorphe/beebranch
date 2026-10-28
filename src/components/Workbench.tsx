import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewId } from '../data/navigation'
import {
  branchCheckout,
  branchCreate,
  branchDelete,
  branchDeleteRemote,
  branchIntegrationPreview,
  branchIntegrationStart,
  branchRename,
  branchUpstream,
  commitGet,
  diffGet,
  historyCherryPick,
  historyMerge,
  historyRevert,
  gitlabMrPage,
  gitlabRepoLinkGet,
  gitlabStatus,
  openExternalUrl,
  refsGet,
  type DiffRequest,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { isCheckoutableRef, resolveGraphRef } from '../lib/graphRefs'
import { pipelineState } from '../lib/pipeline'
import { useGraph } from '../hooks/useGraph'
import type {
  BranchIntegrationPreview,
  CommitDetail,
  CommitSummary,
  DiffReport,
  RefEntry,
  RefsSnapshot,
  RepoView,
} from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ContextMenu } from './ContextMenu'
import { ViewIcon } from './ViewIcon'
import { CommitDetailPanel } from './CommitDetailPanel'
import { ConfirmDialog } from './ConfirmDialog'
import { ConflictsPanel } from './ConflictsPanel'
import { FileHistoryPanel } from './FileHistoryPanel'
import { PatchesPanel } from './PatchesPanel'
import { ProfilesPanel } from './ProfilesPanel'
import { RebasePanel } from './RebasePanel'
import { RefsAdminPanel } from './RefsAdminPanel'
import { SubmodulesPanel } from './SubmodulesPanel'
import { WorktreesPanel } from './WorktreesPanel'
import { WorkspacesPanel } from './WorkspacesPanel'
import { MergeRequestsPanel } from './MergeRequestsPanel'
import { CommitPanel } from './CommitPanel'
import { DiffViewer } from './DiffViewer'
import { GitlabPanel } from './GitlabPanel'
import { GraphCanvas } from './GraphCanvas'
import { RecoveryPanel } from './RecoveryPanel'
import { RepoStatus } from './RepoStatus'
import { SearchPanel } from './SearchPanel'
import { StashPanel } from './StashPanel'
import { SyncPanel } from './SyncPanel'
import { ToolsPanel } from './ToolsPanel'
import shared from './p1.module.css'
import styles from './Workbench.module.css'

type Props = {
  repo: RepoView | null
  generation: number
  view: ViewId
  worktreeRequest: number
  branchRequest: number
  diffRequest: DiffRequest | null
  onOpenDiff: (request: DiffRequest) => void
  onOpenRepo: (path: string) => void
  onMutated: () => void
  onNavigate: (view: ViewId) => void
  connected: boolean
  theme: 'dark' | 'light' | 'system'
  onThemeChange: (theme: 'dark' | 'light' | 'system') => void
  density: 'compact' | 'comfortable'
  onDensityChange: (density: 'compact' | 'comfortable') => void
  shortcuts: import('../lib/shortcuts').ShortcutMap
  onShortcutsChange: (next: import('../lib/shortcuts').ShortcutMap) => void
}

type ContextMenuState = {
  commit: CommitSummary
  x: number
  y: number
}

function remoteBranchName(entry: RefEntry | null) {
  if (!entry) return undefined
  const prefix = `${entry.remote ?? entry.name.split('/')[0]}/`
  return entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name
}

type DropMenuState = {
  source: RefEntry
  target: RefEntry
  x: number
  y: number
  fastForward: boolean
}

type PendingIntegration = {
  source: RefEntry
  target: RefEntry
  mode: 'merge' | 'rebase'
  preview: BranchIntegrationPreview
}

function integrationConsequence(pending: PendingIntegration | null) {
  if (!pending) return ''
  const { source, target, mode, preview } = pending
  const parts = [
    `${preview.ahead} commit(s) de ${source.name} à intégrer`,
    `${preview.behind} commit(s) de retard`,
  ]
  if (preview.fastForward) parts.push('fast-forward possible')
  if (preview.requiresCheckout) parts.push(`${target.name} sera extraite pendant l'opération`)
  if (preview.worktreeDirty) parts.push('le worktree contient des modifications non commitées')
  if (preview.currentBranch && preview.currentBranch !== target.name) {
    parts.push(`branche courante : ${preview.currentBranch}`)
  }
  return `${parts.join(' · ')}. ${mode === 'merge' ? 'Fusion' : 'Rebase'} sans mutation avant confirmation.`
}

type RefMenuState = {
  entry: RefEntry
  x: number
  y: number
  renaming: boolean
  name: string
}

export function Workbench({
  repo,
  generation,
  view,
  worktreeRequest,
  branchRequest,
  diffRequest,
  onOpenDiff,
  onOpenRepo,
  onMutated,
  onNavigate,
  connected,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  shortcuts,
  onShortcutsChange,
}: Props) {
  const repoId = repo?.repo.repoId ?? null
  const [localDiff, setLocalDiff] = useState<DiffRequest | null>(null)
  const activeDiff = view === 'graph' || view === 'status' || view === 'commit' ? localDiff : diffRequest
  const [revision, setRevision] = useState('')
  const [allRefs, setAllRefs] = useState(true)
  const [refs, setRefs] = useState<RefsSnapshot | null>(null)
  const [badges, setBadges] = useState<
    Record<
      string,
      { iid: number; status: string; state: string; updatedAt?: string }
    >
  >({})
  const [linkWebUrl, setLinkWebUrl] = useState<string | null>(null)
  const graph = useGraph(repoId, generation, { revision: revision || undefined, allRefs })
  const changes = repo?.state.worktree
  const hasChanges = Boolean(changes && (changes.staged > 0 || changes.unstaged > 0 || changes.untracked > 0 || changes.conflicted > 0))
  const [worktreeSelected, setWorktreeSelected] = useState(false)
  const showWorktree = worktreeSelected && hasChanges
  const [selected, setSelected] = useState<string | undefined>()
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [report, setReport] = useState<DiffReport | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [filePath, setFilePath] = useState('')
  const checkoutPending = useRef(false)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [showDate, setShowDate] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [branchTarget, setBranchTarget] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [refMenu, setRefMenu] = useState<RefMenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RefEntry | null>(null)
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null)
  const [pendingIntegration, setPendingIntegration] = useState<PendingIntegration | null>(null)
  const [integrationBusy, setIntegrationBusy] = useState(false)
  const [pendingRemoteDelete, setPendingRemoteDelete] = useState<RefEntry | null>(null)
  const [pendingMerge, setPendingMerge] = useState<RefEntry | null>(null)

  const previousWorktreeRequest = useRef(worktreeRequest)
  useEffect(() => {
    if (previousWorktreeRequest.current === worktreeRequest) return
    previousWorktreeRequest.current = worktreeRequest
    setSelected(undefined)
    setLocalDiff(null)
    setWorktreeSelected(hasChanges)
  }, [worktreeRequest, hasChanges])

  useEffect(() => {
    if (!hasChanges) {
      setWorktreeSelected(false)
      setLocalDiff(null)
    }
  }, [hasChanges])

  useEffect(() => {
    if (!repoId) {
      setRefs(null)
      return
    }
    void refsGet(repoId)
      .then((result) => setRefs(result.data))
      .catch(() => undefined)
  }, [repoId, generation])

  useEffect(() => {
    if (!repoId || view !== 'graph') {
      setBadges({})
      setLinkWebUrl(null)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const load = async () => {
      if (cancelled || document.hidden) {
        return
      }
      try {
        const session = await gitlabStatus()
        if (!session.connected) {
          return
        }
        const link = await gitlabRepoLinkGet(repoId)
        if (!link) {
          return
        }
        if (!cancelled) {
          setLinkWebUrl(link.webUrl)
        }
        const page = await gitlabMrPage({
          projectId: link.projectId,
          scope: 'all',
          page: 1,
          perPage: 100,
          repoId,
        })
        if (!cancelled) {
          const next: Record<
            string,
            { iid: number; status: string; state: string; updatedAt?: string }
          > = {}
          for (const mr of page.items) {
            const existing = next[mr.sourceBranch]
            if (existing?.updatedAt && existing.updatedAt > (mr.updatedAt ?? '')) {
              continue
            }
            next[mr.sourceBranch] = {
              iid: mr.iid,
              status: mr.headPipeline?.status ?? 'unknown',
              state: pipelineState(mr.headPipeline?.status),
              updatedAt: mr.updatedAt,
            }
          }
          setBadges(next)
        }
      } catch {
        // GitLab is optional; graph rendering must never depend on it.
      }
    }
    void load()
    timer = window.setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearInterval(timer)
      }
    }
  }, [repoId, generation, view])

  useEffect(() => {
    if (!repoId || !selected) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    void commitGet(repoId, selected)
      .then((result) => {
        if (!cancelled) {
          setDetail(result.data)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDetailError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, selected, generation])

  useEffect(() => {
    if (!repoId || !activeDiff) {
      setReport(null)
      setDiffLoading(false)
      setDiffError(null)
      return
    }
    let cancelled = false
    setReport(null)
    setDiffLoading(true)
    setDiffError(null)
    void diffGet(repoId, activeDiff)
      .then((result) => {
        if (!cancelled) {
          setReport(result.data)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDiffError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, activeDiff, generation])

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setActionError(null)
      setActionNotice(null)
      try {
        await action()
        setActionNotice(label)
        onMutated()
      } catch (cause) {
        setActionError(errorMessage(cause))
      }
    },
    [onMutated],
  )

  const startBranchCreate = useCallback(
    (sha?: string | null) => {
      const start = sha ?? selected ?? graph.commits[0]?.sha
      if (!start) return
      setContextMenu(null)
      setRefMenu(null)
      setBranchName('')
      setBranchTarget(start)
    },
    [graph.commits, selected],
  )

  const cancelBranchCreate = () => {
    setBranchTarget(null)
    setBranchName('')
  }

  const submitBranchCreate = () => {
    const name = branchName.trim()
    if (!repoId || !branchTarget || name.length === 0) return
    const start = branchTarget
    cancelBranchCreate()
    void runAction(`Branche ${name} créée.`, () =>
      branchCreate({ repoId, name, start, checkout: true }),
    )
  }

  const previousBranchRequest = useRef(branchRequest)
  useEffect(() => {
    if (previousBranchRequest.current === branchRequest) return
    previousBranchRequest.current = branchRequest
    if (view === 'graph') {
      startBranchCreate()
    }
  }, [branchRequest, startBranchCreate, view])

  const openRefMenu = (entry: RefEntry, x: number, y: number) => {
    setRefMenu({ entry, x, y, renaming: false, name: entry.name })
  }

  const handleRefDrop = (source: RefEntry, target: RefEntry, x: number, y: number) => {
    if (!repoId) return
    setRefMenu(null)
    setContextMenu(null)
    setActionError(null)
    setActionNotice(null)
    setDropMenu({ source, target, x, y, fastForward: false })
    void branchIntegrationPreview({
      repoId,
      source: source.name,
      target: target.name,
      mode: 'merge',
    })
      .then((preview) => {
        setDropMenu((current) =>
          current &&
          current.source.fullName === source.fullName &&
          current.target.fullName === target.fullName
            ? { ...current, fastForward: preview.applicable && preview.fastForward }
            : current,
        )
      })
      .catch(() => undefined)
  }

  const requestIntegration = async (mode: 'merge' | 'rebase') => {
    const menu = dropMenu
    if (!menu || !repoId) return
    setDropMenu(null)
    setActionError(null)
    setActionNotice(null)
    try {
      const preview = await branchIntegrationPreview({
        repoId,
        source: menu.source.name,
        target: menu.target.name,
        mode,
      })
      if (!preview.applicable) {
        setActionError(preview.blockedReason ?? 'Intégration impossible pour ces branches.')
        return
      }
      setPendingIntegration({ source: menu.source, target: menu.target, mode, preview })
    } catch (cause) {
      setActionError(errorMessage(cause))
    }
  }

  const confirmIntegration = async () => {
    const pending = pendingIntegration
    if (!pending || !repoId) return
    setIntegrationBusy(true)
    setActionError(null)
    try {
      const result = await branchIntegrationStart({
        repoId,
        source: pending.source.name,
        target: pending.target.name,
        mode: pending.mode,
        confirmation: { acknowledged: true },
      })
      setPendingIntegration(null)
      setActionNotice(
        result.data.outcome.conflicted
          ? `Conflit pendant ${pending.mode === 'merge' ? 'la fusion' : 'le rebase'} : résolvez les fichiers puis poursuivez.`
          : `${pending.mode === 'merge' ? 'Fusion' : 'Rebase'} de ${pending.source.name} appliqué.`,
      )
      onMutated()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setIntegrationBusy(false)
    }
  }

  if (view === 'profiles') {
    return (
      <div className={styles.content}>
        <ProfilesPanel
          repoId={repoId}
          connected={connected}
          theme={theme}
          onThemeChange={onThemeChange}
          density={density}
          onDensityChange={onDensityChange}
          onMutated={onMutated}
          onOpenGitlab={() => onNavigate('gitlab')}
          shortcuts={shortcuts}
          onShortcutsChange={onShortcutsChange}
        />
      </div>
    )
  }

  if (view === 'recovery') {
    return (
      <div className={styles.content}>
        <RecoveryPanel onOpenRepo={onOpenRepo} />
      </div>
    )
  }

  if (view === 'gitlab') {
    return (
      <div className={styles.content}>
        <GitlabPanel repoId={repoId} generation={generation} onLinked={onMutated} />
      </div>
    )
  }

  if (view === 'workspaces') {
    return (
      <div className={styles.content}>
        <WorkspacesPanel onOpenRepo={onOpenRepo} />
      </div>
    )
  }

  if (!repo || !repoId) {
    return (
      <div className={styles.content}>
        <div className={styles.placeholder}>
          <h2>Aucun dépôt ouvert</h2>
          <p>Ouvrez un dépôt avec la barre ci-dessus.</p>
        </div>
      </div>
    )
  }

  if (view === 'sync') {
    return <SyncPanel repoId={repoId} generation={generation} onMutated={onMutated} />
  }

  if (view === 'stash') {
    return <StashPanel repoId={repoId} generation={generation} onMutated={onMutated} />
  }

  if (view === 'search') {
    return (
      <SearchPanel
        repoId={repoId}
        onOpenDiff={onOpenDiff}
        onShowInGraph={(sha) => {
          setSelected(sha)
          setWorktreeSelected(false)
          onNavigate('graph')
        }}
        onOpenFile={(path) => {
          setFilePath(path)
          onNavigate('fileHistory')
        }}
      />
    )
  }

  if (view === 'tools') {
    return <ToolsPanel repoId={repoId} />
  }

  if (view === 'conflicts') {
    return (
      <ConflictsPanel
        repoId={repoId}
        generation={generation}
        state={repo.state}
        onMutated={onMutated}
      />
    )
  }

  if (view === 'rebase') {
    return (
      <RebasePanel
        repoId={repoId}
        generation={generation}
        state={repo.state}
        onMutated={onMutated}
        onNavigateConflicts={() => onNavigate('conflicts')}
      />
    )
  }

  if (view === 'worktrees') {
    return (
      <WorktreesPanel
        repoId={repoId}
        generation={generation}
        onMutated={onMutated}
        onOpenRepo={onOpenRepo}
      />
    )
  }

  if (view === 'tags' || view === 'remotes') {
    return (
      <RefsAdminPanel
        repoId={repoId}
        generation={generation}
        initialTab={view === 'tags' ? 'tags' : 'remotes'}
        onMutated={onMutated}
      />
    )
  }

  if (view === 'submodules') {
    return (
      <SubmodulesPanel repoId={repoId} generation={generation} onMutated={onMutated} />
    )
  }

  if (view === 'patches') {
    return <PatchesPanel repoId={repoId} onMutated={onMutated} />
  }

  if (view === 'fileHistory') {
    return (
      <FileHistoryPanel
        repoId={repoId}
        generation={generation}
        initialPath={filePath || undefined}
        onShowCommit={(sha) => {
          setSelected(sha)
          setWorktreeSelected(false)
          onNavigate('graph')
        }}
      />
    )
  }

  if (view === 'mrs') {
    return (
      <div className={shared.root}>
        <MergeRequestsPanel
          repoId={repoId}
          generation={generation}
          connected={connected}
          onCheckout={(branch: string) =>
            void runAction(`Checkout ${branch}.`, () =>
              branchCheckout({ repoId, name: branch }),
            )
          }
        />
      </div>
    )
  }

  if (view === 'diff') {
    const diffCommit =
      diffRequest?.target === 'commit' && diffRequest.base
        ? graph.commits.find((entry) => entry.sha === diffRequest.base)
        : undefined
    const source = !diffRequest
      ? 'Aucune sélection'
      : diffRequest.target === 'commit'
        ? `Commit ${diffRequest.base?.slice(0, 8) ?? ''}`
        : diffRequest.target === 'range'
          ? `${diffRequest.base ?? 'HEAD'}…${diffRequest.targetRef ?? 'HEAD'}`
          : diffRequest.target === 'index'
            ? 'Index (préparé)'
            : 'Modifications locales'
    const staging =
      diffRequest?.allowActions &&
      repoId &&
      !diffRequest.untracked &&
      (diffRequest.target === 'worktree' || diffRequest.target === 'index')
        ? {
            repoId,
            target: diffRequest.target,
            onMutated,
          }
        : undefined
    return (
      <div className={styles.content}>
        {diffError ? (
          <div className={styles.error} role="alert">
            {diffError}
          </div>
        ) : null}
        {diffLoading ? (
          <div className={styles.placeholder}>Calcul du diff…</div>
        ) : report ? (
          <DiffViewer
            report={report}
            source={source}
            commit={
              diffCommit
                ? {
                    sha: diffCommit.sha,
                    subject: diffCommit.subject,
                    author: diffCommit.author.name,
                    timestamp: diffCommit.author.timestamp,
                  }
                : undefined
            }
            staging={staging}
          />
        ) : (
          <div className={styles.placeholder}>
            <h2>Sélectionnez un fichier ou un commit</h2>
            <p>
              Le diff s'ouvre depuis le status, la recherche, ou le détail d'un
              commit.
            </p>
          </div>
        )}
      </div>
    )
  }

  const branches = refs?.entries.filter((entry) => entry.kind === 'branch') ?? []
  const branchesAtCommit = (sha: string) =>
    branches.filter((entry) => entry.targetOid === sha)

  const checkoutGraphRef = async (raw: string) => {
    if (checkoutPending.current) return
    const entry = resolveGraphRef(raw, refs?.entries ?? [])
    if (!isCheckoutableRef(entry)) return
    if (entry.isHead) return
    if (repo.state.operation || repo.state.conflicts.files.length > 0) {
      setActionError('Terminez l’opération Git et résolvez les conflits avant de changer de branche.')
      return
    }
    checkoutPending.current = true
    setCheckoutBusy(true)
    setActionError(null)
    setActionNotice(null)
    try {
      let activeBranch = entry.name
      if (entry.kind === 'branch') {
        await branchCheckout({ repoId, name:entry.name })
      } else {
        const localBranches = refs?.entries.filter((ref) => ref.kind === 'branch') ?? []
        const tracking = localBranches.find((ref) => ref.upstream?.replace(/^refs\/remotes\//, '') === entry.name)
        if (tracking?.isHead) return
        if (tracking) {
          activeBranch = tracking.name
          await branchCheckout({ repoId, name:tracking.name })
        } else {
          const remote = entry.remote ?? entry.name.split('/')[0]!
          const name = entry.name.slice(remote.length + 1)
          if (!name) throw new Error('Impossible de déterminer le nom de la branche distante.')
          if (localBranches.some((ref) => ref.name === name)) throw new Error(`La branche locale « ${name} » existe déjà avec un autre suivi. Sélectionnez-la directement ou configurez son upstream dans Branches.`)
          activeBranch = name
          await branchCreate({ repoId, name, start:entry.fullName, checkout:true })
          await branchUpstream({ repoId, branch:name, upstream:entry.name })
        }
      }
      setActionNotice(`Branche active : ${activeBranch}`)
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      checkoutPending.current = false
      setCheckoutBusy(false)
      onMutated()
    }
  }

  const graphControls = <div className={styles.graphControls}>
        <select
          value={allRefs ? '__all__' : revision}
          onChange={(event) => {
            setAllRefs(event.target.value === '__all__')
            if (event.target.value !== '__all__') setRevision(event.target.value)
          }}
          aria-label="Filtrer le graphe par branche"
        >
          <option value="__all__">Toutes les branches et tags</option>
          <option value="">Branche courante</option>
          {branches.map((entry) => (
            <option key={entry.fullName} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
    <ActionMenu label="Options d’affichage du graphe">
      <label className={styles.viewOption}><input type="checkbox" checked={showDate} onChange={(event) => setShowDate(event.target.checked)} />Date</label>
        <label className={styles.viewOption}>
          <input
            type="checkbox"
            checked={multiSelect}
            onChange={(event) => {
              setMultiSelect(event.target.checked)
              if (!event.target.checked) {
                setPicked([])
              }
            }}
          />
          Sélection multiple
        </label>
    </ActionMenu>
  </div>

  const worktreeRow = hasChanges ? (
    <button type="button" className={styles.worktreeRow} data-active={showWorktree} aria-pressed={showWorktree}
            onClick={() => { setSelected(undefined); setLocalDiff(null); setWorktreeSelected((current) => !current) }}>
            <span className={styles.wipRef}>En cours</span>
            <span className={styles.wipMarker} aria-hidden="true">◌</span>
            <span className={styles.wipMessage}><strong>Modifications locales</strong><span>{repo.state.worktree.staged} préparé(s) · {repo.state.worktree.unstaged} modifié(s) · {repo.state.worktree.untracked} nouveau(x)</span></span>
          </button>
  ) : null

  const openContextMenu = (commit: CommitSummary, x: number, y: number) => {
    setContextMenu({ commit, x, y })
  }

  const closeMenu = () => setContextMenu(null)


  return (
    <div className={styles.content}>
      {picked.length > 0 ? <div className={styles.graphToolbar}>
        {picked.length > 0 ? (
          <>
            <span className={shared.notice}>{picked.length} commit(s) sélectionné(s)</span>
            <button
              type="button"
              className={shared.primary}
              disabled={picked.length === 0}
              onClick={() => {
                const shas = [...picked]
                setPicked([])
                void runAction('Cherry-pick terminé.', () =>
                  historyCherryPick(repoId, shas),
                )
              }}
            >
              Cherry-pick
            </button>
            <button
              type="button"
              className={shared.secondary}
              disabled={picked.length === 0}
              onClick={() => {
                const shas = [...picked]
                setPicked([])
                void runAction('Revert terminé.', () => historyRevert(repoId, shas))
              }}
            >
              Revert
            </button>
            <button type="button" className={shared.small} onClick={() => setPicked([])}>
              Vider
            </button>
          </>
        ) : null}
      </div> : null}
      {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}
      {actionNotice ? <div className={styles.actionNotice} role="status">{actionNotice}</div> : null}

      {picked.length > 0 ? (
        <div className={shared.row} style={{ padding: '4px 24px 0' }}>
          <span className={shared.small}>Ordre :</span>
          {picked.map((sha, index) => (
            <span key={sha} className={shared.badge}>
              {index + 1}. {sha.slice(0, 8)}
              <button
                type="button"
                className={shared.small}
                style={{ padding: '0 3px', marginLeft: 4 }}
                aria-label={`Retirer ${sha.slice(0, 8)}`}
                onClick={() =>
                  setPicked((current) => current.filter((value) => value !== sha))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {graph.error ? (
        <div className={styles.error} role="alert">
          {graph.error}
        </div>
      ) : null}
      <div className={styles.graphLayout}>
        <div className={styles.historyMain}>
          {localDiff ? worktreeRow : null}
          <div className={styles.graphRegion} hidden={Boolean(localDiff)}>
        {graph.commits.length === 0 && !graph.loading ? (
          <div className={styles.emptyHistory}>
            {worktreeRow}
            <div className={styles.placeholder}><h2>Historique vide</h2>
            <p>Le dépôt n'a pas encore de commit, ou aucune page n'a pu être lue.</p></div>
          </div>
        ) : (
          <GraphCanvas
            worktreeRow={worktreeRow}
            headerTools={graphControls}
            showDate={showDate}
            commits={graph.commits}
            rows={graph.rows}
            selected={selected}
            mrBadges={badges}
            refEntries={refs?.entries ?? []}
            checkoutDisabled={checkoutBusy}
            onCheckoutRef={(raw) => void checkoutGraphRef(raw)}
            picked={picked}
            onSelect={(sha) => {
              setSelected(sha)
              setWorktreeSelected(false)
              setLocalDiff(null)
              if (multiSelect) {
                setPicked((current) =>
                  current.includes(sha)
                    ? current.filter((value) => value !== sha)
                    : [...current, sha],
                )
              }
            }}
            onContextMenu={openContextMenu}
            onRefContextMenu={openRefMenu}
            onRefDrop={handleRefDrop}
            branchTarget={branchTarget}
            branchName={branchName}
            onBranchName={setBranchName}
            onBranchSubmit={submitBranchCreate}
            onBranchCancel={cancelBranchCreate}
            onBranchRequest={(sha) => startBranchCreate(sha)}
            onLoadMore={graph.loadMore}
            loading={graph.loading}
            generation={generation}
            theme={theme}
          />
        )}
          </div>
          {localDiff ? <>
        <div className={styles.diffPreview} aria-label="Aperçu des modifications" aria-busy={diffLoading}>
          {localDiff ? <div className={styles.previewHeading}><span>{localDiff.target === 'index' ? 'Prêt à committer' : 'Modification locale'}</span><code title={localDiff.path}>{localDiff.path}</code><button type="button" onClick={() => setLocalDiff(null)} aria-label="Fermer l’aperçu">×</button></div> : null}
          {diffError ? <div className={styles.error} role="alert">{diffError}</div> : null}
          {diffLoading ? <div className={styles.placeholder} role="status">Chargement des modifications…</div> : report && localDiff ?
            <DiffViewer embedded report={report} source="" staging={localDiff.allowActions && !localDiff.untracked && (localDiff.target === 'worktree' || localDiff.target === 'index') ? { repoId, target: localDiff.target, onMutated } : undefined} /> :
            <div className={styles.placeholder}><span className={styles.emptyIcon} aria-hidden="true">±</span><h2>Chaque changement compte.</h2><p>Sélectionnez un fichier pour voir ses modifications.<br />Préparez les fichiers avec +, puis créez votre commit.</p></div>}
        </div>
          </> : null}
        </div>
        {selected ? <CommitDetailPanel
          onClose={() => setSelected(undefined)}
          detail={detail && detail.summary.sha === selected ? detail : null}
          loading={detailLoading && !(detail && detail.summary.sha === selected)}
          error={detailError}
          onShowDiff={(sha, path) => onOpenDiff({ target: 'commit', base: sha, path })}
        /> : showWorktree ? <aside className={styles.worktreePanel} aria-label="Préparation du prochain commit">
          <div className={styles.worktreeHeading}><strong>Fichiers</strong><span>{repo.state.head?.kind === 'branch' ? repo.state.head.name : 'HEAD'}</span><button type="button" aria-label="Fermer la préparation du commit" onClick={() => { setWorktreeSelected(false); setLocalDiff(null) }}>×</button></div>
          <RepoStatus repoId={repoId} generation={generation} locks={repo.locks}
            selectedPath={localDiff?.path} onSelectDiff={setLocalDiff} onMutated={onMutated} onNavigate={onNavigate} />
          <CommitPanel compact repoId={repoId} generation={generation} onMutated={onMutated} />
        </aside> : null}
      </div>

      {contextMenu ? (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} title={contextMenu.commit.sha.slice(0, 10)} subtitle={contextMenu.commit.subject} onClose={closeMenu}>
          <div className={styles.contextActions}>
            {branchesAtCommit(contextMenu.commit.sha).map((branch: RefEntry) => (
              <button
                key={branch.fullName}
                type="button"
                className={styles.contextAction}
              role="menuitem"
                onClick={() => {
                  const name = branch.name
                  closeMenu()
                  void runAction(`Checkout ${name}.`, () =>
                    branchCheckout({ repoId, name }),
                  )
                }}
              >
                <ViewIcon view="branch" /><span>Basculer sur {branch.name}</span>
              </button>
            ))}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const sha = contextMenu.commit.sha
                closeMenu()
                void runAction('Checkout détaché.', () =>
                  branchCheckout({ repoId, detachedAt: sha }),
                )
              }}
            >
              <ViewIcon view="graph" /><span>Explorer ce commit (HEAD détachée)</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => startBranchCreate(contextMenu.commit.sha)}
            >
              <ViewIcon view="branch" /><span>Créer une branche ici…</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const sha = contextMenu.commit.sha
                closeMenu()
                onOpenDiff({ target: 'range', base: sha, targetRef: 'HEAD' })
              }}
            >
              <ViewIcon view="status" /><span>Comparer à la branche courante</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const sha = contextMenu.commit.sha
                closeMenu()
                void navigator.clipboard?.writeText(sha)
                setActionNotice(`SHA copié : ${sha}`)
              }}
            >
              <ViewIcon view="patches" /><span>Copier le SHA</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const atCommit = branchesAtCommit(contextMenu.commit.sha)[0]?.name
                const head = repo.state.head
                const branch =
                  atCommit ?? (head?.kind === 'branch' ? head.name : null)
                closeMenu()
                if (!linkWebUrl || !branch) {
                  setActionError('Associez le dépôt à un projet GitLab et poussez la branche.')
                  return
                }
                const url = `${linkWebUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
                void openExternalUrl(url)
              }}
            >
              <ViewIcon view="mrs" /><span>Ouvrir une merge request</span>
            </button>

          </div>
        </ContextMenu>
      ) : null}

      {dropMenu ? (
        <ContextMenu
          x={dropMenu.x}
          y={dropMenu.y}
          title={`${dropMenu.source.name} → ${dropMenu.target.name}`}
          subtitle="Glisser-déposer"
          onClose={() => setDropMenu(null)}
        >
          <div className={styles.contextActions}>
            {dropMenu.fastForward ? (
              <button
                type="button"
                className={styles.contextAction}
                role="menuitem"
                title={`Avancer ${dropMenu.target.name} sur ${dropMenu.source.name}`}
                onClick={() => void requestIntegration('merge')}
              >
                <ViewIcon view="sync" /><span>Avancer {dropMenu.target.name} sur {dropMenu.source.name}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              title={`Fusionner ${dropMenu.source.name} dans ${dropMenu.target.name}`}
              onClick={() => void requestIntegration('merge')}
            >
              <ViewIcon view="mrs" /><span>Fusionner {dropMenu.source.name} dans {dropMenu.target.name}</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              title={`Rebaser ${dropMenu.source.name} sur ${dropMenu.target.name}`}
              onClick={() => void requestIntegration('rebase')}
            >
              <ViewIcon view="rebase" /><span>Rebaser {dropMenu.source.name} sur {dropMenu.target.name}</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const { source, target } = dropMenu
                setDropMenu(null)
                onOpenDiff({ target: 'range', base: source.name, targetRef: target.name })
              }}
            >
              <ViewIcon view="diff" /><span>Comparer {dropMenu.source.name} et {dropMenu.target.name}</span>
            </button>
          </div>
        </ContextMenu>
      ) : null}

      <ConfirmDialog
        open={pendingIntegration !== null}
        title={
          pendingIntegration
            ? `${pendingIntegration.mode === 'merge' ? 'Fusionner' : 'Rebaser'} ${pendingIntegration.source.name}${pendingIntegration.mode === 'merge' ? ' dans ' : ' sur '}${pendingIntegration.target.name}`
            : ''
        }
        consequence={integrationConsequence(pendingIntegration)}
        confirmLabel={pendingIntegration?.mode === 'rebase' ? 'Rebaser' : 'Fusionner'}
        busy={integrationBusy}
        onCancel={() => setPendingIntegration(null)}
        onConfirm={() => void confirmIntegration()}
      />

      {refMenu ? (
        <ContextMenu
          x={refMenu.x}
          y={refMenu.y}
          title={refMenu.entry.name}
          subtitle={refMenu.entry.kind === 'remoteBranch' ? 'branche distante' : 'branche locale'}
          onClose={() => setRefMenu(null)}
        >
          <div className={styles.contextActions}>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              disabled={refMenu.entry.isHead || checkoutBusy}
              onClick={() => {
                const raw = refMenu.entry.fullName
                setRefMenu(null)
                void checkoutGraphRef(raw)
              }}
            >
              <ViewIcon view="branch" /><span>Basculer sur {refMenu.entry.name}</span>
            </button>
            {refMenu.entry.kind === 'branch' ? (
              refMenu.renaming ? (
                <div className={shared.row}>
                  <input
                    autoFocus
                    value={refMenu.name}
                    onChange={(event) =>
                      setRefMenu((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                    aria-label="Nouveau nom de branche"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={shared.primary}
                    disabled={!refMenu.name.trim() || refMenu.name.trim() === refMenu.entry.name}
                    onClick={() => {
                      const next = refMenu.name.trim()
                      const old = refMenu.entry.name
                      setRefMenu(null)
                      void runAction(`Branche ${old} renommée en ${next}.`, () =>
                        branchRename({ repoId, old, new: next }),
                      )
                    }}
                  >
                    Renommer
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.contextAction}
                  role="menuitem"
                  onClick={() =>
                    setRefMenu((current) =>
                      current ? { ...current, renaming: true } : current,
                    )
                  }
                >
                  <ViewIcon view="patches" /><span>Renommer…</span>
                </button>
              )
            ) : null}
            {refMenu.entry.kind === 'branch' && !refMenu.entry.isHead ? (
              <>
                <button
                  type="button"
                  className={styles.contextAction}
                  role="menuitem"
                  onClick={() => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    setPendingMerge(entry)
                  }}
                >
                  <ViewIcon view="mrs" /><span>Fusionner dans la branche courante</span>
                </button>
                <button
                  type="button"
                  className={styles.contextAction}
                  role="menuitem"
                  onClick={() => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    setPendingDelete(entry)
                  }}
                >
                  <ViewIcon view="status" /><span>Supprimer…</span>
                </button>
              </>
            ) : null}
            {refMenu.entry.kind === 'remoteBranch' ? (
              <button
                type="button"
                className={styles.contextAction}
                role="menuitem"
                onClick={() => {
                  const entry = refMenu.entry
                  setRefMenu(null)
                  setPendingRemoteDelete(entry)
                }}
              >
                <ViewIcon view="status" /><span>Supprimer la branche distante…</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const name = refMenu.entry.name
                setRefMenu(null)
                onOpenDiff({ target: 'range', base: name, targetRef: 'HEAD' })
              }}
            >
              <ViewIcon view="diff" /><span>Comparer à HEAD</span>
            </button>
          </div>
        </ContextMenu>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Supprimer la branche ${pendingDelete?.name ?? ''}`}
        consequence="La branche locale est supprimée. Ses commits restent joignables par le reflog et les autres branches."
        typed={pendingDelete?.name}
        confirmLabel="Supprimer"
        onCancel={() => setPendingDelete(null)}
        onConfirm={(typed) => {
          const entry = pendingDelete
          setPendingDelete(null)
          if (repoId && entry) {
            void runAction(`Branche ${entry.name} supprimée.`, () =>
              branchDelete({
                repoId,
                name: entry.name,
                confirmation: { acknowledged: true, typed },
              }),
            )
          }
        }}
      />
      <ConfirmDialog
        open={pendingRemoteDelete !== null}
        title={`Supprimer ${pendingRemoteDelete?.name ?? ''}`}
        consequence="La branche est supprimée sur le remote après un push de suppression. Les autres clones perdent la référence au prochain fetch."
        typed={remoteBranchName(pendingRemoteDelete)}
        irreversible
        confirmLabel="Supprimer sur le remote"
        onCancel={() => setPendingRemoteDelete(null)}
        onConfirm={(typed) => {
          const entry = pendingRemoteDelete
          setPendingRemoteDelete(null)
          if (repoId && entry) {
            const remote = entry.remote ?? entry.name.split('/')[0] ?? 'origin'
            const branch = remoteBranchName(entry) ?? entry.name
            void runAction(`Branche distante ${remote}/${branch} supprimée.`, () =>
              branchDeleteRemote({
                repoId,
                remote,
                branch,
                confirmation: { acknowledged: true, typed },
              }),
            )
          }
        }}
      />
      <ConfirmDialog
        open={pendingMerge !== null}
        title={`Fusionner ${pendingMerge?.name ?? ''}`}
        consequence={`${pendingMerge?.name ?? 'La branche'} sera fusionnée dans la branche courante. Un conflit laissera l'opération visible dans toute l'application.`}
        confirmLabel="Fusionner"
        onCancel={() => setPendingMerge(null)}
        onConfirm={() => {
          const entry = pendingMerge
          setPendingMerge(null)
          if (repoId && entry) {
            void runAction(`Merge de ${entry.name}.`, () =>
              historyMerge({ repoId, target: entry.name }),
            )
          }
        }}
      />
    </div>
  )
}