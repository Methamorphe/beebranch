import { listen } from '@tauri-apps/api/event'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { CloneRepoDialog } from './components/CloneRepoDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Home } from './components/Home'
import { InitRepoDialog } from './components/InitRepoDialog'
import { RepoBar } from './components/RepoBar'
import { Resizer } from './components/Resizer'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TopBar } from './components/TopBar'
import { UpdateNotice } from './components/UpdateNotice'
import { Workbench } from './components/Workbench'
import { navigationGroups, viewDescriptions, type ViewId } from './data/navigation'
import { errorMessage } from './ipc/client'
import {
  gitlabStatus,
  preferenceGet,
  preferenceSet,
  repoCloseChecked,
  repoClone,
  repoGetState,
  repoInit,
  repoListRecent,
  repoOpen,
  repoRefresh,
  redoApply,
  stashList,
  syncFetch,
  syncPull,
  syncPush,
  undoApply,
  undoStatus,
  updateCheck,
  updateInstall,
} from './ipc/commands'
import { useRepoEvents } from './hooks/useRepoEvents'
import { useShortcuts } from './hooks/useShortcuts'
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  defaultLayout,
  parseLayout,
  type LayoutPreferences,
} from './lib/layout'
import {
  DEFAULT_SHORTCUTS,
  findConflicts,
  normalizeShortcut,
  type ShortcutAction,
  type ShortcutMap,
} from './lib/shortcuts'
import type { ChangeEvent, RecentRepo, RepoView, UndoStatus } from './types/git'
import type { CloneInput, InitInput } from './ipc/commands'
import styles from './App.module.css'

const OPEN_REPOS_KEY = 'ui.openRepos'
const ACTIVE_REPO_KEY = 'ui.activeRepo'
const THEME_KEY = 'ui.theme'
const SHORTCUTS_KEY = 'ui.shortcuts'
const DENSITY_KEY = 'ui.density'
const LAYOUT_KEY = 'ui.layout'

type Theme = 'dark' | 'light' | 'system'
type Density = 'compact' | 'comfortable'

const VIEW_LABELS = Object.fromEntries(navigationGroups.flatMap((group) => group.items.map((item) => [item.id, item.label]))) as Record<ViewId, string>
VIEW_LABELS.commit = 'Modifications'
VIEW_LABELS.diff = 'Comparaison'

function applyTheme(theme: Theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

function applyDensity(density: Density) {
  document.documentElement.dataset.density = density
}

export default function App() {
  const [repos, setRepos] = useState<RepoView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('graph')
  // Latest version offered by the signed manifest, surfaced in the header.
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null)
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const installingUpdateRef = useRef(false)
  const [worktreeRequest, setWorktreeRequest] = useState(0)
  const [branchRequest, setBranchRequest] = useState(0)
  const [generation, setGeneration] = useState(0)
  const [diffRequest, setDiffRequest] = useState<Parameters<typeof Workbench>[0]['diffRequest']>(null)
  const [recent, setRecent] = useState<RecentRepo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<RepoView | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const [initDialogOpen, setInitDialogOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [previousView, setPreviousView] = useState<ViewId>('graph')
  const pickingRepository = useRef(false)
  const [connected, setConnected] = useState(false)
  const [gitlabUser, setGitlabUser] = useState<string | null>(null)
  const [stashCount, setStashCount] = useState(0)
  const [undoState, setUndoState] = useState<UndoStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')
  const [density, setDensity] = useState<Density>('comfortable')
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS)
  const [layout, setLayout] = useState<LayoutPreferences>(defaultLayout)
  const restored = useRef(false)

  const repo = repos.find((entry) => entry.repo.repoId === activeId) ?? null
  const repoId = repo?.repo.repoId ?? null
  const initParent = useMemo(() => {
    const path = recent[0]?.path
    if (!path) {
      return ''
    }
    const trimmed = path.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return index > 0 ? trimmed.slice(0, index) : ''
  }, [recent])

  const reloadRecent = useCallback(async () => {
    try {
      setRecent(await repoListRecent(10))
    } catch {
      setRecent([])
    }
  }, [])

  const persist = useCallback((next: RepoView[], active: string | null) => {
    void preferenceSet(
      OPEN_REPOS_KEY,
      JSON.stringify(next.map((entry) => entry.repo.worktree)),
    )
    void preferenceSet(ACTIVE_REPO_KEY, active ?? '')
  }, [])

  const upsert = useCallback((next: RepoView, activate = true) => {
    setRepos((current) => {
      const exists = current.some((entry) => entry.repo.repoId === next.repo.repoId)
      return exists
        ? current.map((entry) =>
            entry.repo.repoId === next.repo.repoId ? next : entry,
          )
        : [...current, next]
    })
    if (activate) {
      setActiveId(next.repo.repoId)
      setGeneration(next.generation)
    }
  }, [])

  useEffect(() => {
    if (hydrated) {
      persist(repos, activeId)
    }
  }, [hydrated, repos, activeId, persist])

  // Resizing fires continuously; persist once the drag settles.
  useEffect(() => {
    if (!hydrated) {
      return
    }
    const timer = window.setTimeout(() => {
      void preferenceSet(LAYOUT_KEY, JSON.stringify(layout))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [hydrated, layout])

  const changeLayout = useCallback((patch: Partial<LayoutPreferences>) => {
    setLayout((current) => ({ ...current, ...patch }))
  }, [])

  useEffect(() => {
    void reloadRecent()
  }, [reloadRecent])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    applyDensity(density)
  }, [density])

  useEffect(() => {
    if (restored.current) {
      return
    }
    restored.current = true
    void (async () => {
      try {
        const raw = await preferenceGet(OPEN_REPOS_KEY)
        let paths: string[] = []
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              paths = parsed.filter((value): value is string => typeof value === 'string')
            }
          } catch {
            setError('La liste des dépôts ouverts est illisible ; elle a été ignorée.')
          }
        }
        const activePath = await preferenceGet(ACTIVE_REPO_KEY)
        const themeRaw = await preferenceGet(THEME_KEY)
        if (themeRaw === 'light' || themeRaw === 'dark' || themeRaw === 'system') {
          setTheme(themeRaw)
        }
        const densityRaw = await preferenceGet(DENSITY_KEY)
        if (densityRaw === 'compact' || densityRaw === 'comfortable') {
          setDensity(densityRaw)
        }
        const layoutRaw = await preferenceGet(LAYOUT_KEY)
        if (layoutRaw) {
          setLayout(parseLayout(layoutRaw))
        }
        const shortcutsRaw = await preferenceGet(SHORTCUTS_KEY)
        if (shortcutsRaw) {
          try {
            const parsed: unknown = JSON.parse(shortcutsRaw)
            if (parsed && typeof parsed === 'object') {
              const merged = {
                ...DEFAULT_SHORTCUTS,
                ...(parsed as Partial<ShortcutMap>),
              }
              const normalized = {} as ShortcutMap
              for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
                normalized[action] =
                  normalizeShortcut(merged[action] ?? '') ?? DEFAULT_SHORTCUTS[action]
              }
              if (findConflicts(normalized).length === 0) {
                setShortcuts(normalized)
              }
            }
          } catch {
            // Keep the defaults when the stored shortcut map is corrupt.
          }
        }
        if (paths.length === 0) {
          return
        }
        setBusy(true)
        const opened: RepoView[] = []
        for (const path of paths) {
          try {
            opened.push(await repoOpen(path))
          } catch {
            // A repository may have moved; keep the others.
          }
        }
        if (opened.length > 0) {
          setRepos(opened)
          const active =
            opened.find((entry) => entry.repo.worktree === activePath) ?? opened[0]!
          setActiveId(active.repo.repoId)
          setGeneration(active.generation)
        }
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
        setHydrated(true)
      }
    })()
  }, [])

  const onRepoChanged = useCallback((event: ChangeEvent) => {
    setGeneration(event.generation)
    setRepos((current) =>
      current.map((entry) =>
        entry.repo.repoId === event.repoId
          ? { ...entry, generation: event.generation }
          : entry,
      ),
    )
    if (event.areas.some((area) => ['state', 'head'].includes(area))) {
      void repoGetState(event.repoId)
        .then((fresh) => {
          setRepos((current) =>
            current.map((entry) =>
              entry.repo.repoId === fresh.repo.repoId &&
              fresh.generation >= entry.generation
                ? fresh
                : entry,
            ),
          )
        })
        .catch(() => undefined)
    }
  }, [])

  useRepoEvents(activeId, onRepoChanged)

  // Installing from the header (or the notification) needs no detour through
  // the settings page: the signed package is verified, installed, and the app
  // relaunches on its own.
  const installUpdate = useCallback(async () => {
    if (installingUpdateRef.current) {
      return
    }
    installingUpdateRef.current = true
    setInstallingUpdate(true)
    setUpdateProgress(null)
    setError(null)
    setNotice(null)
    try {
      const result = await updateInstall()
      setAvailableUpdate(null)
      setNotice(
        result.restarting
          ? `Version ${result.installedVersion} installée. Redémarrage…`
          : `Version ${result.installedVersion} installée.`,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      installingUpdateRef.current = false
      setInstallingUpdate(false)
      setUpdateProgress(null)
    }
  }, [])

  useEffect(() => {
    if (!installingUpdate) {
      return
    }
    let disposed = false
    let stop: (() => void) | undefined
    void listen<{ downloaded: number; total: number | null }>(
      'update://progress',
      (event) => {
        if (disposed) {
          return
        }
        const { downloaded, total } = event.payload
        setUpdateProgress(
          total && total > 0
            ? Math.min(100, Math.round((downloaded / total) * 100))
            : null,
        )
      },
    )
      .then((unlisten) => {
        if (disposed) {
          unlisten()
        } else {
          stop = unlisten
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      stop?.()
    }
  }, [installingUpdate])

  // One quiet check at startup, then when the window regains focus and every
  // six hours: the header offers an update without opening the settings page.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (installingUpdateRef.current) {
        return
      }
      try {
        const next = await updateCheck()
        if (!cancelled) setAvailableUpdate(next?.version ?? null)
      } catch {
        if (!cancelled) setAvailableUpdate(null)
      }
    }
    void check()
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const session = await gitlabStatus()
        if (!cancelled) {
          setConnected(session.connected)
          setGitlabUser(session.user?.name ?? session.user?.username ?? null)
        }
      } catch {
        if (!cancelled) {
          setConnected(false)
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [generation])

  useEffect(() => {
    if (!repoId) {
      setStashCount(0)
      return
    }
    let cancelled = false
    void stashList(repoId)
      .then((entries) => {
        if (!cancelled) {
          setStashCount(entries.length)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId, generation])

  useEffect(() => {
    if (!repoId) {
      setUndoState(null)
      return
    }
    let cancelled = false
    void undoStatus(repoId)
      .then((next) => {
        if (!cancelled) setUndoState(next)
      })
      .catch(() => {
        if (!cancelled) setUndoState(null)
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation])

  const openRepo = useCallback(
    async (path: string) => {
      setBusy(true)
      setError(null)
      try {
        const opened = await repoOpen(path)
        upsert(opened)
        setDiffRequest(null)
        setView('graph')
        await reloadRecent()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [reloadRecent, upsert],
  )

  const cloneRepo = async (input: CloneInput) => {
    setBusy(true)
    try {
      const opened = await repoClone(input)
      upsert(opened)
      setDiffRequest(null)
      setView('graph')
      await reloadRecent()
    } finally {
      setBusy(false)
    }
  }

  const initRepo = async (input: InitInput) => {
    setBusy(true)
    try {
      const opened = await repoInit(input)
      upsert(opened)
      setDiffRequest(null)
      setView('graph')
      setInitDialogOpen(false)
      await reloadRecent()
    } finally {
      setBusy(false)
    }
  }

  const activate = async (target: string) => {
    const existing = repos.find((entry) => entry.repo.repoId === target)
    if (!existing) {
      return
    }
    setActiveId(target)
    setGeneration(existing.generation)
    setDiffRequest(null)
    try {
      const refreshed = await repoGetState(target)
      upsert(refreshed, false)
    } catch {
      // The tab stays usable with its last known state.
    }
  }

  const refresh = async () => {
    if (!repo) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const refreshed = await repoRefresh(repo.repo.repoId)
      upsert(refreshed, false)
      setGeneration(refreshed.generation)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const performUndo = async (direction: 'undo' | 'redo') => {
    if (!repoId) {
      return
    }
    setError(null)
    setNotice(null)
    try {
      const outcome =
        direction === 'undo' ? await undoApply(repoId) : await redoApply(repoId)
      setNotice(outcome.message)
      const fresh = await repoGetState(repoId)
      upsert(fresh, false)
      setGeneration(fresh.generation)
      setUndoState(await undoStatus(repoId))
    } catch (cause) {
      setError(errorMessage(cause))
      setUndoState(await undoStatus(repoId).catch(() => null))
      throw cause
    }
  }

  const removeRepo = async (target: string, confirmed = false) => {
    try {
      await repoCloseChecked(target, confirmed ? { acknowledged: true } : undefined)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    const next = repos.filter((entry) => entry.repo.repoId !== target)
    setRepos(next)
    const nextActive = next[0]?.repo.repoId ?? null
    setActiveId(nextActive)
    setGeneration(next[0]?.generation ?? 0)
    setDiffRequest(null)
    await reloadRecent()
  }

  const requestClose = (target: string) => {
    const entry = repos.find((item) => item.repo.repoId === target)
    if (!entry) {
      return
    }
    if (entry.state.operation || entry.state.conflicts.files.length > 0) {
      setPendingClose(entry)
      return
    }
    void removeRepo(target)
  }


  const changeTheme = (next: Theme) => {
    setTheme(next)
    void preferenceSet(THEME_KEY, next)
  }

  const changeDensity = (next: Density) => {
    setDensity(next)
    void preferenceSet(DENSITY_KEY, next)
  }

  const openDiff = (request: Parameters<typeof Workbench>[0]['diffRequest']) => {
    if (view !== 'diff') setPreviousView(view)
    setDiffRequest(request)
    setView('diff')
  }

  const navigate = useCallback((target: ViewId) => {
    if (target === 'status' || target === 'commit') {
      setView('graph')
      setWorktreeRequest((value) => value + 1)
    } else {
      setView(target)
    }
    setPaletteOpen(false)
  }, [])

  // Branch creation happens in the commit graph itself; this request is
  // forwarded to the workbench so the inline ref editor opens on HEAD.
  const newBranch = useCallback(() => {
    setView('graph')
    setBranchRequest((value) => value + 1)
    setPaletteOpen(false)
  }, [])

  const pickCloneDirectory = useCallback(async (defaultPath?: string) => {
    const selected = await openNativeDialog({
      title: 'Choisir le dossier de destination',
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === 'string' ? selected : null
  }, [])

  const pickInitParent = useCallback(async (defaultPath?: string) => {
    const selected = await openNativeDialog({
      title: 'Choisir le dossier parent',
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === 'string' ? selected : null
  }, [])

  const openInitDialog = useCallback(() => setInitDialogOpen(true), [])

  const openRepositoryDialog = useCallback(async () => {
    if (pickingRepository.current || busy) return
    pickingRepository.current = true
    setBusy(true)
    setError(null)
    try {
      const path = await openNativeDialog({
        title:'Ouvrir un dépôt Git',
        directory:true,
        multiple:false,
        defaultPath:recent[0]?.path,
      })
      if (typeof path === 'string') await openRepo(path)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      pickingRepository.current = false
      setBusy(false)
    }
  }, [busy, recent, openRepo])

  const commands = useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = navigationGroups.flatMap((group) =>
      group.items.filter((item) => item.id !== 'commit' && item.id !== 'diff').map((item) => ({
        id: `view-${item.id}`,
        label: `Aller à ${item.label}`,
        group: group.label,
        available: !item.requiresRepo || Boolean(repoId),
        unavailableReason: 'Ouvrez un dépôt pour utiliser cette vue.',
        run: () => navigate(item.id),
      })),
    )
    items.push(
      {
        id: 'action-open-repo',
        label: 'Ouvrir un dépôt…',
        group: 'Actions',
        shortcut: '⌘O',
        run: () => openRepositoryDialog(),
      },
      {
        id: 'action-refresh',
        label: 'Rafraîchir le dépôt',
        group: 'Actions',
        available: Boolean(repoId),
        unavailableReason: 'Ouvrez un dépôt.',
        run: () => void refresh(),
      },
      {
        id: 'action-conflicts',
        label: 'Résoudre les conflits',
        group: 'Actions',
        available: Boolean(repoId),
        run: () => navigate('conflicts'),
      },
      {
        id: 'action-new-branch',
        label: 'Nouvelle branche…',
        group: 'Git',
        shortcut: '⌘B',
        available: Boolean(repoId),
        unavailableReason: 'Ouvrez un dépôt.',
        run: newBranch,
      },
      {
        id: 'action-rebase',
        label: 'Rebase interactif…',
        group: 'Actions',
        available: Boolean(repoId),
        run: () => navigate('rebase'),
      },
      {
        id: 'action-undo',
        label: undoState?.undo?.undoLabel ?? 'Annuler la dernière opération',
        group: 'Git',
        shortcut: '⌘Z',
        available: Boolean(repoId && undoState?.undo),
        unavailableReason: 'Aucune opération annulable.',
        run: () => void performUndo('undo'),
      },
      {
        id: 'action-redo',
        label: undoState?.redo?.redoLabel ?? 'Rétablir la dernière annulation',
        group: 'Git',
        shortcut: '⌘⇧Z',
        available: Boolean(repoId && undoState?.redo),
        unavailableReason: 'Aucune opération à rétablir.',
        run: () => void performUndo('redo'),
      },
      {
        id: 'action-fetch',
        label: 'Fetch origin',
        group: 'Git',
        available: Boolean(repoId),
        unavailableReason: 'Ouvrez un dépôt.',
        run: () => {
          if (repoId) {
            void syncFetch(repoId, 'origin')
              .then(() => refresh())
              .catch((cause) => setError(errorMessage(cause)))
          }
        },
      },
      {
        id: 'action-pull',
        label: 'Pull la branche courante',
        group: 'Git',
        available: Boolean(repoId && repo?.state.head?.kind === 'branch' && repo.state.head.upstream),
        unavailableReason: 'Une branche avec upstream est requise.',
        run: () => {
          if (!repoId || repo?.state.head?.kind !== 'branch' || !repo.state.head.upstream) {
            return
          }
          const [remote, ...rest] = repo.state.head.upstream.split('/')
          void syncPull({ repoId, remote, branch: rest.join('/') })
            .then(() => refresh())
            .catch((cause) => setError(errorMessage(cause)))
        },
      },
      {
        id: 'action-push',
        label: 'Push la branche courante',
        group: 'Git',
        available: Boolean(repoId && repo?.state.head?.kind === 'branch' && repo.state.head.upstream),
        unavailableReason: 'Une branche avec upstream est requise.',
        run: () => {
          if (!repoId || repo?.state.head?.kind !== 'branch' || !repo.state.head.upstream) {
            return
          }
          const [remote, ...rest] = repo.state.head.upstream.split('/')
          void syncPush({ repoId, remote, branch: rest.join('/') })
            .then(() => refresh())
            .catch((cause) => setError(errorMessage(cause)))
        },
      },
      {
        id: 'action-theme',
        label: 'Basculer le thème sombre / clair',
        group: 'Système',
        run: () => changeTheme(theme === 'light' ? 'dark' : 'light'),
      },
      {
        id: 'action-settings',
        label: 'Profils et réglages',
        group: 'Système',
        shortcut: '⌘,',
        run: () => navigate('profiles'),
      },
      {
        id: 'action-init-repo',
        label: 'Créer un dépôt local',
        group: 'Système',
        run: () => openInitDialog(),
      },
      {
        id: 'action-close',
        label: 'Fermer le dépôt actif',
        group: 'Système',
        available: Boolean(repoId),
        run: () => repoId && requestClose(repoId),
      },
    )
    return items
  }, [navigate, newBranch, repoId, repo, refresh, requestClose, theme, openRepositoryDialog, openInitDialog, undoState, performUndo])

  useShortcuts({
    palette: () => setPaletteOpen(true),
    settings: () => navigate('profiles'),
    newBranch: () => repoId && newBranch(),
    search: () => repoId && navigate('search'),
    openRepo: () => openRepositoryDialog(),
    undo: () => void performUndo('undo'),
    redo: () => void performUndo('redo'),
    close: () => {
      setPaletteOpen(false)
    },
  }, shortcuts)

  const showHome =
    !repo && !['profiles', 'gitlab', 'recovery', 'workspaces'].includes(view)
  const branch =
    repo?.state.head?.kind === 'branch' ? repo.state.head.name : null

  return (
    <div
      className={styles.app}
      style={{ '--sidebar-width': `${layout.sidebar}px` } as CSSProperties}
    >
      <a href="#main-content" className="skip-link">
        Aller au contenu principal
      </a>
      <TopBar
        repos={repos}
        activeId={activeId}
        busy={busy}
        onActivate={(target) => void activate(target)}
        onClose={requestClose}
        onOpenDialog={() => openRepositoryDialog()}
        onClone={() => setCloneDialogOpen(true)}
        onInit={openInitDialog}
        onSettings={() => navigate('profiles')}
        updateVersion={availableUpdate}
        updateBusy={installingUpdate}
        onInstallUpdate={() => void installUpdate()}
        user={gitlabUser}
      />
      {availableUpdate && dismissedUpdate !== availableUpdate ? (
        <UpdateNotice
          version={availableUpdate}
          installing={installingUpdate}
          progress={updateProgress}
          onInstall={() => void installUpdate()}
          onDismiss={() => setDismissedUpdate(availableUpdate)}
        />
      ) : null}
      <RepoBar
        repo={repo}
        repos={repos}
        busy={busy}
        onActivate={(target) => void activate(target)}
        onOpenDialog={openRepositoryDialog}
        onOpenPalette={() => setPaletteOpen(true)}
        onRefresh={() => void refresh()}
        onNavigate={navigate}
        onNewBranch={newBranch}
        onError={setError}
        undo={undoState?.undo ?? null}
        redo={undoState?.redo ?? null}
        onUndo={() => performUndo('undo')}
        onRedo={() => performUndo('redo')}
      />
      <div className={styles.body}>
        <Sidebar
          active={view}
          repoName={repo?.repo.name ?? null}
          branch={branch}
          conflicts={repo?.state.conflicts.files.length ?? 0}
          stashes={stashCount}
          mergeRequests={0}
          connected={connected}
          version="0.4.0"
          onSelect={navigate}
        />
        <main id="main-content" tabIndex={-1} className={styles.main} aria-busy={busy}>
          <Resizer
            className={styles.sidebarResizer}
            label="Redimensionner la navigation"
            side="right"
            value={layout.sidebar}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            onChange={(sidebar) => changeLayout({ sidebar })}
            onReset={() => changeLayout({ sidebar: 210 })}
          />
          <div className={`${styles.viewbar} ${view === 'graph' && repo ? styles.compactViewbar : ''}`}>
            {view === 'diff' ? <button type="button" className={styles.back} onClick={() => navigate(previousView)}>← Retour</button> : null}
            <div className={styles.viewHeading}>
              <h1>{showHome ? 'Bienvenue' : VIEW_LABELS[view]}</h1>
              {!showHome && viewDescriptions[view] ? <p>{viewDescriptions[view]}</p> : null}
            </div>
            {repo ? (
              <span className={styles.crumb}>{repo.repo.name}</span>
            ) : null}
            <span className={styles.spacer} />

            {busy ? <span className={styles.busy}>travail en cours…</span> : null}
          </div>

          {repo &&
          (repo.state.operation || repo.state.conflicts.files.length > 0) ? (
            <div className={styles.intermediate} role="status">
              <span>
                Opération en cours :{' '}
                {repo.state.operation
                  ? repo.state.operation.kind === 'rebase'
                    ? `rebase (${repo.state.operation.variant})`
                    : repo.state.operation.kind
                  : 'conflits'}
                {repo.state.conflicts.files.length > 0
                  ? ` · ${repo.state.conflicts.files.length} fichier(s) en conflit`
                  : ''}
              </span>
              <button type="button" onClick={() => navigate('conflicts')}>
                Résoudre
              </button>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    repo.state.operation?.kind === 'rebase' ? 'rebase' : 'conflicts',
                  )
                }
              >
                Gérer
              </button>
            </div>
          ) : null}

          {notice ? (
            <div className={styles.busy} role="status" aria-live="polite">
              {notice}
            </div>
          ) : null}

          {error ? (
            <div className={styles.error} role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>
                Fermer
              </button>
            </div>
          ) : null}

          <div className={styles.workspace} data-page={view}>
            {showHome ? (
              <Home
                onOpenDialog={() => openRepositoryDialog()}
                onSelect={navigate}
                recent={recent}
                onOpen={(path) => void openRepo(path)}
                onClone={cloneRepo}
                onCreate={openInitDialog}
                onPickDirectory={pickCloneDirectory}
              />
            ) : (
              <Workbench
                key={repo?.repo.repoId ?? 'no-repo'}
                repo={repo}
                generation={repo?.generation ?? generation}
                view={view}
                worktreeRequest={worktreeRequest}
                branchRequest={branchRequest}
                diffRequest={diffRequest}
                onOpenDiff={openDiff}
                onOpenRepo={(path) => void openRepo(path)}
                onMutated={() => void refresh()}
                onNavigate={navigate}
                connected={connected}
                theme={theme}
                onThemeChange={changeTheme}
                density={density}
                onDensityChange={changeDensity}
                shortcuts={shortcuts}
                onShortcutsChange={(next) => {
                  setShortcuts(next)
                  void preferenceSet(SHORTCUTS_KEY, JSON.stringify(next))
                }}
                layout={layout}
                onLayoutChange={changeLayout}
              />
            )}
          </div>
        </main>
      </div>
      <StatusBar repo={repo} generation={repo?.generation ?? generation} connected={connected} />

      {cloneDialogOpen ? <CloneRepoDialog busy={busy} recent={recent} onClose={() => setCloneDialogOpen(false)}
        onClone={async (input) => { await cloneRepo(input); setCloneDialogOpen(false) }}
        onOpen={(path) => void openRepo(path)} onOpenDialog={openRepositoryDialog} onNavigate={navigate} onPickDirectory={pickCloneDirectory} /> : null}
      {initDialogOpen ? <InitRepoDialog
        busy={busy}
        defaultParent={initParent}
        onClose={() => setInitDialogOpen(false)}
        onCreate={initRepo}
        onPickParent={pickInitParent}
      /> : null}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ConfirmDialog
        open={pendingClose !== null}
        title="Fermer un onglet avec une opération en cours"
        consequence={
          pendingClose?.state.operation
            ? `Le dépôt ${pendingClose?.repo.name ?? ''} a une opération Git en cours (${pendingClose.state.operation.kind}). La fermeture ne résout rien : l'état devra être vérifié à la réouverture.`
            : `Le dépôt ${pendingClose?.repo.name ?? ''} contient des conflits non résolus. La fermeture ne les résout pas.`
        }
        irreversible
        confirmLabel="Fermer l'onglet"
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          const target = pendingClose
          setPendingClose(null)
          if (target) {
            void removeRepo(target.repo.repoId, true)
          }
        }}
      />
    </div>
  )
}
