import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { ViewId } from '../data/navigation'
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
  syncPull,
  syncPush,
  type DiffRequest,
} from '../ipc/commands'
import { save as saveNativeDialog } from '@tauri-apps/plugin-dialog'
import { errorMessage } from '../ipc/client'
import { isCheckoutableRef, resolveGraphRef, shortRevision } from '../lib/graphRefs'
import { projectWebUrl, refWebUrl } from '../lib/refLinks'
import {
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
  RefEntry,
  RefsSnapshot,
  RepoView,
} from '../types/git'
import { ActionMenu } from './ActionMenu'
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
import { GraphCanvas } from './GraphCanvas'
import { RecoveryPanel } from './RecoveryPanel'
import { RepoStatus } from './RepoStatus'
import { SearchPanel } from './SearchPanel'
import { StashPanel } from './StashPanel'
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
  diffRequest: DiffRequest | null
  onOpenDiff: (request: DiffRequest) => void
  onOpenRepo: (path: string) => void
  onMutated: () => void
  onUndo: () => Promise<unknown>
  onNavigate: (view: ViewId) => void
  gitlabConnected: boolean
  githubConnected: boolean
  theme: 'dark' | 'light' | 'system'
  onThemeChange: (theme: 'dark' | 'light' | 'system') => void
  density: 'compact' | 'comfortable'
  onDensityChange: (density: 'compact' | 'comfortable') => void
  shortcuts: import('../lib/shortcuts').ShortcutMap
  onShortcutsChange: (next: import('../lib/shortcuts').ShortcutMap) => void
  layout: LayoutPreferences
  onLayoutChange: (patch: Partial<LayoutPreferences>) => void
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
  noFf: boolean
  preview: BranchIntegrationPreview
}

function integrationConsequence(pending: PendingIntegration | null) {
  if (!pending) return ''
  const { source, target, mode, noFf, preview } = pending
  const parts = [
    `${preview.ahead} commit(s) de ${source.name} à intégrer`,
    `${preview.behind} commit(s) de retard`,
  ]
  if (preview.fastForward) {
    parts.push(
      noFf
        ? 'commit de fusion créé au lieu d’un fast-forward'
        : 'fast-forward, aucun commit de fusion',
    )
  } else if (mode === 'merge') {
    parts.push('commit de fusion créé')
  }
  if (preview.requiresCheckout) parts.push(`${target.name} sera extraite pendant l'opération`)
  if (preview.stashRequired) {
    parts.push('modifications locales stashées puis restaurées après la fusion')
  } else if (preview.worktreeDirty) {
    parts.push('fichiers non suivis laissés en place')
  }
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
  onOpenDiff,
  onOpenRepo,
  onMutated,
  onUndo,
  onNavigate,
  gitlabConnected,
  githubConnected,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  shortcuts,
  onShortcutsChange,
  layout,
  onLayoutChange,
}: Props) {
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
  const showWorktree = worktreeSelected && hasChanges
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
   * The patch that replaces the history region: a local file, or the compared
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
    view === 'graph' || view === 'status' || view === 'commit'
      ? previewDiff
      : diffRequest
  const [branchTarget, setBranchTarget] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [refMenu, setRefMenu] = useState<RefMenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RefEntry | null>(null)
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

  const previousWorktreeRequest = useRef(worktreeRequest)
  useEffect(() => {
    if (previousWorktreeRequest.current === worktreeRequest) return
    previousWorktreeRequest.current = worktreeRequest
    setSelected(undefined)
    setComparison(null)
    setComparePath(null)
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
    if (!repoId || view !== 'graph') {
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
    setActionNotice(`Commit ${sha.slice(0, 10)} amendé.`)
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
    void runAction(`Branche ${entry.name} poussée vers ${remote}.`, () =>
      syncPush({ repoId, remote, branch: entry.name }),
    )
  }

  const applyUpstream = (branch: RefEntry, upstream: string) => {
    if (!repoId) return
    setRefMenu(null)
    void runAction(`Upstream de ${branch.name} : ${upstream}.`, () =>
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
    noFf = false,
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
        setActionError(preview.blockedReason ?? 'Intégration impossible pour ces branches.')
        return
      }
      setPendingIntegration({ source, target, mode, noFf, preview })
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
        noFf: pending.noFf,
        confirmation: { acknowledged: true },
      })
      setPendingIntegration(null)
      const stash = result.data.autoStash
      const stashNote = stash
        ? stash.popped
          ? ' Modifications locales restaurées.'
          : stash.conflicts.length > 0
            ? ` Le stash ${stash.selector} n'a pas pu être réappliqué (conflits) et il est conservé.`
            : ` Modifications locales conservées dans ${stash.selector} (${stash.sha.slice(0, 8)}).`
        : ''
      setActionNotice(
        (result.data.outcome.conflicted
          ? `Conflit pendant ${pending.mode === 'merge' ? 'la fusion' : 'le rebase'} : résolvez les fichiers puis poursuivez.`
          : `${pending.mode === 'merge' ? 'Fusion' : 'Rebase'} de ${pending.source.name} appliqué${pending.mode === 'merge' && pending.noFf ? ' (commit de fusion)' : ''}.`) +
          stashNote,
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
          connected={gitlabConnected}
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

  if (view === 'github') {
    return (
      <div className={styles.content}>
        <GithubPanel repoId={repoId} generation={generation} onLinked={onMutated} />
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

  if (view === 'mrs' || view === 'prs') {
    const api = view === 'prs' ? githubForge : gitlabForge
    return (
      <div className={shared.root}>
        <ReviewRequestsPanel
          api={api}
          repoId={repoId}
          generation={generation}
          connected={view === 'prs' ? githubConnected : gitlabConnected}
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
    const diffSha = diffRequest?.target === 'commit' ? diffRequest.base : undefined
    const source = !diffRequest
      ? 'Aucune sélection'
      : diffRequest.target === 'commit'
        ? `Commit ${diffRequest.base?.slice(0, 8) ?? ''}`
        : diffRequest.target === 'range'
          ? `${shortRevision(diffRequest.base ?? 'HEAD')}…${shortRevision(diffRequest.targetRef ?? 'HEAD')}`
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
        {amendDialog}
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
          {revision && !branches.some((entry) => entry.name === revision) ? (
            <option value={revision}>{revision}</option>
          ) : null}
          {branches.map((entry) => (
            <option key={entry.fullName} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
    <ActionMenu label="Options d’affichage du graphe">
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
        {layout.graph ? (
          <button type="button" onClick={() => onLayoutChange({ graph: null })}>
            Réinitialiser les colonnes
          </button>
        ) : null}
    </ActionMenu>
  </div>

  const worktreeRow = hasChanges ? (
    <button type="button" className={styles.worktreeRow} data-active={showWorktree} aria-pressed={showWorktree}
            onClick={() => { setSelected(undefined); setComparison(null); setComparePath(null); setLocalDiff(null); setWorktreeSelected((current) => !current) }}>
            <span className={styles.wipRef}>En cours</span>
            <span className={styles.wipMarker} aria-hidden="true">◌</span>
            <span className={styles.wipMessage}><strong>Modifications locales</strong><span>{repo.state.worktree.staged} préparé(s) · {repo.state.worktree.unstaged} modifié(s) · {repo.state.worktree.untracked} nouveau(x)</span></span>
          </button>
  ) : null

  const openContextMenu = (commit: CommitSummary, x: number, y: number) => {
    setContextMenu({ commit, x, y, panel: null })
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
      setActionError('Presse-papiers indisponible : autorisez l’accès et réessayez.')
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
      setActionError('Aucun remote reconnu : ajoutez un remote ou associez un projet GitLab.')
      return
    }
    void copyText(url, `Lien copié : ${url}`)
  }

  /**
   * GitKraken's Cloud Patch has no server here: the patch is generated locally
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
        await copyText(patch.text, 'Patch du commit copié pour partage.')
        return
      }
      const path = await saveNativeDialog({
        defaultPath: `${repo.repo.name}-${sha.slice(0, 10)}.patch`,
      })
      if (!path) return
      await patchSave(path, patch.text)
      setActionNotice(`Patch enregistré : ${path}`)
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
      `${currentBranch} réinitialisée (${mode === 'soft' ? 'douce' : 'mixte'}) sur ${sha.slice(0, 10)}.`,
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
        ? `${entry.name} désépinglée.`
        : `${entry.name} épinglée à gauche du graphe.`,
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
    setActionNotice(`Graphe isolé sur ${entry.name}.`)
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
            <span className={shared.notice}>{picked.length} commit(s) sélectionné(s)</span>
            {picked.length === 1 ? (
              <span className={shared.small}>
                Maj+clic sur un autre commit pour sélectionner la plage,
                ⌘/Ctrl+clic pour ne comparer que les deux extrémités.
              </span>
            ) : null}
            {canCompare ? (
              <button
                type="button"
                className={shared.secondary}
                aria-pressed={comparison !== null}
                title={`Comparer ${shortRevision(compareBase!)} et ${shortRevision(compareTarget!)} : ${picked.length} commit(s) de A vers B, affichés à droite du graphe`}
                onClick={() => startComparison(compareBase!, compareTarget!, graphOrder(picked))}
              >
                Comparer {shortRevision(compareBase!)} → {shortRevision(compareTarget!)}
              </button>
            ) : null}
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

      {graph.error ? (
        <div className={styles.error} role="alert">
          {graph.error}
        </div>
      ) : null}
      <div className={styles.graphLayout} style={{ '--inspector-width': `${layout.inspector}px` } as CSSProperties}>
        <div className={styles.historyMain}>
          {localDiff ? worktreeRow : null}
          <div className={styles.graphRegion} hidden={Boolean(previewDiff)}>
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
            columnWidths={layout.graph}
            onColumnWidthsChange={(graph) => onLayoutChange({ graph })}
            commits={graph.commits}
            rows={graph.rows}
            selected={selected}
            mrBadges={badges}
            refEntries={refs?.entries ?? []}
            pin={graphPin}
            checkoutDisabled={checkoutBusy}
            onCheckoutRef={(raw) => void checkoutGraphRef(raw)}
            picked={picked}
            onSelect={(sha, modifiers) => {
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
          {previewDiff ? <>
        <div className={styles.diffPreview} aria-label="Aperçu des modifications" aria-busy={diffLoading}>
          <div className={styles.previewHeading}>
            <span>{previewDiff.target === 'index'
              ? 'Prêt à committer'
              : previewDiff.target === 'range'
                ? `Comparaison ${shortRevision(previewDiff.base ?? 'HEAD')} → ${shortRevision(previewDiff.targetRef ?? 'HEAD')}`
                : 'Modification locale'}</span>
            <code title={previewDiff.path}>{previewDiff.path}</code>
            <button
              type="button"
              onClick={() => { setLocalDiff(null); setComparePath(null) }}
              aria-label="Fermer l’aperçu"
            >
              ×
            </button>
          </div>
          {diffError ? <div className={styles.error} role="alert">{diffError}</div> : null}
          {diffLoading ? <div className={styles.placeholder} role="status">Chargement des modifications…</div> : report ?
            <DiffViewer embedded report={report} source="" readDocument={readPreviewDocument} staging={localDiff && localDiff.allowActions && !localDiff.untracked && (localDiff.target === 'worktree' || localDiff.target === 'index') ? { repoId, target: localDiff.target, onMutated } : undefined} /> :
            <div className={styles.placeholder}><h2>Chaque changement compte.</h2><p>Sélectionnez un fichier pour voir ses modifications.<br />Préparez les fichiers avec +, puis créez votre commit.</p></div>}
        </div>
          </> : null}
        </div>
        {comparison || selected || showWorktree ? (
          <div className={styles.inspectorDock}>
            <Resizer
              className={styles.inspectorResizer}
              label="Redimensionner le panneau latéral"
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
            /> : showWorktree ? <aside className={styles.worktreePanel} aria-label="Préparation du prochain commit">
              <div className={styles.worktreeHeading}><strong>Fichiers</strong><span>{repo.state.head?.kind === 'branch' ? repo.state.head.name : 'HEAD'}</span><button type="button" aria-label="Fermer la préparation du commit" onClick={() => { setWorktreeSelected(false); setLocalDiff(null) }}>×</button></div>
              <RepoStatus repoId={repoId} generation={generation} locks={repo.locks}
                selectedPath={localDiff?.path} onSelectDiff={setLocalDiff} onMutated={onMutated} onNavigate={onNavigate} />
              <CommitPanel compact repoId={repoId} generation={generation} onMutated={onMutated} onUndo={onUndo} />
            </aside> : null}
          </div>
        ) : null}
      </div>

      {contextMenu ? (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} title={contextMenu.commit.sha.slice(0, 10)} subtitle={contextMenu.commit.subject} onClose={closeMenu}>
          <div className={styles.contextActions}>
            {expander('checkout', 'branch', 'Checkout', contextMenu.panel === 'checkout', () =>
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
                    `Basculer sur ${entry.name}`,
                    () => {
                      closeMenu()
                      void checkoutGraphRef(entry.fullName)
                    },
                    {
                      disabled: entry.isHead || checkoutBusy,
                      title:
                        entry.kind === 'remoteBranch'
                          ? 'Crée une branche locale qui suit la branche distante'
                          : undefined,
                    },
                  ),
                )}
                {action('checkout-detached', 'graph', 'HEAD détachée sur ce commit', () => {
                  const sha = contextMenu.commit.sha
                  closeMenu()
                  void runAction('Checkout détaché.', () =>
                    branchCheckout({ repoId, detachedAt: sha }),
                  )
                })}
              </>
            ) : null}
            {action('worktree', 'worktrees', 'Créer un worktree ici…', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setWorktreeTarget(sha)
            })}
            {action('branch-here', 'branch', 'Créer une branche ici…', () =>
              startBranchCreate(contextMenu.commit.sha),
            )}
            {separator('history')}
            {action('cherry-pick', 'commit', 'Cherry-picker ce commit', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void runAction('Cherry-pick terminé.', () =>
                historyCherryPick(repoId, [sha]),
              )
            })}
            {currentBranch
              ? expander(
                  'reset',
                  'recovery',
                  `Réinitialiser ${currentBranch} sur ce commit`,
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
                  'Douce — garde l’index et les fichiers',
                  () => resetCurrentTo(contextMenu.commit.sha, 'soft'),
                )}
                {action(
                  'reset-mixed',
                  'recovery',
                  'Mixte — vide l’index, garde les fichiers',
                  () => resetCurrentTo(contextMenu.commit.sha, 'mixed'),
                )}
                <p className={styles.contextHint}>
                  Recul de {currentBranch} seulement : aucun fichier n’est perdu.
                </p>
              </>
            ) : null}
            {action('revert', 'patches', 'Revenir sur ce commit (revert)', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void runAction('Revert terminé.', () => historyRevert(repoId, [sha]))
            })}
            {canAmend(contextMenu.commit.sha)
              ? action(
                  'amend',
                  'commit',
                  'Amender ce commit…',
                  () => {
                    const { sha, subject } = contextMenu.commit
                    closeMenu()
                    setAmendTarget({ sha, subject })
                  },
                  { title: 'Amender HEAD réécrit l’historique' },
                )
              : null}
            {action('compare', 'diff', 'Comparer à la branche courante', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              startComparison(sha, 'HEAD')
            })}
            {separator('copy')}
            {action('copy-sha', 'patches', 'Copier le SHA', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void copyText(sha, `SHA copié : ${sha}`)
            })}
            {action(
              'copy-link',
              'remotes',
              'Copier le lien du commit',
              () => {
                const sha = contextMenu.commit.sha
                closeMenu()
                copyLink('commit', sha)
              },
              {
                disabled: !linkWebUrl && !refs?.remoteUrls?.length,
                title: 'Nécessite un remote reconnu ou un projet GitLab associé',
              },
            )}
            {separator('patch')}
            {action('patch-save', 'patches', 'Créer un patch depuis ce commit…', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void exportPatch(sha, true)
            })}
            {action('patch-copy', 'patches', 'Copier le patch pour partage', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              void exportPatch(sha, false)
            })}
            {separator('tags')}
            {action('tag', 'tags', 'Créer un tag ici…', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setTagTarget({ sha, annotated: false })
            })}
            {action('tag-annotated', 'tags', 'Créer un tag annoté ici…', () => {
              const sha = contextMenu.commit.sha
              closeMenu()
              setTagTarget({ sha, annotated: true })
            })}
            {separator('mr')}
            {action('mr', 'mrs', 'Ouvrir une merge request', () => {
              const atCommit = branchesAtCommit(contextMenu.commit.sha)[0]?.name
              const branch = atCommit ?? currentBranch
              closeMenu()
              if (!linkWebUrl || !branch) {
                setActionError('Associez le dépôt à un projet GitLab et poussez la branche.')
                return
              }
              const url =
                linkProvider === 'github'
                  ? `${linkWebUrl}/compare/${encodeURIComponent(branch)}?expand=1`
                  : `${linkWebUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
              void openExternalUrl(url)
            })}
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
                title={`Avancer ${dropMenu.target.name} sur ${dropMenu.source.name} sans commit de fusion`}
                onClick={() => void requestIntegration('merge')}
              >
                <ViewIcon view="sync" /><span>Avancer {dropMenu.target.name} sur {dropMenu.source.name}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.contextAction}
              role="menuitem"
              title={`Fusionner ${dropMenu.source.name} dans ${dropMenu.target.name} avec un commit de fusion`}
              onClick={() => void requestIntegration('merge', true)}
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
                startComparison(source.name, target.name)
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

      {amendDialog}

      {tagTarget ? (
        <TagDialog
          repoId={repoId}
          target={tagTarget.sha}
          annotated={tagTarget.annotated}
          onClose={() => setTagTarget(null)}
          onCreated={(name) => {
            setTagTarget(null)
            setActionNotice(`Tag ${name} créé.`)
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
            setActionNotice(`Worktree créé : ${path}`)
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
              ? 'branche distante'
              : refMenu.entry.kind === 'tag'
                ? 'tag'
                : 'branche locale'
          }
          onClose={() => setRefMenu(null)}
        >
          <div className={styles.contextActions}>
            {refMenu.entry.kind !== 'tag'
              ? action(
                  'checkout',
                  'branch',
                  `Basculer sur ${refMenu.entry.name}`,
                  () => {
                    const raw = refMenu.entry.fullName
                    setRefMenu(null)
                    void checkoutGraphRef(raw)
                  },
                  {
                    disabled: refMenu.entry.isHead || checkoutBusy,
                    title: refMenu.entry.isHead ? 'Branche déjà extraite' : undefined,
                  },
                )
              : null}
            {refMenu.entry.kind === 'branch' ? (
              <>
                {refMenu.entry.isHead
                  ? action('pull', 'sync', 'Pull (fast-forward seulement)', () => {
                      const entry = refMenu.entry
                      setRefMenu(null)
                      void runAction(`Pull (fast-forward) de ${entry.name}.`, () =>
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
                  `Pousser vers ${pushTarget(refMenu.entry).target}`,
                  () => pushBranch(refMenu.entry),
                )}
                {expander(
                  'upstream',
                  'remotes',
                  refMenu.entry.upstream
                    ? `Upstream : ${refMenu.entry.upstream}`
                    : "Définir l'upstream…",
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
                          'Aucune branche distante : lancez un fetch.',
                          () => undefined,
                          { disabled: true },
                        )
                      }
                      return remotes.map((remoteBranch) =>
                        action(
                          `upstream-${remoteBranch.fullName}`,
                          'remotes',
                          `${remoteBranch.name}${remoteBranch.name === refMenu.entry.upstream ? ' · actuel' : ''}`,
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
                  `Avancer ${refMenu.entry.name} sur ${currentBranchEntry.name}`,
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('merge', false, {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                  { title: 'Fast-forward, sans commit de fusion' },
                )}
                {action(
                  'merge',
                  'mrs',
                  `Fusionner ${currentBranchEntry.name} dans ${refMenu.entry.name}`,
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('merge', true, {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                  { title: 'Commit de fusion créé' },
                )}
                {action(
                  'rebase',
                  'rebase',
                  `Rebaser ${currentBranchEntry.name} sur ${refMenu.entry.name}`,
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    void requestIntegration('rebase', false, {
                      source: currentBranchEntry,
                      target: entry,
                    })
                  },
                )}
              </>
            ) : null}
            {separator('navigate')}
            {action('worktree', 'worktrees', 'Créer un worktree à partir d’ici…', () => {
              const reference = refMenu.entry.name
              setRefMenu(null)
              setWorktreeTarget(reference)
            })}
            {action('branch-here', 'branch', 'Créer une branche ici…', () =>
              startBranchCreate(refMenu.entry.targetOid),
            )}
            {action('cherry-pick', 'commit', 'Cherry-picker ce commit', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void runAction('Cherry-pick terminé.', () =>
                historyCherryPick(repoId, [sha]),
              )
            })}
            {currentBranch
              ? expander(
                  'ref-reset',
                  'recovery',
                  `Réinitialiser ${currentBranch} sur ce commit`,
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
                  'Douce — garde l’index et les fichiers',
                  () => resetCurrentTo(refMenu.entry.targetOid, 'soft'),
                )}
                {action(
                  'ref-reset-mixed',
                  'recovery',
                  'Mixte — vide l’index, garde les fichiers',
                  () => resetCurrentTo(refMenu.entry.targetOid, 'mixed'),
                )}
              </>
            ) : null}
            {action('revert', 'patches', 'Revenir sur ce commit (revert)', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void runAction('Revert terminé.', () => historyRevert(repoId, [sha]))
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
                        aria-label="Nouveau nom de branche"
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
                          void runAction(`Branche ${old} renommée en ${next}.`, () =>
                            branchRename({ repoId, old, new: next }),
                          )
                        }}
                      >
                        Renommer
                      </button>
                    </div>
                  )
                : action('rename', 'patches', 'Renommer…', () =>
                    setRefMenu((current) =>
                      current ? { ...current, renaming: true } : current,
                    ),
                  )
              : null}
            {refMenu.entry.kind === 'branch' && !refMenu.entry.isHead
              ? action('delete', 'status', 'Supprimer la branche locale…', () => {
                  const entry = refMenu.entry
                  setRefMenu(null)
                  setPendingDelete(entry)
                })
              : null}
            {refMenu.entry.kind === 'remoteBranch'
              ? action('delete-remote', 'status', 'Supprimer la branche distante…', () => {
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
                  'Supprimer la branche distante suivie…',
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
                  'Supprimer la branche locale et sa distante…',
                  () => {
                    const entry = refMenu.entry
                    setRefMenu(null)
                    setPendingDeleteBoth(entry)
                  },
                )
              : null}
            {separator('copy')}
            {action('copy-branch-name', 'branch', 'Copier le nom de la branche', () => {
              const entry = refMenu.entry
              const name =
                entry.kind === 'remoteBranch'
                  ? remoteBranchName(entry) ?? entry.name
                  : entry.name
              setRefMenu(null)
              void copyText(name, `Nom copié : ${name}`)
            })}
            {action('copy-sha', 'patches', 'Copier le SHA', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void copyText(sha, `SHA copié : ${sha}`)
            })}
            {action(
              'copy-branch-link',
              'remotes',
              'Copier le lien de la branche',
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
                title: 'Nécessite un remote reconnu ou un projet GitLab associé',
              },
            )}
            {action(
              'copy-commit-link',
              'remotes',
              'Copier le lien du commit',
              () => {
                const entry = refMenu.entry
                setRefMenu(null)
                copyLink('commit', entry.targetOid, entry.remote ?? null)
              },
              {
                disabled: !linkWebUrl && !refs?.remoteUrls?.length,
                title: 'Nécessite un remote reconnu ou un projet GitLab associé',
              },
            )}
            {separator('patch')}
            {action('patch-save', 'patches', 'Créer un patch depuis ce commit…', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              void exportPatch(sha, true)
            })}
            {action('patch-copy', 'patches', 'Copier le patch pour partage', () => {
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
                    ? 'Désépingler du bord gauche'
                    : 'Épingler à gauche du graphe',
                  () => togglePin(refMenu.entry),
                )
              : null}
            {refMenu.entry.kind !== 'tag' ? (
              <>
                {expander(
                  'solo',
                  'search',
                  'Solo',
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
                    {action('solo-branch', 'search', `Isoler ${refMenu.entry.name}`, () =>
                      soloOn(refMenu.entry),
                    )}
                    {action('solo-all', 'search', 'Tout afficher', () => {
                      setAllRefs(true)
                      setRevision('')
                      setRefMenu(null)
                      setActionNotice('Filtre du graphe retiré.')
                    })}
                  </>
                ) : null}
              </>
            ) : null}
            {separator('tags')}
            {action('tag', 'tags', 'Créer un tag ici…', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              setTagTarget({ sha, annotated: false })
            })}
            {action('tag-annotated', 'tags', 'Créer un tag annoté ici…', () => {
              const sha = refMenu.entry.targetOid
              setRefMenu(null)
              setTagTarget({ sha, annotated: true })
            })}
            {refMenu.entry.kind === 'branch'
              ? action('mr', 'mrs', 'Ouvrir une merge request', () => {
                  const name = refMenu.entry.name
                  setRefMenu(null)
                  if (!linkWebUrl) {
                    setActionError('Associez le dépôt à un projet GitLab et poussez la branche.')
                    return
                  }
                  const url =
                    linkProvider === 'github'
                      ? `${linkWebUrl}/compare/${encodeURIComponent(name)}?expand=1`
                      : `${linkWebUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(name)}`
                  void openExternalUrl(url)
                })
              : null}
            {action('compare', 'diff', 'Comparer à HEAD', () => {
              const name = refMenu.entry.name
              setRefMenu(null)
              startComparison(name, 'HEAD')
            })}
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
        title={`Supprimer ${remoteDeleteLabel}`}
        consequence="La branche est supprimée sur le remote après un push de suppression. Les autres clones perdent la référence au prochain fetch."
        typed={remoteDeleteTarget?.branch}
        irreversible
        confirmLabel="Supprimer sur le remote"
        onCancel={() => setPendingRemoteDelete(null)}
        onConfirm={(typed) => {
          const target = remoteDeleteTarget
          setPendingRemoteDelete(null)
          if (repoId && target) {
            const { remote, branch } = target
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
        open={pendingDeleteBoth !== null}
        title={`Supprimer ${pendingDeleteBoth?.name ?? ''} et sa branche distante`}
        consequence="La branche locale et son upstream sont supprimés. Le push de suppression est irréversible pour les autres clones."
        typed={pendingDeleteBoth?.name}
        irreversible
        confirmLabel="Supprimer les deux"
        onCancel={() => setPendingDeleteBoth(null)}
        onConfirm={(typed) => {
          const entry = pendingDeleteBoth
          setPendingDeleteBoth(null)
          const target = entry ? upstreamTarget(entry) : null
          if (!repoId || !entry || !target) return
          void runAction(
            `Branche ${entry.name} et ${target.remote}/${target.branch} supprimées.`,
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