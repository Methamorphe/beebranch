import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { navigationItems, type ViewId } from '../data/navigation'
import {
  branchCheckout,
  branchCheckoutAt,
  branchCreate,
  branchDelete,
  branchDeleteRemote,
  branchIntegrationPreview,
  branchIntegrationStart,
  branchRename,
  branchUpstream,
  commitGet,
  diffGet,
  fileContentGet,
  historyCherryPick,
  historyReset,
  historyRevert,
  githubStatus,
  gitlabStatus,
  openExternalUrl,
  patchCreate,
  patchSave,
  preferenceGet,
  preferenceSet,
  refsGet,
  tagDelete,
  tagPush,
  stashList,
  stashApply,
  stashCreate,
  stashDrop,
  stashPop,
  syncFetchAll,
  syncPull,
  syncPush,
  type DiffRequest,
} from '../ipc/commands'
import { save as saveNativeDialog } from '@tauri-apps/plugin-dialog'
import { errorMessage } from '../ipc/client'
import { formatNumber, useI18n } from '../i18n'
import { isCheckoutableRef, resolveGraphRef, shortRevision } from '../lib/graphRefs'
import type { MediaSettings } from '../lib/mediaSettings'
import { projectWebUrl, refWebUrl } from '../lib/refLinks'
import { isPushRejection, type PushRejection } from '../lib/pushRejection'
import {
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  defaultInspectorWidth,
  type LayoutPreferences,
} from '../lib/layout'
import { pipelineState } from '../lib/pipeline'
import { useGraph } from '../hooks/useGraph'
import type {
  BranchIntegrationPreview,
  CommitDetail,
  CommitSummary,
  DiffReport,
  MergeFastForward,
  RefEntry,
  RefsSnapshot,
  RepoView,
  StashEntry,
  Workspace,
} from '../types/git'
import type { ShortcutMap } from '../lib/shortcuts'
import {
  EMPTY_VISIBILITY,
  REF_VISIBILITY_KEY,
  applyVisibility,
  parseVisibility,
  mergeVisibility,
  type RefVisibility,
} from '../lib/refVisibility'
import { ActionMenu } from './ActionMenu'
import { ActivityPanel } from './ActivityPanel'
import { AmendDialog } from './AmendDialog'
import { ContextMenu } from './ContextMenu'
import { ViewIcon } from './ViewIcon'
import { CommitDetailPanel } from './CommitDetailPanel'
import { ComparisonPanel } from './ComparisonPanel'
import { ConfirmDialog } from './ConfirmDialog'
import { ConflictsPanel } from './ConflictsPanel'
import { FileHistoryPanel } from './FileHistoryPanel'
import { PatchesPanel } from './PatchesPanel'
import { ProfilesPanel } from './ProfilesPanel'
import { RebasePanel } from './RebasePanel'
import { RefsAdminPanel } from './RefsAdminPanel'
import { Resizer } from './Resizer'
import { SubmodulesPanel } from './SubmodulesPanel'
import { WorktreesPanel } from './WorktreesPanel'
import { WorkspacesPanel } from './WorkspacesPanel'
import { ReviewRequestsPanel } from './ReviewRequestsPanel'
import { CommitPanel } from './CommitPanel'
import { DiffViewer, type DocumentReader } from './DiffViewer'
import { GitlabPanel } from './GitlabPanel'
import { GithubPanel } from './GithubPanel'
import { githubForge, gitlabForge } from '../lib/forge'
import { RepositoryNavigator } from './RepositoryNavigator'
import { GraphCanvas } from './GraphCanvas'
import { RecoveryPanel } from './RecoveryPanel'
import { RepoStatus } from './RepoStatus'
import { SearchPanel } from './SearchPanel'
import { SquashDialog } from './SquashDialog'
import { SyncPanel } from './SyncPanel'
import { TagDialog } from './TagDialog'
import { ToolsPanel } from './ToolsPanel'
import { WorktreeDialog } from './WorktreeDialog'
import shared from './p1.module.css'
import styles from './Workbench.module.css'

type Props = {
  repo: RepoView | null
  generation: number
  view: ViewId
  worktreeRequest: number
  branchRequest: number
  historyRequest: { kind: 'stash' | 'rebase' | 'conflicts'; serial: number } | null
  diffRequest: DiffRequest | null
  onOpenDiff: (request: DiffRequest) => void
  onOpenRepo: (path: string) => void
  onMutated: () => void
  onUndo: () => Promise<unknown>
  onNavigate: (view: ViewId) => boolean
  onRegisterNavigationGuard: (guard: (() => boolean) | null) => void
  gitlabConnected: boolean
  githubConnected: boolean
  theme: 'dark' | 'light' | 'system'
  onThemeChange: (theme: 'dark' | 'light' | 'system') => void
  density: 'compact' | 'comfortable'
  onDensityChange: (density: 'compact' | 'comfortable') => void
  background: MediaSettings | null
  backgroundError: string | null
  onBackgroundChange: (next: MediaSettings | null) => void
  splash: MediaSettings | null
  splashError: string | null
  onSplashChange: (next: MediaSettings | null) => void
  shortcuts: ShortcutMap
  /** Actions whose stored binding conflicted and fell back to the default. */
  shortcutConflict?: string[]
  onShortcutsChange: (next: ShortcutMap) => void
  layout: LayoutPreferences
  onLayoutChange: (patch: Partial<LayoutPreferences>) => void
  activeWorkspaceId: string | null
  onActivateWorkspace: (workspaceId: string) => void
  onWorkspacesChanged: (workspaces: Workspace[]) => void
  /** A push Git refused, handed to the recovery dialog. */
  onPushRejected: (rejection: PushRejection) => void
}

/** The two revisions of an A→B comparison, as git revspecs. */
type Comparison = {
  base: string
  target: string
  /** Commits covered by the comparison, newest first, as the graph lists them. */
  commits: string[]
}

type ContextMenuState = {
  commit: CommitSummary
  /** Stash selector when the row is a stash entry (`stash@{0}`). */
  stash?: string
  x: number
  y: number
  /** Inline expansion: checkout targets or reset modes, never a nested menu. */
  panel: 'checkout' | 'reset' | null
}

function remoteBranchName(entry: RefEntry | null) {
  if (!entry) return undefined
  const prefix = `${entry.remote ?? entry.name.split('/')[0]}/`
  return entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name
}

/** `refs/remotes/origin/feature/x` → `{ remote: 'origin', branch: 'feature/x' }`. */
function upstreamTarget(entry: RefEntry) {
  const upstream = entry.upstream?.replace(/^refs\/remotes\//, '')
  if (!upstream) return null
  const separator = upstream.indexOf('/')
  if (separator <= 0 || separator === upstream.length - 1) return null
  return {
    remote: upstream.slice(0, separator),
    branch: upstream.slice(separator + 1),
  }
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
  fastForward: MergeFastForward
  preview: BranchIntegrationPreview
}

type RefMenuState = {
  entry: RefEntry
  x: number
  y: number
  renaming: boolean
  name: string
  /** Inline expansion: upstream list, checkout targets, reset modes, solo. */
  panel: 'upstream' | 'checkout' | 'reset' | 'solo' | null
}

/**
 * Remote that receives a push of this local branch. The backend runs
 * `git push <remote> <branch>`, so the pushed ref is always the local name;
 * the upstream only selects the remote.
 */
function pushTarget(entry: RefEntry) {
  const upstream = entry.upstream?.replace(/^refs\/remotes\//, '')
  const [remote] = upstream?.split('/') ?? []
  const name = remote || 'origin'
  return { remote: name, target: `${name}/${entry.name}` }
}

export function Workbench({
  repo,
  generation,
  view,
  worktreeRequest,
  branchRequest,
  diffRequest,
  historyRequest,
  onOpenDiff,
  onOpenRepo,
  onMutated,
  onUndo,
  onNavigate,
  onRegisterNavigationGuard,
  gitlabConnected,
  githubConnected,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  background,
  backgroundError,
  onBackgroundChange,
  splash,
  splashError,
  onSplashChange,
  shortcuts,
  shortcutConflict,
  onShortcutsChange,
  layout,
  onLayoutChange,
  activeWorkspaceId,
  onActivateWorkspace,
  onWorkspacesChanged,
  onPushRejected,
}: Props) {
  const { t, plural } = useI18n()

  /** Why a fast-forward is unavailable, in the user's terms. */
  const fastForwardReason = (preview: BranchIntegrationPreview) => {
    if (preview.mode !== 'merge') return null
    if (preview.fastForward) return null
    if (preview.ahead === 0 && preview.behind === 0) {
      return t('workbench.integration.sameCommit', {
        target: preview.target,
        source: preview.source,
      })
    }
    if (preview.ahead === 0 && preview.behind > 0) {
      return plural(
        'workbench.integration.targetAheadUseReverse.one',
        'workbench.integration.targetAheadUseReverse.other',
        preview.behind,
        {
          count: formatNumber(preview.behind),
          target: preview.target,
          source: preview.source,
        },
      )
    }
    if (preview.ahead === 0) {
      return t('workbench.integration.alreadyIntegrated', {
        target: preview.target,
        source: preview.source,
      })
    }
    if (preview.behind > 0) {
      return plural(
        'workbench.integration.missingCommits.one',
        'workbench.integration.missingCommits.other',
        preview.behind,
        {
          count: formatNumber(preview.behind),
          target: preview.target,
          source: preview.source,
        },
      )
    }
    return null
  }

  const integrationConsequence = (pending: PendingIntegration | null) => {
    if (!pending) return ''
    const { source, target, mode, fastForward, preview } = pending
    const parts = [
      plural(
        'workbench.integration.commitsToIntegrate.one',
        'workbench.integration.commitsToIntegrate.other',
        preview.ahead,
        { count: formatNumber(preview.ahead), source: source.name },
      ),
      plural(
        'workbench.integration.commitsBehind.one',
        'workbench.integration.commitsBehind.other',
        preview.behind,
        { count: formatNumber(preview.behind) },
      ),
    ]
    if (mode === 'merge') {
      if (preview.fastForward) {
        parts.push(
          t(
            fastForward === 'never'
              ? 'workbench.integration.mergeCommitInstead'
              : 'workbench.integration.fastForwardNoMerge',
          ),
        )
      } else if (preview.ahead === 0 && preview.behind > 0) {
        parts.push(
          plural(
            'workbench.integration.targetAheadUseReverse.one',
            'workbench.integration.targetAheadUseReverse.other',
            preview.behind,
            {
              count: formatNumber(preview.behind),
              target: target.name,
              source: source.name,
            },
          ),
        )
      } else if (preview.ahead === 0) {
        parts.push(t('workbench.integration.nothingToIntegrate'))
      } else {
        parts.push(t('workbench.integration.fastForwardImpossible'))
      }
    }
    if (preview.requiresCheckout) {
      parts.push(t('workbench.integration.checkoutRequired', { target: target.name }))
    }
    if (preview.stashRequired) {
      parts.push(t('workbench.integration.stashRequired'))
    } else if (preview.worktreeDirty) {
      parts.push(t('workbench.integration.untrackedLeft'))
    }
    if (preview.currentBranch && preview.currentBranch !== target.name) {
      parts.push(t('workbench.integration.currentBranch', { branch: preview.currentBranch }))
    }
    return t('workbench.integration.noMutation', {
      parts: parts.join(' · '),
      operation:
        mode === 'merge'
          ? t('workbench.integration.operation.merge')
          : t('workbench.integration.operation.rebase'),
    })
  }

  const repoId = repo?.repo.repoId ?? null
  const [localDiff, setLocalDiff] = useState<DiffRequest | null>(null)
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
  const [linkProvider, setLinkProvider] = useState<'gitlab' | 'github' | null>(null)
  const graph = useGraph(repoId, generation, { revision: revision || undefined, allRefs })
  const changes = repo?.state.worktree
  const hasChanges = Boolean(changes && (changes.staged > 0 || changes.unstaged > 0 || changes.untracked > 0 || changes.conflicted > 0))
  const [worktreeSelected, setWorktreeSelected] = useState(false)
  const showWorktree = worktreeSelected
  const [stashBusy, setStashBusy] = useState(false)
  const stashPending = useRef(false)
  const [stashEntries, setStashEntries] = useState<StashEntry[]>([])
  const [historyTool, setHistoryTool] = useState<'stash' | 'rebase' | 'conflicts' | null>(null)
  /** Unsaved conflict draft or rebase plan owned by the lower dock. */
  const [toolDirty, setToolDirty] = useState(false)
  useEffect(() => {
    onRegisterNavigationGuard(() => {
      if (!toolDirty) return true
      if (!window.confirm(t('workbench.history.discardDraft'))) return false
      setToolDirty(false)
      return true
    })
    return () => onRegisterNavigationGuard(null)
  }, [toolDirty, onRegisterNavigationGuard, t])
  useEffect(() => {
    let cancelled = false
    if (repoId) void stashList(repoId).then((entries) => { if (!cancelled) setStashEntries(entries) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [repoId, generation])
  const [rebaseBase, setRebaseBase] = useState('')
  const [reveal, setReveal] = useState<{ sha: string; serial: number }>()
  const [selected, setSelected] = useState<string | undefined>()
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [report, setReport] = useState<DiffReport | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** HEAD commit opened in the amend dialog, from the menu or the diff header. */
  const [amendTarget, setAmendTarget] = useState<{ sha: string; subject: string } | null>(null)
  /** Commits selected for a squash, confirmed in a dialog. */
  const [squashShas, setSquashShas] = useState<string[] | null>(null)
  /** Hidden and soloed references, restored per repository. */
  const [visibility, setVisibility] = useState<RefVisibility>(EMPTY_VISIBILITY)

  useEffect(() => {
    if (!repoId) {
      return
    }
    let cancelled = false
    void preferenceGet(REF_VISIBILITY_KEY)
      .then((raw) => {
        if (cancelled) {
          return
        }
        const restored = parseVisibility(raw, repoId)
        setVisibility(restored)
        if (restored.filter) {
          setAllRefs(restored.filter.allRefs)
          setRevision(restored.filter.revision)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId])

  const persistVisibility = useCallback(
    (next: RefVisibility) => {
      setVisibility(next)
      if (!repoId) {
        return
      }
      void preferenceGet(REF_VISIBILITY_KEY)
        .then((raw) => preferenceSet(REF_VISIBILITY_KEY, mergeVisibility(raw, repoId, next)))
        .catch(() => undefined)
    },
    [repoId],
  )

  /**
   * Background auto-fetch. The interval lives in `git.autoFetchMinutes`; `0`
   * disables it. Failures stay silent: a background fetch never interrupts the
   * user with an error, and the manual Fetch reports them.
   */
  useEffect(() => {
    if (!repoId) {
      return
    }
    let cancelled = false
    let timer: number | undefined
    void preferenceGet('git.autoFetchMinutes')
      .then((value) => {
        const minutes = Number(value ?? '0')
        if (cancelled || !Number.isFinite(minutes) || minutes <= 0) {
          return
        }
        const id = repoId
        timer = window.setInterval(() => {
          void syncFetchAll(id).catch(() => undefined)
        }, Math.max(1, minutes) * 60_000)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearInterval(timer)
      }
    }
  }, [repoId])
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [filePath, setFilePath] = useState('')
  const checkoutPending = useRef(false)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  /** Graph row that started a shift-click range, until a plain click moves it. */
  const rangeAnchor = useRef<string | undefined>(undefined)
  // A→B comparison shown in the history inspector, without leaving the graph.
  const [comparison, setComparison] = useState<Comparison | null>(null)
  /** File picked in the comparison list; its patch replaces the graph. */
  const [comparePath, setComparePath] = useState<string | null>(null)
  const [compareReport, setCompareReport] = useState<DiffReport | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)
  // Graph rows keep the comparison readable: subject, date, author, sha.
  const comparisonCommits = useMemo(() => {
    if (!comparison) return []
    const bySha = new Map(graph.commits.map((commit) => [commit.sha, commit]))
    return comparison.commits
      .map((sha) => bySha.get(sha))
      .filter((commit): commit is CommitSummary => commit !== undefined)
  }, [comparison, graph.commits])
  /**
   * The patch displayed below the history: a local file, or the compared
   * file picked in the inspector. Memoised so the diff effect only refetches
   * when the request itself changes.
   */
  const previewDiff = useMemo<DiffRequest | null>(() => {
    if (localDiff) return localDiff
    if (comparison && comparePath) {
      return {
        target: 'range',
        base: comparison.base,
        targetRef: comparison.target,
        path: comparePath,
      }
    }
    return null
  }, [localDiff, comparison, comparePath])
  /**
   * Files are read at the revision the diff was computed for, so the rendered
   * view never shows the working copy while the diff targets a commit.
   */
  const documentReader = useCallback(
    (request: DiffRequest | null): DocumentReader | undefined => {
      if (!repoId || !request) return undefined
      const revision =
        request.target === 'worktree'
          ? 'worktree'
          : request.target === 'index'
            ? 'index'
            : request.target === 'commit'
              ? request.base
              : request.targetRef ?? 'HEAD'
      if (!revision) return undefined
      return (path: string) => fileContentGet({ repoId, path, revision })
    },
    [repoId],
  )
  const readPreviewDocument = useMemo(
    () => documentReader(previewDiff),
    [documentReader, previewDiff],
  )
  const readDiffDocument = useMemo(
    () => documentReader(diffRequest),
    [documentReader, diffRequest],
  )
  const activeDiff =
    view === 'diff' ? diffRequest : previewDiff
  const [branchTarget, setBranchTarget] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [refMenu, setRefMenu] = useState<RefMenuState | null>(null)
  const [pendingTagDelete, setPendingTagDelete] = useState<RefEntry | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RefEntry | null>(null)
  /** Stash entry awaiting an irreversible drop confirmation. */
  const [pendingStashDrop, setPendingStashDrop] = useState<{ selector: string; sha: string } | null>(null)
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null)
  const [pendingIntegration, setPendingIntegration] = useState<PendingIntegration | null>(null)
  const [integrationBusy, setIntegrationBusy] = useState(false)
  const [pendingRemoteDelete, setPendingRemoteDelete] = useState<RefEntry | null>(null)
  const [pendingDeleteBoth, setPendingDeleteBoth] = useState<RefEntry | null>(null)
  /** Commit a tag dialog points at, and whether the tag is annotated. */
  const [tagTarget, setTagTarget] = useState<{ sha: string; annotated: boolean } | null>(null)
  /** Ref a worktree dialog starts from. */
  const [worktreeTarget, setWorktreeTarget] = useState<string | null>(null)
  /** Branches pinned to the left, per repository, persisted with the UI prefs. */
  const [pins, setPins] = useState<Record<string, string>>({})
  const previousHistoryRequest = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!historyRequest || previousHistoryRequest.current === historyRequest.serial) return
    previousHistoryRequest.current = historyRequest.serial
    // A shell shortcut must not silently replace an unsaved draft either.
    if (toolDirty && !window.confirm(t('workbench.history.discardDraft'))) return
    if (historyRequest.kind === 'stash') {
      onNavigate('stash')
      return
    }
    setHistoryTool(historyRequest.kind)
    setToolDirty(false)
    setLocalDiff(null)
    if (historyRequest.kind === 'rebase') setRebaseBase('')
    setComparePath(null)
  }, [historyRequest, toolDirty, t, onNavigate])
  const operationKey = repo?.state.operation?.kind ?? (repo?.state.conflicts.files.length ? 'conflicts' : null)
  const previousOperation = useRef(operationKey)
  useEffect(() => {
    const previous = previousOperation.current
    if (!operationKey && previous && historyTool === 'conflicts' && !toolDirty) {
      // The merge or rebase ended here: the operation panel has nothing left
      // to manage and gives the history its full height back.
      setHistoryTool(null)
    }
    previousOperation.current = operationKey
  }, [operationKey, historyTool, toolDirty])

  const previousWorktreeRequest = useRef(worktreeRequest)
  useEffect(() => {
    if (previousWorktreeRequest.current === worktreeRequest) return
    previousWorktreeRequest.current = worktreeRequest
    setSelected(undefined)
    setComparison(null)
    setComparePath(null)
    setLocalDiff(null)
    setWorktreeSelected(true)
  }, [worktreeRequest])

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
    let cancelled = false
    void preferenceGet('ui.graph.pins')
      .then((raw) => {
        if (cancelled || !raw) return
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setPins(parsed as Record<string, string>)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!repoId) {
      setBadges({})
      setLinkWebUrl(null)
      setLinkProvider(null)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const load = async () => {
      if (cancelled || document.hidden) {
        return
      }
      try {
        const providers = [
          { api: gitlabForge, status: gitlabStatus },
          { api: githubForge, status: githubStatus },
        ]
        for (const { api, status } of providers) {
          let session
          try {
            session = await status()
          } catch {
            continue
          }
          if (!session.connected) {
            continue
          }
          const link = await api.linkGet(repoId)
          if (!link) {
            continue
          }
          if (!cancelled) {
            setLinkWebUrl(link.webUrl)
            setLinkProvider(api.id)
          }
          const page = await api.mrPage({
            projectId: link.projectId,
            scope: 'project',
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
          break
        }
      } catch {
        // Forges are optional; graph rendering must never depend on them.
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
  }, [repoId, generation])

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

  useEffect(() => {
    if (!repoId || !comparison) {
      setCompareReport(null)
      setCompareLoading(false)
      setCompareError(null)
      return
    }
    let cancelled = false
    setCompareReport(null)
    setCompareLoading(true)
    setCompareError(null)
    void diffGet(repoId, {
      target: 'range',
      base: comparison.base,
      targetRef: comparison.target,
    })
      .then((result) => {
        if (!cancelled) {
          setCompareReport(result.data)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCompareError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCompareLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, comparison, generation])

  /** Branch or tag name pointing at a revision, else its short form. */
  const revisionLabel = useCallback(
    (revision: string) => {
      if (revision === 'HEAD') return 'HEAD'
      const entries = refs?.entries ?? []
      const exact = entries.filter(
        (entry) => entry.name === revision || entry.fullName === revision,
      )
      const atRevision = entries.filter((entry) => entry.targetOid === revision)
      const pick =
        exact.find((entry) => entry.kind === 'branch') ??
        exact.find((entry) => entry.kind === 'remoteBranch') ??
        atRevision.find((entry) => entry.kind === 'branch' && entry.isHead) ??
        atRevision.find((entry) => entry.kind === 'branch') ??
        atRevision.find((entry) => entry.kind === 'tag') ??
        exact[0] ??
        atRevision[0]
      return pick?.name ?? shortRevision(revision)
    },
    [refs],
  )

  /**
   * Comparing never leaves the history: the pair opens in the inspector next to
   * the tree, where the changed files and their patch stay readable.
   */
  const startComparison = useCallback(
    (base: string, target: string, commits: string[] = []) => {
      if (!base || !target || base === target) return
      setComparison({ base, target, commits })
      setComparePath(null)
      setLocalDiff(null)
      setContextMenu(null)
      setRefMenu(null)
      setDropMenu(null)
    },
    [],
  )

  /** Every commit between two graph rows, newest row first. */
  const graphRange = useCallback(
    (anchor: string, sha: string) => {
      const first = graph.commits.findIndex((commit) => commit.sha === anchor)
      const second = graph.commits.findIndex((commit) => commit.sha === sha)
      if (first < 0 || second < 0) return null
      return graph.commits
        .slice(Math.min(first, second), Math.max(first, second) + 1)
        .map((commit) => commit.sha)
    },
    [graph.commits],
  )

  /** Sort a selection the way the graph displays it: newest row first. */
  const graphOrder = useCallback(
    (shas: string[]) => {
      const position = new Map(
        graph.commits.map((commit, index) => [commit.sha, index]),
      )
      return [...shas].sort(
        (left, right) =>
          (position.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(right) ?? Number.MAX_SAFE_INTEGER),
      )
    },
    [graph.commits],
  )

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>, pushTarget?: PushRejection) => {
      setActionError(null)
      setActionNotice(null)
      try {
        await action()
        setActionNotice(label)
        onMutated()
      } catch (cause) {
        // A refused push carries a decision the user still has to make.
        if (pushTarget && isPushRejection(cause)) onPushRejected(pushTarget)
        else setActionError(errorMessage(cause))
      }
    },
    [onMutated, onPushRejected],
  )

  const createQuickStash = async () => {
    if (!repoId || stashPending.current || !hasChanges || repo?.state.head?.kind === 'unborn' || repo?.state.operation || repo?.state.conflicts.files.length) return
    stashPending.current = true
    setStashBusy(true)
    try {
      await runAction(t('commit.stash.createdNotice'), () => stashCreate({ repoId, includeUntracked: true }))
    } finally {
      stashPending.current = false
      setStashBusy(false)
    }
  }

  /**
   * Git rewrites HEAD only, so the action is offered exactly for that commit
   * and never while another operation owns the index.
   */
  const headSha = refs?.head?.oid
  const amendBlocked =
    Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)
  const canAmend = (sha: string) =>
    Boolean(repoId && headSha && sha === headSha && !amendBlocked)

  const handleAmended = (sha: string) => {
    setAmendTarget(null)
    setSelected(sha)
    setWorktreeSelected(false)
    setLocalDiff(null)
    setComparison(null)
    setComparePath(null)
    if (view === 'diff') {
      onOpenDiff({ target: 'commit', base: sha, path: diffRequest?.path })
    }
    setActionNotice(t('workbench.notice.amended', { sha: sha.slice(0, 10) }))
    onMutated()
  }

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
    void runAction(t('workbench.notice.branchCreated', { name }), () =>
      branchCreate({ repoId, name, start, checkout: true }),
    )
  }

  const previousBranchRequest = useRef(branchRequest)
  useEffect(() => {
    if (previousBranchRequest.current === branchRequest) return
    previousBranchRequest.current = branchRequest
    if (view === 'graph') {
      setLocalDiff(null); setComparePath(null); setHistoryTool(null)
      startBranchCreate()
    }
  }, [branchRequest, startBranchCreate, view])

  const closeInspector = useCallback(() => {
    if (comparison) {
      setComparison(null)
      setComparePath(null)
      return
    }
    if (selected) {
      setSelected(undefined)
      return
    }
    setWorktreeSelected(false)
    setLocalDiff(null)
  }, [comparison, selected])

  useEffect(() => {
    if (!comparison && !selected && !showWorktree) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        !window.matchMedia('(max-width: 1120px)').matches ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [popover]:popover-open')
      ) {
        return
      }
      event.preventDefault()
      closeInspector()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeInspector, comparison, selected, showWorktree])

  const openRefMenu = (entry: RefEntry, x: number, y: number) => {
    setRefMenu({ entry, x, y, renaming: false, name: entry.name, panel: null })
  }

  const pushBranch = (entry: RefEntry) => {
    if (!repoId) return
    const { remote } = pushTarget(entry)
    setRefMenu(null)
    void runAction(
      t('workbench.notice.branchPushed', { branch: entry.name, remote }),
      () => syncPush({ repoId, remote, branch: entry.name }),
      { repoId, remote, branch: entry.name },
    )
  }

  const applyUpstream = (branch: RefEntry, upstream: string) => {
    if (!repoId) return
    setRefMenu(null)
    void runAction(t('workbench.notice.upstreamSet', { branch: branch.name, upstream }), () =>
      branchUpstream({ repoId, branch: branch.name, upstream }),
    )
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

  const requestIntegration = async (
    mode: 'merge' | 'rebase',
    requested: MergeFastForward = 'auto',
    pair?: { source: RefEntry; target: RefEntry },
  ) => {
    const menu = dropMenu
    const source = pair?.source ?? menu?.source
    const target = pair?.target ?? menu?.target
    if (!source || !target || !repoId) return
    setDropMenu(null)
    setActionError(null)
    setActionNotice(null)
    try {
      const preview = await branchIntegrationPreview({
        repoId,
        source: source.name,
        target: target.name,
        mode,
      })
      if (!preview.applicable) {
        setActionError(
          preview.blockedReason ?? t('workbench.error.integrationImpossible'),
        )
        return
      }
      // A fast-forward is possible exactly when the target has no commit the
      // source lacks; anything else needs a merge commit.
      const canFastForward = preview.fastForward
      const fastForward: MergeFastForward =
        mode === 'merge'
          ? requested === 'never' || !canFastForward
            ? 'never'
            : 'only'
          : 'auto'
      setPendingIntegration({ source, target, mode, fastForward, preview })
    } catch (cause) {
      setActionError(errorMessage(cause))
    }
  }

  const chooseIntegrationStrategy = (fastForward: MergeFastForward) =>
    setPendingIntegration((current) => (current ? { ...current, fastForward } : current))

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
        fastForward: pending.fastForward,
        confirmation: { acknowledged: true },
      })
      setPendingIntegration(null)
      if (result.data.outcome.conflicted) openHistoryTool('conflicts')
      const stash = result.data.autoStash
      const stashNote = stash
        ? stash.popped
          ? t('workbench.notice.localChangesRestored')
          : stash.conflicts.length > 0
            ? t('workbench.notice.stashConflict', { selector: stash.selector })
            : t('workbench.notice.stashPreserved', {
                selector: stash.selector,
                sha: stash.sha.slice(0, 8),
              })
        : ''
      const mergeNote =
        pending.mode === 'merge'
          ? pending.fastForward === 'only'
            ? t('workbench.notice.fastForwardNote')
            : pending.preview.fastForward
              ? t('workbench.notice.mergeCommitNote')
              : ''
          : ''
      setActionNotice(
        (result.data.outcome.conflicted
          ? t('workbench.notice.conflictDuringIntegration', {
              operation:
                pending.mode === 'merge'
                  ? t('workbench.integration.during.merge')
                  : t('workbench.integration.during.rebase'),
            })
          : t('workbench.notice.integrationApplied', {
              operation:
                pending.mode === 'merge'
                  ? t('workbench.integration.operation.merge')
                  : t('workbench.integration.operation.rebase'),
              source: pending.source.name,
              note: mergeNote,
            })) + stashNote,
      )
      onMutated()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setIntegrationBusy(false)
    }
  }

  // Secondary tools share the workspace; the graph never unmounts.
  const renderTool = (toolView = view) => {
    if (toolView === 'profiles') {
      return (
        <div className={styles.content}>
          <ProfilesPanel
            repoId={repoId}
            connected={gitlabConnected}
            theme={theme}
            onThemeChange={onThemeChange}
            density={density}
            onDensityChange={onDensityChange}
            background={background}
            backgroundError={backgroundError}
            onBackgroundChange={onBackgroundChange}
            splash={splash}
            splashError={splashError}
            onSplashChange={onSplashChange}
            onMutated={onMutated}
            onOpenGitlab={() => onNavigate('gitlab')}
            shortcuts={shortcuts}
            shortcutConflict={shortcutConflict}
            onShortcutsChange={onShortcutsChange}
          />
        </div>
      )
    }

    if (toolView === 'recovery') {
      return (
        <div className={styles.content}>
          <RecoveryPanel onOpenRepo={onOpenRepo} />
        </div>
      )
    }

    if (toolView === 'gitlab') {
      return (
        <div className={styles.content}>
          <GitlabPanel repoId={repoId} generation={generation} onLinked={onMutated} />
        </div>
      )
    }

    if (toolView === 'github') {
      return (
        <div className={styles.content}>
          <GithubPanel repoId={repoId} generation={generation} onLinked={onMutated} />
        </div>
      )
    }

    if (toolView === 'workspaces') {
      return (
        <div className={styles.content}>
          <WorkspacesPanel
            onOpenRepo={onOpenRepo}
            activeWorkspaceId={activeWorkspaceId}
            onActivateWorkspace={onActivateWorkspace}
            onWorkspacesChanged={onWorkspacesChanged}
          />
        </div>
      )
    }

    if (!repo || !repoId) {
      return (
        <div className={styles.content}>
          <div className={styles.placeholder}>
            <h2>{t('workbench.empty.noRepo.title')}</h2>
            <p>{t('workbench.empty.noRepo.body')}</p>
          </div>
        </div>
      )
    }

    if (toolView === 'sync') {
      return (
        <SyncPanel
          repoId={repoId}
          generation={generation}
          onMutated={onMutated}
          onPushRejected={onPushRejected}
        />
      )
    }

    if (toolView === 'stash') return null

    if (toolView === 'search') {
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

    if (toolView === 'tools') {
      return <ToolsPanel repoId={repoId} />
    }

    if (toolView === 'conflicts') {
      return (
        <ConflictsPanel
          repoId={repoId}
          generation={generation}
          state={repo.state}
          onMutated={onMutated}
          onDirtyChange={setToolDirty}
        />
      )
    }

    if (toolView === 'rebase') {
      return (
        <RebasePanel
          key={rebaseBase}
          initialUpstream={rebaseBase}
          repoId={repoId}
          generation={generation}
          state={repo.state}
          onMutated={onMutated}
          onDirtyChange={setToolDirty}
          onNavigateConflicts={() => onNavigate('conflicts')}
          onAmendHead={(sha) => setAmendTarget({ sha, subject: '' })}
        />
      )
    }

    if (toolView === 'worktrees') {
      return (
        <WorktreesPanel
          repoId={repoId}
          generation={generation}
          onMutated={onMutated}
          onOpenRepo={onOpenRepo}
        />
      )
    }

    if (toolView === 'tags' || toolView === 'remotes') {
      return (
        <RefsAdminPanel
          repoId={repoId}
          generation={generation}
          key={toolView}
          initialTab={toolView === 'tags' ? 'tags' : 'remotes'}
          onMutated={onMutated}
        />
      )
    }

    if (toolView === 'submodules') {
      return (
        <SubmodulesPanel
          repoId={repoId}
          generation={generation}
          onMutated={onMutated}
          onOpen={(path) => onOpenRepo(`${repo.repo.worktree}/${path}`)}
        />
      )
    }

    if (toolView === 'patches') {
      return <PatchesPanel repoId={repoId} onMutated={onMutated} />
    }

    if (toolView === 'activity') {
      return <ActivityPanel repoId={repoId} />
    }

    if (toolView === 'fileHistory') {
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
          onShowDiff={(path, revision) =>
            onOpenDiff({ target: 'commit', base: revision, path })
          }
        />
      )
    }

    if (toolView === 'mrs' || toolView === 'prs') {
      const api = toolView === 'prs' ? githubForge : gitlabForge
      return (
        <div className={shared.root}>
          <ReviewRequestsPanel
            api={api}
            repoId={repoId}
            generation={generation}
            connected={toolView === 'prs' ? githubConnected : gitlabConnected}
            onCheckout={(branch: string) =>
              void runAction(t('workbench.notice.checkout', { branch }), () =>
                branchCheckout({ repoId, name: branch }),
              )
            }
          />
        </div>
      )
    }

    if (toolView === 'diff') {
      const diffCommit =
        diffRequest?.target === 'commit' && diffRequest.base
          ? graph.commits.find((entry) => entry.sha === diffRequest.base)
          : undefined
      const diffSha = diffRequest?.target === 'commit' ? diffRequest.base : undefined
      const source = !diffRequest
        ? t('workbench.diff.source.none')
        : diffRequest.target === 'commit'
          ? t('workbench.diff.source.commit', { sha: diffRequest.base?.slice(0, 8) ?? '' })
          : diffRequest.target === 'range'
            ? `${shortRevision(diffRequest.base ?? 'HEAD')}…${shortRevision(diffRequest.targetRef ?? 'HEAD')}`
            : diffRequest.target === 'index'
              ? t('workbench.diff.source.index')
              : t('workbench.diff.source.worktree')
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
            <div className={styles.placeholder}>{t('workbench.diff.calculating')}</div>
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
              onAmend={
                diffSha && canAmend(diffSha)
                  ? () =>
                      setAmendTarget({
                        sha: diffSha,
                        subject: diffCommit?.subject ?? shortRevision(diffSha),
                      })
                  : undefined
              }
              readDocument={readDiffDocument}
              onShowHistory={(path) => {
                setFilePath(path)
                onNavigate('fileHistory')
              }}
            />
          ) : (
            <div className={styles.placeholder}>
              <h2>{t('workbench.diff.empty.title')}</h2>
              <p>{t('workbench.diff.empty.body')}</p>
            </div>
          )}
        </div>
      )
    }

    return null
  }
  if (!repo || !repoId) return renderTool()

  // Amend is reachable from the graph menu and the diff view, so the dialog
  // must be mounted by both branches of the render below.
  const amendDialog = amendTarget ? (
    <AmendDialog
      repoId={repoId}
      sha={amendTarget.sha}
      subject={amendTarget.subject}
      staged={repo.state.worktree.staged}
      branch={repo.state.head?.kind === 'branch' ? repo.state.head.name : null}
      onClose={() => setAmendTarget(null)}
      onAmended={handleAmended}
    />
  ) : null

  const tool = renderTool()
  const toolLabel = navigationItems.find((item) => item.id === view)?.labelKey
  const centerTool = ['diff', 'conflicts', 'rebase', 'fileHistory', 'profiles', 'workspaces', 'gitlab', 'github', 'recovery'].includes(view) ? tool : null
  const centerActive = Boolean(previewDiff || centerTool || historyTool)
  const navigatorTools = Object.fromEntries((['worktrees', 'submodules', 'mrs', 'prs', 'patches', 'search', 'remotes', 'tags', 'sync', 'activity', 'tools'] as ViewId[]).map((id) => [id, renderTool(id)]))

  /** References the graph may draw: hidden ones removed, solo respected. */
  const visibleRefs = applyVisibility(
    refs?.entries ?? [],
    visibility,
    refs?.head?.fullName,
  )
  const branches = visibleRefs.filter((entry) => entry.kind === 'branch')
  const branchesAtCommit = (sha: string) =>
    branches.filter((entry) => entry.targetOid === sha)

  const checkoutGraphRef = async (raw: string) => {
    if (checkoutPending.current) return
    const entry = resolveGraphRef(raw, refs?.entries ?? [])
    if (!isCheckoutableRef(entry)) return
    if (entry.isHead) return
    if (repo.state.operation || repo.state.conflicts.files.length > 0) {
      setActionError(t('workbench.error.checkoutBlocked'))
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
        if (tracking) {
          if (tracking.isHead && tracking.targetOid === entry.targetOid) return
          activeBranch = tracking.name
          if (tracking.targetOid === entry.targetOid) {
            await branchCheckout({ repoId, name:tracking.name })
          } else {
            await branchCheckoutAt({ repoId, name:tracking.name, start:entry.fullName })
          }
        } else {
          const remote = entry.remote ?? entry.name.split('/')[0]!
          const name = entry.name.slice(remote.length + 1)
          if (!name) {
            throw new Error(t('workbench.error.remoteBranchNameUndetermined'))
          }
          if (localBranches.some((ref) => ref.name === name)) {
            throw new Error(t('workbench.error.localBranchAlreadyTracks', { name }))
          }
          activeBranch = name
          await branchCheckoutAt({ repoId, name, start:entry.fullName })
          await branchUpstream({ repoId, branch:name, upstream:entry.name })
        }
      }
      setActionNotice(t('workbench.notice.activeBranch', { branch: activeBranch }))
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      checkoutPending.current = false
      setCheckoutBusy(false)
      onMutated()
    }
  }

  /** A dirty conflict draft or rebase plan only disappears with consent. */
  const discardDockDraft = () => !toolDirty || window.confirm(t('workbench.history.discardDraft'))
  const openHistoryTool = (kind: 'stash' | 'rebase' | 'conflicts', base = '') => {
    if (kind === 'stash') { onNavigate('stash'); return true }
    if (view !== 'graph') {
      if (!onNavigate(kind)) return false
      if (kind === 'rebase') setRebaseBase(base)
      return true
    }
    if (historyTool !== kind && !discardDockDraft()) return false
    setContextMenu(null)
    setRefMenu(null)
    setDropMenu(null)
    setLocalDiff(null)
    setComparePath(null)
    if (kind === 'rebase') setRebaseBase(base)
    setHistoryTool(kind)
    setToolDirty(false)
    return true
  }
  const closeHistoryTool = () => {
    if (!discardDockDraft()) return
    setHistoryTool(null)
    setToolDirty(false)
  }
  const openWorktree = () => {
    if ((tool || historyTool) && !onNavigate('graph')) return
    setHistoryTool(null)
    setSelected(undefined)
    setComparison(null)
    setComparePath(null)
    setLocalDiff(null)
    setWorktreeSelected(true)
  }
  const operationBlocked = Boolean(repo.state.operation || repo.state.conflicts.files.length)
  const rebaseBlocked = operationBlocked || hasChanges || repo.state.head?.kind !== 'branch'
  const graphControls = <div className={styles.graphControls}>
    <ActionMenu
      label={t('workbench.history.actions')}
      triggerContent={<>{t('workbench.history.gitMenu')}</>}
      triggerClassName={styles.historyMenu}
    >
      <button type="button" role="menuitem" disabled={operationBlocked || !hasChanges || stashBusy || repo.state.head?.kind === 'unborn'}
        title={operationBlocked ? t('workbench.history.stashBlocked') : undefined}
        onClick={() => void createQuickStash()}>
        {t('workbench.history.stash')}
      </button>
      <button type="button" role="menuitem" disabled={rebaseBlocked}
        title={rebaseBlocked ? t('workbench.history.rebaseBlocked') : undefined}
        onClick={() => openHistoryTool('rebase')}>
        {t('workbench.history.rebase')}
      </button>
      <button type="button" role="menuitem" disabled={!operationBlocked}
        onClick={() => openHistoryTool('conflicts')}>
        {t('workbench.history.operation')}
        {repo.state.conflicts.files.length ? ` · ${formatNumber(repo.state.conflicts.files.length)}` : ''}
      </button>
    </ActionMenu>
    {operationBlocked ? <button type="button" className={styles.operationChip}
      onClick={() => openHistoryTool('conflicts')}>
      <ViewIcon view="conflicts" />{t('workbench.history.operation')}
      {repo.state.conflicts.files.length ? <span>{formatNumber(repo.state.conflicts.files.length)}</span> : null}
    </button> : null}
        <select
          value={allRefs ? '__all__' : revision}
          onChange={(event) => {
            setAllRefs(event.target.value === '__all__')
            if (event.target.value !== '__all__') setRevision(event.target.value)
          }}
          aria-label={t('workbench.graph.filterAriaLabel')}
        >
          <option value="__all__">{t('workbench.graph.filterAll')}</option>
          <option value="">{t('workbench.graph.filterCurrent')}</option>
          {revision && !branches.some((entry) => entry.name === revision) ? (
            <option value={revision}>{revision}</option>
          ) : null}
          {branches.map((entry) => (
            <option key={entry.fullName} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
    <ActionMenu label={t('workbench.graph.optionsLabel')}>
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
          {t('workbench.graph.multiSelect')}
        </label>
        {layout.graph ? (
          <button type="button" onClick={() => onLayoutChange({ graph: null })}>
            {t('workbench.graph.resetColumns')}
          </button>
        ) : null}
    </ActionMenu>
  </div>
  const toolTitle = historyTool === 'rebase'
    ? t('workbench.history.rebase')
    : historyTool === 'stash'
      ? t('workbench.history.stash')
      : t('workbench.history.operation')

  const worktreeStats = [
    { kind: 'staged', count: repo.state.worktree.staged, label: plural('workbench.graph.staged.one', 'workbench.graph.staged.other', repo.state.worktree.staged, { count: formatNumber(repo.state.worktree.staged) }), icon: 'm4 8 4 4 8-8' },
    { kind: 'modified', count: repo.state.worktree.unstaged, label: plural('workbench.graph.unstaged.one', 'workbench.graph.unstaged.other', repo.state.worktree.unstaged, { count: formatNumber(repo.state.worktree.unstaged) }), icon: 'm12 3 3 3-8 8-4 1 1-4zM10 5l3 3' },
    { kind: 'new', count: repo.state.worktree.untracked, label: plural('workbench.graph.untracked.one', 'workbench.graph.untracked.other', repo.state.worktree.untracked, { count: formatNumber(repo.state.worktree.untracked) }), icon: 'M8 3v10M3 8h10' },
    ...(repo.state.worktree.conflicted > 0 ? [{ kind: 'conflicted', count: repo.state.worktree.conflicted, label: plural('shell.statusBar.conflicts.one', 'shell.statusBar.conflicts.other', repo.state.worktree.conflicted, { count: formatNumber(repo.state.worktree.conflicted) }), icon: 'm8 2 7 12H1zM8 6v3M8 11v.1' }] : []),
  ]
  const worktreeSummary = `${t('workbench.graph.worktreeTitle')} · ${worktreeStats.map((stat) => stat.label).join(' · ')}`
  const worktreeRow = hasChanges ? (
    <button type="button" className={styles.worktreeRow} data-role="worktree" data-active={showWorktree} aria-pressed={showWorktree}
      aria-label={worktreeSummary} title={worktreeSummary}
      onClick={() => {
        if ((tool || historyTool) && !onNavigate('graph')) return
        setHistoryTool(null)
        setSelected(undefined); setComparison(null); setComparePath(null); setLocalDiff(null)
        setWorktreeSelected((current) => !current || Boolean(tool || historyTool))
      }}>
      <span className={styles.wipRef} aria-hidden="true"><span>// WIP</span></span>
      <span className={styles.wipMarker} aria-hidden="true" />
      <span className={styles.wipMessage} aria-hidden="true">
        <strong>{t('workbench.graph.worktreeTitle')}</strong>
        <span className={styles.wipStats}>
          {worktreeStats.map((stat) => (
            <span key={stat.kind} className={styles.wipStat} data-kind={stat.kind} data-empty={stat.count === 0} title={stat.label}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={stat.icon} /></svg>
              <span className={styles.wipStatLabel}>{stat.label}</span>
              <span className={styles.wipStatCount}>{formatNumber(stat.count)}</span>
            </span>
          ))}
        </span>
      </span>
    </button>
  ) : null

  const openContextMenu = (
    commit: CommitSummary,
    stash: string | undefined,
    x: number,
    y: number,
  ) => {
    setContextMenu({ commit, stash, x, y, panel: null })
  }

  const closeMenu = () => setContextMenu(null)

  const currentBranch = repo.state.head?.kind === 'branch' ? repo.state.head.name : null
  const currentBranchEntry = branches.find((entry) => entry.isHead) ?? null

  /** Local and remote branches pointing at a commit, for the checkout panel. */
  const refsAtCommit = (sha: string) =>
    (refs?.entries ?? []).filter(
      (entry) =>
        entry.targetOid === sha &&
        (entry.kind === 'branch' || entry.kind === 'remoteBranch') &&
        !entry.name.endsWith('/HEAD'),
    )

  const copyText = async (text: string, notice: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setActionNotice(notice)
    } catch {
      setActionError(t('workbench.error.clipboardUnavailable'))
    }
  }

  const copyLink = (
    target: 'branch' | 'commit',
    reference: string,
    remoteName?: string | null,
  ) => {
    const root = projectWebUrl(refs?.remoteUrls, linkWebUrl, remoteName ?? null)
    const url = root ? refWebUrl(root, target, reference) : null
    if (!url) {
      setActionError(t('workbench.error.unknownRemote'))
      return
    }
    void copyText(url, t('workbench.notice.linkCopied', { url }))
  }

  /**
   * The vendor's Cloud Patch has no server here: the patch is generated locally
   * and either saved to a file or copied, never uploaded.
   */
  const exportPatch = async (sha: string, saveFile: boolean) => {
    if (!repoId) return
    setActionError(null)
    try {
      const patch = await patchCreate({
        repoId,
        source: { kind: 'commit', sha, paths: [] },
      })
      if (!saveFile) {
        await copyText(patch.text, t('workbench.notice.patchCopied'))
        return
      }
      const path = await saveNativeDialog({
        defaultPath: `${repo.repo.name}-${sha.slice(0, 10)}.patch`,
      })
      if (!path) return
      await patchSave(path, patch.text)
      setActionNotice(t('workbench.notice.patchSaved', { path }))
    } catch (cause) {
      setActionError(errorMessage(cause))
    }
  }

  /** Soft and mixed only: `--hard` would not be reversible. */
  const resetCurrentTo = (sha: string, mode: 'soft' | 'mixed') => {
    if (!repoId || !currentBranch) return
    closeMenu()
    setRefMenu(null)
    void runAction(
      t('workbench.notice.branchReset', {
        branch: currentBranch,
        mode:
          mode === 'soft'
            ? t('workbench.reset.mode.soft')
            : t('workbench.reset.mode.mixed'),
        sha: sha.slice(0, 10),
      }),
      () => historyReset({ repoId, revision: sha, mode }),
    )
  }

  const togglePin = (entry: RefEntry) => {
    if (!repoId) return
    const next = { ...pins }
    const pinned = next[repoId] === entry.fullName
    if (pinned) delete next[repoId]
    else next[repoId] = entry.fullName
    setPins(next)
    setActionNotice(
      pinned
        ? t('workbench.notice.unpinned', { branch: entry.name })
        : t('workbench.notice.pinned', { branch: entry.name }),
    )
    void preferenceSet('ui.graph.pins', JSON.stringify(next)).catch((cause: unknown) =>
      setActionError(errorMessage(cause)),
    )
    setRefMenu(null)
  }

  /** Solo keeps the graph walk to one branch, without touching the repository. */
  const soloOn = (entry: RefEntry) => {
    setAllRefs(false)
    setRevision(entry.name)
    setRefMenu(null)
    persistVisibility({
      ...visibility,
      filter: { allRefs: false, revision: entry.name },
    })
    setActionNotice(t('workbench.notice.graphIsolated', { branch: entry.name }))
  }

  const action = (
    key: string,
    icon: Parameters<typeof ViewIcon>[0]['view'],
    label: string,
    onClick: () => void,
    options?: { disabled?: boolean; title?: string },
  ) => (
    <button
      key={key}
      type="button"
      className={styles.contextAction}
      role="menuitem"
      disabled={options?.disabled}
      title={options?.title}
      onClick={onClick}
    >
      <ViewIcon view={icon} />
      <span>{label}</span>
    </button>
  )

  const expander = (
    key: string,
    icon: Parameters<typeof ViewIcon>[0]['view'],
    label: string,
    open: boolean,
    onToggle: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className={styles.contextAction}
      role="menuitem"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ViewIcon view={icon} />
      <span>{label}</span>
      <span className={styles.contextChevron} aria-hidden="true">
        {open ? '⌄' : '›'}
      </span>
    </button>
  )

  const separator = (key: string) => (
    <div key={key} className={styles.contextSeparator} role="separator" />
  )

  // The first and last picked commits are the A/B pair: a shift range is picked
  // oldest first, so the diff reads as chronology instead of click order.
  const canCompare = picked.length >= 2
  const compareBase = picked[0]
  const compareTarget = picked[picked.length - 1]
  const inspectorMax = Math.min(
    INSPECTOR_MAX,
    Math.max(INSPECTOR_MIN, Math.round(window.innerWidth * 0.6)),
  )
  const pinnedFullName = repoId ? pins[repoId] ?? null : null
  const pinnedEntry = pinnedFullName
    ? (refs?.entries ?? []).find((entry) => entry.fullName === pinnedFullName) ?? null
    : null
  const pinnedIndex = pinnedEntry
    ? graph.commits.findIndex((commit) => commit.sha === pinnedEntry.targetOid)
    : -1
  const pinnedLane = pinnedIndex >= 0 ? graph.rows[pinnedIndex]?.nodeLane ?? 0 : 0
  const graphPin =
    pinnedIndex >= 0 && pinnedLane > 0 ? { row: pinnedIndex, lane: pinnedLane } : null
  /** A local branch deletes the remote its upstream names, not `origin` blind. */
  const remoteDeleteTarget = pendingRemoteDelete
    ? pendingRemoteDelete.kind === 'remoteBranch'
      ? {
          remote:
            pendingRemoteDelete.remote ??
            pendingRemoteDelete.name.split('/')[0] ??
            'origin',
          branch: remoteBranchName(pendingRemoteDelete) ?? pendingRemoteDelete.name,
        }
      : upstreamTarget(pendingRemoteDelete)
    : null
  const remoteDeleteLabel = remoteDeleteTarget
    ? `${remoteDeleteTarget.remote}/${remoteDeleteTarget.branch}`
    : ''

  return (
    <div className={styles.content}>
      {picked.length > 0 ? <div className={styles.graphToolbar}>
        {picked.length > 0 ? (
          <>
            <span className={shared.notice}>{plural('workbench.selection.count.one', 'workbench.selection.count.other', picked.length, { count: formatNumber(picked.length) })}</span>
            {picked.length === 1 ? (
              <span className={shared.small}>
                {t('workbench.selection.hint')}
              </span>
            ) : null}
            {canCompare ? (
              <button
                type="button"
                className={shared.secondary}
                aria-pressed={comparison !== null}
                title={t('workbench.selection.compareTitle', {
                  base: shortRevision(compareBase!),
                  target: shortRevision(compareTarget!),
                  count: plural(
                    'workbench.selection.compareCount.one',
                    'workbench.selection.compareCount.other',
                    picked.length,
                    { count: formatNumber(picked.length) },
                  ),
                })}
                onClick={() => startComparison(compareBase!, compareTarget!, graphOrder(picked))}
              >
                {t('workbench.selection.compare', {
                  base: shortRevision(compareBase!),
                  target: shortRevision(compareTarget!),
                })}
              </button>
            ) : null}
            <button
              type="button"
              className={shared.secondary}
              disabled={picked.length < 2}
              title={t('workbench.selection.squash', { count: formatNumber(picked.length) })}
              onClick={() => {
                const shas = [...picked]
                setSquashShas(shas)
              }}
            >
              {t('workbench.selection.squash', { count: formatNumber(picked.length) })}
            </button>
            <button
              type="button"
              className={shared.primary}
              disabled={picked.length === 0}
              onClick={() => {
                const shas = [...picked]
                setPicked([])
                void runAction(t('workbench.notice.cherryPickDone'), () =>
                  historyCherryPick(repoId, shas),
                )
              }}
            >
              {t('workbench.action.cherryPick')}
            </button>
            <button
              type="button"
              className={shared.secondary}
              disabled={picked.length === 0}
              onClick={() => {
                const shas = [...picked]
                setPicked([])
                void runAction(t('workbench.notice.revertDone'), () => historyRevert(repoId, shas))
              }}
            >
              {t('workbench.action.revert')}
            </button>
            <button type="button" className={shared.small} onClick={() => setPicked([])}>
              {t('workbench.action.clear')}
            </button>
          </>
        ) : null}
      </div> : null}
      {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}
      {actionNotice ? <div className={styles.actionNotice} role="status">{actionNotice}</div> : null}

      {graph.error ? (
        <div className={styles.error} role="alert">
          {graph.error}
        </div>
      ) : null}
      <div className={styles.graphLayout} style={{ '--inspector-width': `${layout.inspector}px` } as CSSProperties}>
        <RepositoryNavigator name={repo.repo.name} entries={refs?.entries ?? []} stashes={stashEntries}
          current={currentBranch} selected={selected} active={view} tools={navigatorTools}
          busy={checkoutBusy} onNavigate={onNavigate} gitlabConnected={gitlabConnected} githubConnected={githubConnected}
          onSelect={(sha) => {
            if (!onNavigate('graph')) return
            setHistoryTool(null); setSelected(sha); setReveal((previous) => ({ sha, serial: (previous?.serial ?? 0) + 1 })); setWorktreeSelected(false)
            setComparison(null); setComparePath(null); setLocalDiff(null)
            if (!graph.commits.some((commit) => commit.sha === sha)) setRevision(sha)
          }}
          onCheckout={(entry) => void checkoutGraphRef(entry.fullName)} onRefMenu={openRefMenu}
          onStashMenu={(entry, x, y) => {
            const commit = graph.commits.find((item) => item.sha === entry.sha)
            if (commit) openContextMenu(commit, entry.selector, x, y)
            else void commitGet(repoId, entry.sha).then((result) => openContextMenu(result.data.summary, entry.selector, x, y)).catch((cause) => setActionError(errorMessage(cause)))
          }}
          onCreateBranch={() => {
            if (!onNavigate('graph')) return
            setLocalDiff(null); setComparePath(null); setHistoryTool(null)
            startBranchCreate()
          }}
          onCreateTag={() => setTagTarget({ sha: selected ?? headSha ?? 'HEAD', annotated: false })}
          onCreateStash={() => void createQuickStash()} canStash={!operationBlocked && hasChanges && !stashBusy}
        />
        <Resizer className={styles.navigatorResizer} label={t('shell.resizer.navigation')} side="right"
          value={layout.sidebar} min={SIDEBAR_MIN} max={SIDEBAR_MAX}
          onChange={(sidebar) => onLayoutChange({ sidebar })} onReset={() => onLayoutChange({ sidebar: 210 })} />
        <div className={styles.historyMain}>

          <div className={styles.graphRegion} hidden={centerActive}>
        {graph.commits.length === 0 && !graph.loading ? (
          <div className={styles.emptyHistory}>
            {worktreeRow}
            <div className={styles.placeholder}><h2>{t('workbench.graph.emptyTitle')}</h2>
            <p>{t('workbench.graph.emptyBody')}</p></div>
          </div>
        ) : (
          <GraphCanvas
            worktreeRow={worktreeRow}
            headerTools={graphControls}
            columnWidths={layout.graph}
            onColumnWidthsChange={(graph) => onLayoutChange({ graph })}
            commits={graph.commits}
            rows={graph.rows}
            selected={selected}
            reveal={reveal}
            mrBadges={badges}
            refEntries={visibleRefs}
            pin={graphPin}
            checkoutDisabled={checkoutBusy}
            onCheckoutRef={(raw) => void checkoutGraphRef(raw)}
            picked={picked}
            onSelect={(sha, modifiers) => {
              if ((tool || historyTool) && !onNavigate('graph')) return
              setHistoryTool(null)
              setSelected(sha)
              setWorktreeSelected(false)
              setLocalDiff(null)
              setComparePath(null)
              if (modifiers.meta) {
                // Endpoint comparison: the anchor and the clicked row only,
                // whatever sits between them. The A→B diff keeps the click
                // direction, and the picked pair drives Cherry-pick and Revert
                // without dragging the commits in between along.
                const anchor = rangeAnchor.current ?? selected
                if (anchor && anchor !== sha) {
                  const pair = graphOrder([anchor, sha])
                  setPicked(pair)
                  startComparison(anchor, sha, pair)
                  return
                }
                rangeAnchor.current = sha
                setPicked([])
                setComparison(null)
                return
              }
              if (modifiers.shift) {
                // Shift extends the selection from the anchor to the clicked
                // row: every commit in between is picked, oldest first so the
                // action list applies in history order, while the A→B diff
                // keeps the click direction.
                const anchor = rangeAnchor.current ?? selected
                const range =
                  anchor && anchor !== sha ? graphRange(anchor, sha) : null
                if (anchor && range && range.length > 0) {
                  setPicked([...range].reverse())
                  startComparison(anchor, sha, range)
                  return
                }
                setPicked([sha])
                setComparison(null)
                return
              }
              rangeAnchor.current = sha
              setComparison(null)
              if (multiSelect) {
                setPicked((current) =>
                  current.includes(sha)
                    ? current.filter((value) => value !== sha)
                    : [...current, sha],
                )
                return
              }
              setPicked([])
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
          {centerActive ? <div className={styles.centralEditor} data-central-editor={view}>
            <div className={styles.previewHeading}>
              <span>{centerTool && toolLabel ? t(toolLabel) : historyTool ? toolTitle : t('workbench.preview.ariaLabel')}</span>
              <code>{previewDiff?.path}</code>
              <button type="button" aria-label={t(previewDiff ? 'workbench.preview.closeAriaLabel' : 'workbench.workspace.closeTool')}
                onClick={() => {
                  if (centerTool) onNavigate('graph')
                  else if (historyTool) closeHistoryTool()
                  else { setLocalDiff(null); setComparePath(null) }
                }}>×</button>
            </div>
            <div className={styles.toolBody}>
              {centerTool ?? (historyTool === 'rebase' ? <RebasePanel key={rebaseBase} repoId={repoId} generation={generation}
                state={repo.state} initialUpstream={rebaseBase} onMutated={onMutated} onDirtyChange={setToolDirty}
                onAmendHead={(sha) => setAmendTarget({ sha, subject: '' })}
                onNavigateConflicts={() => openHistoryTool('conflicts')} /> :
              historyTool === 'conflicts' ? <ConflictsPanel repoId={repoId} generation={generation} state={repo.state}
                onMutated={onMutated} onDirtyChange={setToolDirty} /> : previewDiff ? <div className={styles.diffPreview}
                  aria-label={t('workbench.preview.ariaLabel')} aria-busy={diffLoading}>
                {diffError ? <div className={styles.error} role="alert">{diffError}</div> : null}
                {diffLoading ? <div className={styles.placeholder}>{t('workbench.preview.loading')}</div> : report ?
                  <DiffViewer embedded report={report} source="" readDocument={readPreviewDocument}
                    onShowHistory={(path) => { setFilePath(path); onNavigate('fileHistory') }}
                    staging={localDiff?.allowActions && !localDiff.untracked && (localDiff.target === 'worktree' || localDiff.target === 'index')
                      ? { repoId, target: localDiff.target, onMutated } : undefined} /> : null}
              </div> : null)}
            </div>
          </div> : null}
        </div>
        {!['gitlab', 'github', 'workspaces', 'profiles', 'recovery'].includes(view) && (comparison || selected || showWorktree) ? (
          <div className={styles.inspectorDock}>
            <Resizer
              className={styles.inspectorResizer}
              label={t('workbench.inspector.resizeLabel')}
              side="left"
              value={layout.inspector}
              min={INSPECTOR_MIN}
              max={inspectorMax}
              onChange={(inspector) => onLayoutChange({ inspector })}
              onReset={() => onLayoutChange({ inspector: defaultInspectorWidth() })}
            />
            {comparison ? <ComparisonPanel
              base={comparison.base}
              target={comparison.target}
              baseLabel={revisionLabel(comparison.base)}
              targetLabel={revisionLabel(comparison.target)}
              commits={comparisonCommits}
              report={compareReport}
              loading={compareLoading}
              error={compareError}
              activePath={comparePath}
              onSelectPath={(path) =>
                setComparePath((current) => (current === path ? null : path))
              }
              onClose={() => { setComparison(null); setComparePath(null) }}
              onSwap={() => setComparison((current) => current ? { ...current, base: current.target, target: current.base } : current)}
              onFullScreen={() => onOpenDiff({ target: 'range', base: comparison.base, targetRef: comparison.target })}
            /> : selected ? <CommitDetailPanel
              onClose={() => setSelected(undefined)}
              detail={detail && detail.summary.sha === selected ? detail : null}
              loading={detailLoading && !(detail && detail.summary.sha === selected)}
              error={detailError}
              onShowDiff={(sha, path) => onOpenDiff({ target: 'commit', base: sha, path })}
              onShowHistory={(path) => {
                setFilePath(path)
                onNavigate('fileHistory')
              }}
            /> : showWorktree ? <aside className={styles.worktreePanel} aria-label={t('workbench.inspector.worktreeAriaLabel')}>
              <div className={styles.worktreeHeading}><strong>{t('common.files')}</strong><span>{repo.state.head?.kind === 'branch' ? repo.state.head.name : 'HEAD'}</span><button type="button" aria-label={t('workbench.inspector.closeWorktreeAriaLabel')} onClick={() => { setWorktreeSelected(false); setLocalDiff(null) }}>×</button></div>
              <RepoStatus repoId={repoId} generation={generation} locks={repo.locks}
                selectedPath={localDiff?.path} onSelectDiff={setLocalDiff} onMutated={onMutated}
                onNavigate={(target) => {
                  if (target === 'conflicts' || target === 'stash') openHistoryTool(target)
                  else if (target === 'commit') openWorktree()
                  else onNavigate(target)
                }} />
              <CommitPanel compact repoId={repoId} generation={generation} onMutated={onMutated} onUndo={onUndo} />
            </aside> : null}
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} title={contextMenu.stash ?? contextMenu.commit.sha.slice(0, 10)} subtitle={contextMenu.commit.subject} onClose={closeMenu}>
          <div className={styles.contextActions}>
            {contextMenu.stash ? (
              <>
                {action('stash-apply', 'stash', t('workbench.menu.stashApply'), () => {
                  const selector = contextMenu.stash!
                  closeMenu()
                  if (!repoId) return
                  void runAction(t('workbench.notice.stashApplied', { selector }), () => stashApply(repoId, selector))
                })}
                {action('stash-pop', 'stash', t('workbench.menu.stashApplyRemove'), () => {
                  const selector = contextMenu.stash!
                  closeMenu()
                  if (!repoId) return
                  void runAction(t('workbench.notice.stashAppliedRemoved', { selector }), () =>
                    stashPop(repoId, selector),
                  )
                })}
                {separator('stash-copy')}
                {action('copy-sha', 'patches', t('workbench.menu.copySha'), () => {
                  const { sha } = contextMenu.commit
                  closeMenu()
                  void copyText(sha, t('workbench.notice.shaCopied', { sha }))
                })}
                {separator('stash-drop')}
                {action('stash-drop-action', 'diff', t('workbench.menu.stashDelete'), () => {
                  const { sha } = contextMenu.commit
                  const selector = contextMenu.stash!
                  closeMenu()
                  setPendingStashDrop({ selector, sha })
                })}
              </>
            ) : (
              <>
            {expander('checkout', 'branch', t('workbench.menu.checkout'), contextMenu.panel === 'checkout', () =>
              setContextMenu((current) =>
                current
                  ? { ...current, panel: current.panel === 'checkout' ? null : 'checkout' }
                  : current,
              ),
            )}
            {contextMenu.panel === 'checkout' ? (
              <>
                {refsAtCommit(contextMenu.commit.sha).map((entry) =>
                  action(
                    `checkout-${entry.fullName}`,
                    entry.kind === 'branch' ? 'branch' : 'remotes',
                    t('workbench.menu.switchTo', { name: entry.name }),
                    () => {
                      closeMenu()
                      void checkoutGraphRef(entry.fullName)
                    },
                    {
                      disabled: entry.isHead || checkoutBusy,
                      title:
                        entry.kind === 'remoteBranch'
                          ? t('workbench.menu.remoteCheckoutTitle')
                          : undefined,
                    },
                  ),
                )}
                {action('checkout-detached', 'graph', t('workbench.menu.detachedHead'), () => {
                  const sha = contextMenu.commit.sha
                  closeMenu()
                  void runAction(t('workbench.notice.detachedCheckout'), () =>
                    branchCheckout({ repoId, detachedAt: sha }),
                  )
                })}
              </>
            ) : null}
            {action('worktree', 'worktrees', t('workbench.menu.createWorktreeHere'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setWorktreeTarget(sha)
            })}
            {action('branch-here', 'branch', t('workbench.menu.createBranchHere'), () =>
              startBranchCreate(contextMenu.commit.sha),
            )}
            {separator('history')}
            {action('interactive-rebase', 'rebase', t('workbench.history.rebaseHere'),
              () => openHistoryTool('rebase', contextMenu.commit.sha),
              { disabled: rebaseBlocked, title: rebaseBlocked ? t('workbench.history.rebaseBlocked') : undefined })}
            {action('cherry-pick', 'commit', t('workbench.menu.cherryPickCommit'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void runAction(t('workbench.notice.cherryPickDone'), () =>
                historyCherryPick(repoId, [sha]),
              )
            })}
            {currentBranch
              ? expander(
                  'reset',
                  'recovery',
                  t('workbench.menu.resetCurrent', { branch: currentBranch }),
                  contextMenu.panel === 'reset',
                  () =>
                    setContextMenu((current) =>
                      current
                        ? { ...current, panel: current.panel === 'reset' ? null : 'reset' }
                        : current,
                    ),
                )
              : null}
            {contextMenu.panel === 'reset' && currentBranch ? (
              <>
                {action(
                  'reset-soft',
                  'recovery',
                  t('workbench.menu.resetSoft'),
                  () => resetCurrentTo(contextMenu.commit.sha, 'soft'),
                )}
                {action(
                  'reset-mixed',
                  'recovery',
                  t('workbench.menu.resetMixed'),
                  () => resetCurrentTo(contextMenu.commit.sha, 'mixed'),
                )}
                <p className={styles.contextHint}>
                  {t('workbench.menu.resetHint', { branch: currentBranch })}
                </p>
              </>
            ) : null}
            {action('revert', 'patches', t('workbench.menu.revertCommit'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void runAction(t('workbench.notice.revertDone'), () => historyRevert(repoId, [sha]))
            })}
            {canAmend(contextMenu.commit.sha)
              ? action(
                  'amend',
                  'commit',
                  t('workbench.menu.amendCommit'),
                  () => {
                    const { sha, subject } = contextMenu.commit
                    closeMenu()
                    setAmendTarget({ sha, subject })
                  },
                  { title: t('workbench.menu.amendTitle') },
                )
              : null}
            {action('compare', 'diff', t('workbench.menu.compareCurrentBranch'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              startComparison(sha, 'HEAD')
            })}
            {separator('copy')}
            {action('copy-sha', 'patches', t('workbench.menu.copySha'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void copyText(sha, t('workbench.notice.shaCopied', { sha }))
            })}
            {action(
              'copy-link',
              'remotes',
              t('workbench.menu.copyCommitLink'),
              () => {
                const sha = contextMenu.commit.sha
                closeMenu()
                copyLink('commit', sha)
              },
              {
                disabled: !linkWebUrl && !refs?.remoteUrls?.length,
                title: t('workbench.menu.recognizedRemoteTitle'),
              },
            )}
            {separator('patch')}
            {action('patch-save', 'patches', t('workbench.menu.createPatch'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void exportPatch(sha, true)
            })}
            {action('patch-copy', 'patches', t('workbench.menu.copyPatch'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void exportPatch(sha, false)
            })}
            {separator('tags')}
            {action('tag', 'tags', t('workbench.menu.createTagHere'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setTagTarget({ sha, annotated: false })
            })}
            {action('tag-annotated', 'tags', t('workbench.menu.createAnnotatedTagHere'), () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setTagTarget({ sha, annotated: true })
            })}
            {separator('mr')}
            {action('mr', 'mrs', t('workbench.menu.openMergeRequest'), () => {
              const atCommit = branchesAtCommit(contextMenu.commit.sha)[0]?.name
              const branch = atCommit ?? currentBranch
              closeMenu()
              if (!linkWebUrl || !branch) {
                setActionError(t('workbench.error.mergeRequestUnavailable'))
                return
              }
              const url =
                linkProvider === 'github'
                  ? `${linkWebUrl}/compare/${encodeURIComponent(branch)}?expand=1`
                  : `${linkWebUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
              void openExternalUrl(url)
            })}
              </>
            )}
          </div>
        </ContextMenu>
      ) : null}

      {dropMenu ? (
        <ContextMenu
          x={dropMenu.x}
          y={dropMenu.y}
          title={`${dropMenu.source.name} → ${dropMenu.target.name}`}
          subtitle={t('workbench.menu.dragDrop')}
          onClose={() => setDropMenu(null)}
        >
          <div className={styles.contextActions}>
            {dropMenu.fastForward ? (
              <button
                type="button"
                className={styles.contextAction}
                role="menuitem"
                title={t('workbench.drop.advanceTitle', { target: dropMenu.target.name, source: dropMenu.source.name })}
                onClick={() => void requestIntegration('merge', 'only')}
              >
                <ViewIcon view="sync" /><span>{t('workbench.drop.advance', { target: dropMenu.target.name, source: dropMenu.source.name })}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              title={t('workbench.drop.mergeTitle', { source: dropMenu.source.name, target: dropMenu.target.name })}
              onClick={() => void requestIntegration('merge')}
            >
              <ViewIcon view="mrs" /><span>{t('workbench.drop.merge', { source: dropMenu.source.name, target: dropMenu.target.name })}</span>
            </button>
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              title={t('workbench.drop.rebaseTitle', { source: dropMenu.source.name, target: dropMenu.target.name })}
              onClick={() => void requestIntegration('rebase')}
            >
              <ViewIcon view="rebase" /><span>{t('workbench.drop.rebase', { source: dropMenu.source.name, target: dropMenu.target.name })}</span>
            </button>
            {currentBranchEntry?.fullName === dropMenu.source.fullName ? action(
              'interactive-rebase', 'rebase', t('workbench.history.rebaseHere'),
              () => openHistoryTool('rebase', dropMenu.target.fullName),
              { disabled: rebaseBlocked },
            ) : null}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              onClick={() => {
                const { source, target } = dropMenu
                startComparison(source.name, target.name)
              }}
            >
              <ViewIcon view="diff" /><span>{t('workbench.drop.compare', { source: dropMenu.source.name, target: dropMenu.target.name })}</span>
            </button>
          </div>
        </ContextMenu>
      ) : null}

      <ConfirmDialog
        open={pendingIntegration !== null}
        title={
          pendingIntegration
            ? t(
                pendingIntegration.mode === 'merge'
                  ? 'workbench.integration.dialogMerge'
                  : 'workbench.integration.dialogRebase',
                { source: pendingIntegration.source.name, target: pendingIntegration.target.name },
              )
            : ''
        }
        consequence={integrationConsequence(pendingIntegration)}
        confirmLabel={t(
          pendingIntegration?.mode === 'rebase'
            ? 'workbench.integration.rebaseAction'
            : 'workbench.integration.mergeAction',
        )}
        busy={integrationBusy}
        onCancel={() => setPendingIntegration(null)}
        onConfirm={() => void confirmIntegration()}
      >
        {pendingIntegration?.mode === 'merge' ? (
          <fieldset className={styles.strategy}>
            <legend>{t('workbench.integration.strategyLegend')}</legend>
            <label className={styles.strategyOption}>
              <input
                type="radio"
                name="integration-fast-forward"
                value="only"
                checked={pendingIntegration.fastForward === 'only'}
                disabled={!pendingIntegration.preview.fastForward}
                title={
                  pendingIntegration.preview.fastForward
                    ? undefined
                    : fastForwardReason(pendingIntegration.preview) ?? undefined
                }
                onChange={() => chooseIntegrationStrategy('only')}
              />
              <span>
                {t('workbench.integration.strategyFastForward')}
                <span className={styles.strategyNote}>
                  {fastForwardReason(pendingIntegration.preview) ??
                    t('workbench.integration.strategyUpToDate', {
                      target: pendingIntegration.target.name,
                      source: pendingIntegration.source.name,
                    })}
                </span>
              </span>
            </label>
            <label className={styles.strategyOption}>
              <input
                type="radio"
                name="integration-fast-forward"
                value="never"
                checked={pendingIntegration.fastForward === 'never'}
                onChange={() => chooseIntegrationStrategy('never')}
              />
              <span>
                {t('workbench.integration.strategyMergeCommit')} (<code>--no-ff</code>)
                <span className={styles.strategyNote}>
                  {t('workbench.integration.strategyMergeNote')}
                </span>
              </span>
            </label>
          </fieldset>
        ) : null}
      </ConfirmDialog>

      {amendDialog}

      {squashShas ? (
        <SquashDialog
          repoId={repoId}
          shas={squashShas}
          onClose={() => setSquashShas(null)}
          onSquashed={() => {
            setSquashShas(null)
            setPicked([])
            setActionNotice(t('workbench.notice.squashed'))
            onMutated()
          }}
        />
      ) : null}

      {tagTarget ? (
        <TagDialog
          repoId={repoId}
          target={tagTarget.sha}
          annotated={tagTarget.annotated}
          onClose={() => setTagTarget(null)}
          onCreated={(name) => {
            setTagTarget(null)
            setActionNotice(t('workbench.notice.tagCreated', { name }))
            onMutated()
          }}
        />
      ) : null}
      {worktreeTarget ? (
        <WorktreeDialog
          repoId={repoId}
          reference={worktreeTarget}
          onClose={() => setWorktreeTarget(null)}
          onCreated={(path) => {
            setWorktreeTarget(null)
            setActionNotice(t('workbench.notice.worktreeCreated', { path }))
            onMutated()
          }}
        />
      ) : null}

      {refMenu ? (
        <ContextMenu
          x={refMenu.x}
          y={refMenu.y}
          title={refMenu.entry.name}
          subtitle={
            refMenu.entry.kind === 'remoteBranch'
              ? t('workbench.refMenu.remoteBranch')
              : refMenu.entry.kind === 'tag'
                ? t('workbench.refMenu.tag')
                : t('workbench.refMenu.localBranch')
          }
          onClose={() => setRefMenu(null)}
        >
          <div className={styles.contextActions}>
            {refMenu.entry.kind !== 'tag'
              ? action(
                  'checkout',
                  'branch',
                  t('workbench.menu.switchTo', { name: refMenu.entry.name }),
                  () => {
                    const raw = refMenu.entry.fullName
                    setRefMenu(null)
                    void checkoutGraphRef(raw)
                  },
                  {
                    disabled: refMenu.entry.isHead || checkoutBusy,
                    title: refMenu.entry.isHead ? t('workbench.refMenu.branchAlreadyCheckedOut') : undefined,
                  },
                )
              : null}
            {action(
              'hide-ref',
              'branch',
              visibility.hidden.includes(refMenu.entry.fullName)
                ? t('workbench.refMenu.show')
                : t('workbench.refMenu.hide'),
              () => {
                const fullName = refMenu.entry.fullName
                setRefMenu(null)
                persistVisibility({
                  ...visibility,
                  hidden: visibility.hidden.includes(fullName)
                    ? visibility.hidden.filter((value) => value !== fullName)
                    : [...visibility.hidden, fullName],
                })
              },
            )}
            {refMenu.entry.kind === 'branch' ? (
              <>
                {refMenu.entry.isHead
                  ? action('pull', 'sync', t('workbench.refMenu.pullFastForwardOnly'), () => {
                      const entry = refMenu.entry
                      setRefMenu(null)
                      void runAction(t('workbench.notice.pulledFastForward', { branch: entry.name }), () =>
                        syncPull({
                          repoId,
                          remote: pushTarget(entry).remote,
                          branch: entry.name,
                          strategy: 'ffOnly',
                        }),
                      )
                    })
                  : null}
                {action(
                  'push',
                  'sync',
                  t('workbench.refMenu.pushTo', { target: pushTarget(refMenu.entry).target }),
                  () => pushBranch(refMenu.entry),
                )}
                {expander(
                  'upstream',
                  'remotes',
                  refMenu.entry.upstream
                    ? t('workbench.refMenu.upstream', { upstream: refMenu.entry.upstream })
                    : t('workbench.refMenu.setUpstream'),
                  refMenu.panel === 'upstream',
                  () =>
                    setRefMenu((current) =>
                      current
                        ? {
                            ...current,
                            panel: current.panel === 'upstream' ? null : 'upstream',
                            renaming: false,
                          }
                        : current,
                    ),
                )}
                {refMenu.panel === 'upstream'
                  ? (() => {
                      const remotes = (refs?.entries ?? []).filter(
                        (entry) => entry.kind === 'remoteBranch' && !entry.name.endsWith('/HEAD'),
                      )
                      if (remotes.length === 0) {
                        return action(
                          'upstream-empty',
                          'remotes',
                          t('workbench.refMenu.noRemoteBranches'),
                          () => undefined,
                          { disabled: true },
                        )
                      }
                      return remotes.map((remoteBranch) =>
                        action(
                          `upstream-${remoteBranch.fullName}`,
                          'remotes',
                          `${remoteBranch.name}${remoteBranch.name === refMenu.entry.upstream ? t('workbench.refMenu.currentSuffix') : ''}`,
                          () => applyUpstream(refMenu.entry, remoteBranch.name),
                        ),
                      )
                    })()
                  : null}
              </>
            ) : null}
            {refMenu.entry.kind === 'branch' &&
            !refMenu.entry.isHead &&
            currentBranchEntry ? (
              <>
                {separator('integrate')}
                {action(
                  'fast-forward',
                  'sync',
                  t('workbench.drop.advance', { target: refMenu.entry.name, source: currentBranchEntry.name }),
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('merge', 'only', {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                  { title: t('workbench.integration.strategyFastForward') },
                )}
                {action(
                  'merge',
                  'mrs',
                  t('workbench.drop.merge', { source: currentBranchEntry.name, target: refMenu.entry.name }),
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('merge', 'auto', {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                  { title: t('workbench.integration.fastForwardHint') },
                )}
                {action(
                  'rebase',
                  'rebase',
                  t('workbench.drop.rebase', { source: currentBranchEntry.name, target: refMenu.entry.name }),
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('rebase', 'auto', {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                )}
              </>
            ) : null}
            {(refMenu.entry.kind === 'branch' || refMenu.entry.kind === 'remoteBranch') && !refMenu.entry.isHead ? action(
              'interactive-rebase', 'rebase', t('workbench.history.rebaseHere'),
              () => openHistoryTool('rebase', refMenu.entry.fullName),
              { disabled: rebaseBlocked, title: rebaseBlocked ? t('workbench.history.rebaseBlocked') : undefined },
            ) : null}
            {separator('navigate')}
            {action('worktree', 'worktrees', t('workbench.refMenu.createWorktreeHere'), () => {
              const reference = refMenu.entry.name
              setRefMenu(null)
              setWorktreeTarget(reference)
            })}
            {action('branch-here', 'branch', t('workbench.menu.createBranchHere'), () =>
              startBranchCreate(refMenu.entry.targetOid),
            )}
            {action('cherry-pick', 'commit', t('workbench.menu.cherryPickCommit'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void runAction(t('workbench.notice.cherryPickDone'), () =>
                historyCherryPick(repoId, [sha]),
              )
            })}
            {currentBranch
              ? expander(
                  'ref-reset',
                  'recovery',
                  t('workbench.menu.resetCurrent', { branch: currentBranch }),
                  refMenu.panel === 'reset',
                  () =>
                    setRefMenu((current) =>
                      current
                        ? { ...current, panel: current.panel === 'reset' ? null : 'reset' }
                        : current,
                    ),
                )
              : null}
            {refMenu.panel === 'reset' && currentBranch ? (
              <>
                {action(
                  'ref-reset-soft',
                  'recovery',
                  t('workbench.menu.resetSoft'),
                  () => resetCurrentTo(refMenu.entry.targetOid, 'soft'),
                )}
                {action(
                  'ref-reset-mixed',
                  'recovery',
                  t('workbench.menu.resetMixed'),
                  () => resetCurrentTo(refMenu.entry.targetOid, 'mixed'),
                )}
              </>
            ) : null}
            {action('revert', 'patches', t('workbench.menu.revertCommit'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void runAction(t('workbench.notice.revertDone'), () => historyRevert(repoId, [sha]))
            })}
            {separator('branch')}
            {refMenu.entry.kind === 'branch'
              ? refMenu.renaming
                ? (
                    <div className={shared.row} key="rename-branch">
                      <input
                        autoFocus
                        value={refMenu.name}
                        onChange={(event) =>
                          setRefMenu((current) =>
                            current ? { ...current, name: event.target.value } : current,
                          )
                        }
                        aria-label={t('workbench.refMenu.renameBranchAria')}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className={shared.primary}
                        disabled={
                          !refMenu.name.trim() ||
                          refMenu.name.trim() === refMenu.entry.name
                        }
                        onClick={() => {
                          const next = refMenu.name.trim()
                          const old = refMenu.entry.name
                          setRefMenu(null)
                          void runAction(t('workbench.notice.branchRenamed', { old, new: next }), () =>
                            branchRename({ repoId, old, new: next }),
                          )
                        }}
                      >
                        {t('workbench.refMenu.renameConfirm')}
                      </button>
                    </div>
                  )
                : action('rename', 'patches', t('workbench.refMenu.rename'), () =>
                    setRefMenu((current) =>
                      current ? { ...current, renaming: true } : current,
                    ),
                  )
              : null}
            {refMenu.entry.kind === 'branch' && !refMenu.entry.isHead
              ? action('delete', 'status', t('workbench.refMenu.deleteLocal'), () => {
                  const entry = refMenu.entry
                  setRefMenu(null)
                  setPendingDelete(entry)
                })
              : null}
            {refMenu.entry.kind === 'remoteBranch'
              ? action('delete-remote', 'status', t('workbench.refMenu.deleteRemote'), () => {
                  const entry = refMenu.entry
                  setRefMenu(null)
                  setPendingRemoteDelete(entry)
                })
              : null}
            {refMenu.entry.kind === 'branch' &&
            !refMenu.entry.isHead &&
            upstreamTarget(refMenu.entry)
              ? action(
                  'delete-upstream',
                  'status',
                  t('workbench.refMenu.deleteUpstream'),
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    setPendingRemoteDelete(entry)
                  },
                )
              : null}
            {refMenu.entry.kind === 'branch' &&
            !refMenu.entry.isHead &&
            upstreamTarget(refMenu.entry)
              ? action(
                  'delete-both',
                  'status',
                  t('workbench.refMenu.deleteBoth'),
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    setPendingDeleteBoth(entry)
                  },
                )
              : null}
            {separator('copy')}
            {action('copy-branch-name', 'branch', t('workbench.refMenu.copyBranchName'), () => {
              const entry = refMenu.entry
              const name =
                entry.kind === 'remoteBranch'
                  ? remoteBranchName(entry) ?? entry.name
                  : entry.name
              setRefMenu(null)
              void copyText(name, t('workbench.notice.branchNameCopied', { name }))
            })}
            {action('copy-sha', 'patches', t('workbench.menu.copySha'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void copyText(sha, t('workbench.notice.shaCopied', { sha }))
            })}
            {action(
              'copy-branch-link',
              'remotes',
              t('workbench.refMenu.copyBranchLink'),
              () => {
                const entry = refMenu.entry
                const name =
                  entry.kind === 'remoteBranch'
                    ? remoteBranchName(entry) ?? entry.name
                    : entry.name
                const remote =
                  entry.kind === 'remoteBranch' ? entry.remote : pushTarget(entry).remote
                setRefMenu(null)
                copyLink('branch', name, remote)
              },
              {
                disabled: !linkWebUrl && !refs?.remoteUrls?.length,
                title: t('workbench.menu.recognizedRemoteTitle'),
              },
            )}
            {action(
              'copy-commit-link',
              'remotes',
              t('workbench.menu.copyCommitLink'),
              () => {
                const entry = refMenu.entry
                setRefMenu(null)
                copyLink('commit', entry.targetOid, entry.remote ?? null)
              },
              {
                disabled: !linkWebUrl && !refs?.remoteUrls?.length,
                title: t('workbench.menu.recognizedRemoteTitle'),
              },
            )}
            {separator('patch')}
            {action('patch-save', 'patches', t('workbench.menu.createPatch'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void exportPatch(sha, true)
            })}
            {action('patch-copy', 'patches', t('workbench.menu.copyPatch'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void exportPatch(sha, false)
            })}
            {separator('view')}
            {refMenu.entry.kind !== 'tag'
              ? action(
                  'pin',
                  'graph',
                  pins[repoId ?? ''] === refMenu.entry.fullName
                    ? t('workbench.refMenu.unpin')
                    : t('workbench.refMenu.pin'),
                  () => togglePin(refMenu.entry),
                )
              : null}
            {refMenu.entry.kind !== 'tag' ? (
              <>
                {expander(
                  'solo',
                  'search',
                  t('workbench.refMenu.solo'),
                  refMenu.panel === 'solo',
                  () =>
                    setRefMenu((current) =>
                      current
                        ? { ...current, panel: current.panel === 'solo' ? null : 'solo' }
                        : current,
                    ),
                )}
                {refMenu.panel === 'solo' ? (
                  <>
                    {action('solo-branch', 'search', t('workbench.refMenu.soloBranch', { branch: refMenu.entry.name }), () =>
                      soloOn(refMenu.entry),
                    )}
                    {action('solo-all', 'search', t('workbench.refMenu.showAll'), () => {
                      setAllRefs(true)
                      setRevision('')
                      setRefMenu(null)
                      persistVisibility({ hidden: [], filter: { allRefs: true, revision: '' } })
                      setActionNotice(t('workbench.notice.filterRemoved'))
                    })}
                  </>
                ) : null}
              </>
            ) : null}
            {refMenu.entry.kind === 'tag' ? <>
              {action('tag-push', 'sync', t('workbench.repository.pushTag'), () => {
                const name = refMenu.entry.name
                setRefMenu(null)
                void runAction(t('workbench.repository.pushTag'), () => tagPush({ repoId, remote: refs?.remotes[0] ?? 'origin', name, confirmation: { acknowledged: true } }))
              })}
              {action('tag-delete', 'diff', t('workbench.repository.deleteTag'), () => {
                setPendingTagDelete(refMenu.entry); setRefMenu(null)
              })}
            </> : null}
            {separator('tags')}
            {action('tag', 'tags', t('workbench.menu.createTagHere'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              setTagTarget({ sha, annotated: false })
            })}
            {action('tag-annotated', 'tags', t('workbench.menu.createAnnotatedTagHere'), () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              setTagTarget({ sha, annotated: true })
            })}
            {refMenu.entry.kind === 'branch'
              ? action('mr', 'mrs', t('workbench.menu.openMergeRequest'), () => {
                  const name = refMenu.entry.name
                  setRefMenu(null)
                  if (!linkWebUrl) {
                    setActionError(t('workbench.error.mergeRequestUnavailable'))
                    return
                  }
                  const url =
                    linkProvider === 'github'
                      ? `${linkWebUrl}/compare/${encodeURIComponent(name)}?expand=1`
                      : `${linkWebUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(name)}`
                  void openExternalUrl(url)
                })
              : null}
            {action('compare', 'diff', t('workbench.refMenu.compareHead'), () => {
              const name = refMenu.entry.name
              setRefMenu(null)
              startComparison(name, 'HEAD')
            })}
          </div>
        </ContextMenu>
      ) : null}

      <ConfirmDialog
        open={pendingStashDrop !== null}
        title={t('workbench.stashDrop.title', { selector: pendingStashDrop?.selector ?? '' })}
        consequence={t('workbench.stashDrop.consequence', {
          selector: pendingStashDrop?.selector ?? '',
          sha: pendingStashDrop?.sha.slice(0, 12) ?? '',
        })}
        irreversible
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingStashDrop(null)}
        onConfirm={() => {
          const target = pendingStashDrop
          setPendingStashDrop(null)
          if (!repoId || !target) return
          void runAction(
            t('workbench.notice.stashDropped', {
              selector: target.selector,
              sha: target.sha.slice(0, 12),
            }),
            () => stashDrop(repoId, target.selector, { acknowledged: true }),
          )
        }}
      />
      <ConfirmDialog open={pendingTagDelete !== null}
        title={t('workbench.repository.deleteTag')}
        consequence={pendingTagDelete?.name ?? ''} typed={pendingTagDelete?.name} irreversible
        confirmLabel={t('common.delete')} onCancel={() => setPendingTagDelete(null)}
        onConfirm={(typed) => {
          const entry = pendingTagDelete; setPendingTagDelete(null)
          if (entry) void runAction(t('workbench.repository.deleteTag'), () => tagDelete({ repoId, name: entry.name, confirmation: { acknowledged: true, typed } }))
        }} />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('workbench.deleteLocal.title', { name: pendingDelete?.name ?? '' })}
        consequence={t('workbench.deleteLocal.consequence')}
        typed={pendingDelete?.name}
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(typed) => {
          const entry = pendingDelete
          setPendingDelete(null)
          if (repoId && entry) {
            void runAction(t('workbench.notice.branchDeleted', { name: entry.name }), () =>
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
        title={t('workbench.deleteRemote.title', { label: remoteDeleteLabel })}
        consequence={t('workbench.deleteRemote.consequence')}
        typed={remoteDeleteTarget?.branch}
        irreversible
        confirmLabel={t('workbench.deleteRemote.confirm')}
        onCancel={() => setPendingRemoteDelete(null)}
        onConfirm={(typed) => {
          const target = remoteDeleteTarget
          setPendingRemoteDelete(null)
          if (repoId && target) {
            const { remote, branch } = target
            void runAction(t('workbench.notice.remoteBranchDeleted', { remote, branch }), () =>
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
        open={pendingDeleteBoth !== null}
        title={t('workbench.deleteBoth.title', { name: pendingDeleteBoth?.name ?? '' })}
        consequence={t('workbench.deleteBoth.consequence')}
        typed={pendingDeleteBoth?.name}
        irreversible
        confirmLabel={t('workbench.deleteBoth.confirm')}
        onCancel={() => setPendingDeleteBoth(null)}
        onConfirm={(typed) => {
          const entry = pendingDeleteBoth
          setPendingDeleteBoth(null)
          const target = entry ? upstreamTarget(entry) : null
          if (!repoId || !entry || !target) return
          void runAction(
            t('workbench.notice.bothDeleted', {
              name: entry.name,
              remote: target.remote,
              branch: target.branch,
            }),
            async () => {
              await branchDelete({
                repoId,
                name: entry.name,
                confirmation: { acknowledged: true, typed },
              })
              await branchDeleteRemote({
                repoId,
                remote: target.remote,
                branch: target.branch,
                confirmation: { acknowledged: true, typed },
              })
            },
          )
        }}
      />
    </div>
  )
}
