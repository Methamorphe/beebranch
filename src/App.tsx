import { listen } from '@tauri-apps/api/event'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { ShortcutHelp } from './components/ShortcutHelp'
import { ConfirmBar } from './components/ConfirmBar'
import {
  checkoutNeedsConfirmation,
  OperationConfirmProvider,
  pushNeedsConfirmation,
  readCheckoutPreview,
  readPushPreview,
  type ConfirmOperation,
} from './components/OperationConfirm'
import { Home } from './components/Home'
import { InitRepoDialog } from './components/InitRepoDialog'
import { PushRejectedBar } from './components/PushRejectedBar'
import { RepoBar } from './components/RepoBar'
import { Resizer } from './components/Resizer'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TopBar } from './components/TopBar'
import { UpdateNotice } from './components/UpdateNotice'
import { ActionBarProvider, ActionBarSlot } from './components/ui/ActionBar'
import { useToastChannel, useToasts } from './components/ui/Toasts'
import { Workbench } from './components/Workbench'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { APP_PAGES, navigationGroups, viewDescriptions, type ViewId } from './data/navigation'
import { errorMessage } from './ipc/client'
import { I18nProvider, LANGUAGE_PREFERENCE_KEY, detectLocale, isLocale, plural, setLocale, t, type Locale, type MessageKey } from './i18n'
import {
  backgroundRead,
  branchCheckout,
  githubStatus,
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
  syncFetchAll,
  syncPull,
  syncPush,
  undoApply,
  undoStatus,
  updateCheck,
  updateInstall,
  workspaceList,
} from './ipc/commands'
import { useRepoEvents } from './hooks/useRepoEvents'
import { useShortcuts } from './hooks/useShortcuts'
import { useZoom } from './hooks/useZoom'
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  defaultLayout,
  parseLayout,
  type LayoutPreferences,
} from './lib/layout'
import { applyBackground } from './lib/background'
import {
  moveFavourite,
  parseFavourites,
  serializeFavourites,
  toggleFavourite,
  type Favourite,
} from './lib/favourites'
import { isPushRejection, type PushRejection } from './lib/pushRejection'
import {
  VISUAL_PREVIEW_KEY,
  applyVisualPreview,
  parseVisualPreview,
  type VisualPreview,
} from './lib/visualPreview'
import {
  BACKGROUND_KEY,
  SPLASH_KEY,
  parseMediaSettings,
  serializeMediaSettings,
  type MediaSettings,
} from './lib/mediaSettings'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  displayShortcut,
  findConflicts,
  normalizeShortcut,
  type ShortcutAction,
  type ShortcutMap,
} from './lib/shortcuts'
import { normalizeRepoPath } from './lib/workspace'
import { undoActionLabel, undoButtonLabel, undoNotice, undoOfferNotice } from './lib/undoLabel'
import type { ChangeEvent, RecentRepo, RepoView, UndoOutcome, UndoStatus, Workspace } from './types/git'
import type { CloneInput, InitInput } from './ipc/commands'
import styles from './App.module.css'

const OPEN_REPOS_KEY = 'ui.openRepos'
const ACTIVE_REPO_KEY = 'ui.activeRepo'
const THEME_KEY = 'ui.theme'
const SHORTCUTS_KEY = 'ui.shortcuts'
const DENSITY_KEY = 'ui.density'
const LAYOUT_KEY = 'ui.layout'
const ACTIVE_WORKSPACE_KEY = 'ui.activeWorkspace'
const WORKSPACE_LAST_REPO_KEY = 'ui.workspaceLastRepo'
const FAVOURITES_KEY = 'ui.favourites'

type Theme = 'dark' | 'light' | 'system'
type Density = 'compact' | 'comfortable'

const VIEW_LABELS = Object.fromEntries(navigationGroups.flatMap((group) => group.items.map((item) => [item.id, item.labelKey]))) as Record<ViewId, MessageKey>
VIEW_LABELS.commit = 'nav.status'
VIEW_LABELS.diff = 'nav.comparison'

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
  const navigationGuard = useRef<(() => boolean) | null>(null)
  const registerNavigationGuard = useCallback((guard: (() => boolean) | null) => {
    navigationGuard.current = guard
  }, [])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  // Last focused repository per workspace, so switching back restores it.
  const workspaceLastRepo = useRef<Record<string, string>>({})
  // Latest version offered by the signed manifest, surfaced in the header.
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null)
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const installingUpdateRef = useRef(false)
  const [worktreeRequest, setWorktreeRequest] = useState(0)
  const [branchRequest, setBranchRequest] = useState(0)
  const [findRequest, setFindRequest] = useState(0)
  const [historyRequest, setHistoryRequest] = useState<Parameters<typeof Workbench>[0]['historyRequest']>(null)
  const [generation, setGeneration] = useState(0)
  const [diffRequest, setDiffRequest] = useState<Parameters<typeof Workbench>[0]['diffRequest']>(null)
  const [recent, setRecent] = useState<RecentRepo[]>([])
  const [busy, setBusy] = useState(false)
  const setError = useToastChannel('app-error', 'error')
  const [pendingClose, setPendingClose] = useState<RepoView | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  // Bumped on every new-tab request so the launcher re-focuses its search.
  const [launcherFocus, setLauncherFocus] = useState(0)
  const [initDialogOpen, setInitDialogOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  /** Push target whose update Git refused, awaiting the user's decision. */
  const [pushRejected, setPushRejected] = useState<PushRejection | null>(null)
  const [previousView, setPreviousView] = useState<ViewId>('graph')
  const pickingRepository = useRef(false)
  const [gitlabConnected, setGitlabConnected] = useState(false)
  const [githubConnected, setGithubConnected] = useState(false)
  const [forgeUser, setForgeUser] = useState<string | null>(null)
  const [stashCount, setStashCount] = useState(0)
  const [undoState, setUndoStateRaw] = useState<UndoStatus | null>(null)
  const setNotice = useToastChannel('app-notice', 'info')
  const toasts = useToasts()
  /** Highest journal position seen per repository, to spot new records. */
  const undoSeen = useRef(new Map<string, number>())
  /** One undo/redo at a time, whatever triggered it. */
  const undoInFlight = useRef(false)
  /** Latest `performUndo`, for toast buttons created by an earlier render. */
  const confirmOperation = useRef<ConfirmOperation | null>(null)
  const performUndoRef = useRef<(direction: 'undo' | 'redo', expectedId?: string) => Promise<UndoOutcome | null>>(
    async () => null,
  )
  /**
   * Store the journal status of `target` and, when it shows a record newer
   * than any seen for that repository, confirm the action with an "Undo"
   * button. The first status of a repository only sets the baseline, and an
   * undo/redo never creates a newer record, so nothing is announced twice.
   */
  const setUndoState = useCallback(
    (target: string, next: UndoStatus | null) => {
      setUndoStateRaw(next)
      if (!next) return
      const newest = next.recent[0]
      const seen = undoSeen.current.get(target)
      undoSeen.current.set(target, Math.max(seen ?? 0, newest?.position ?? 0))
      if (seen === undefined || !newest || newest.position <= seen) return
      if (newest.state !== 'available' || next.undo?.id !== newest.id) return
      // The offer replaces the generic "done" notice of the action itself.
      toasts.dismiss('workbench-notice')
      toasts.dismiss('repobar-notice')
      toasts.show({
        channel: 'undo-offer',
        tone: 'success',
        message: undoOfferNotice(newest),
        // A blocked undo is not offered: its toolbar tooltip explains why.
        action: next.undo.blocked
          ? undefined
          : {
              label: t('shell.undo.undoButton'),
              run: () => void performUndoRef.current('undo', newest.id),
            },
      })
    },
    [toasts],
  )
  const [theme, setTheme] = useState<Theme>('dark')
  const [favourites, setFavourites] = useState<Favourite[]>([])
  /** Guards the persist effect until the stored list has been read back. */
  const [favouritesLoaded, setFavouritesLoaded] = useState(false)
  const [locale, setLocaleState] = useState<Locale>(detectLocale)
  // `App` renders outside the provider (it owns the switching state), so the
  // module-level language must be current before its own `t` calls run.
  setLocale(locale)
  const [density, setDensity] = useState<Density>('comfortable')
  const [visualPreview, setVisualPreview] = useState<VisualPreview>('off')
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS)
  /** Labels of the actions whose stored binding was reverted to its default. */
  const [shortcutConflict, setShortcutConflict] = useState<string[]>([])
  const [layout, setLayout] = useState<LayoutPreferences>(defaultLayout)
  const [background, setBackground] = useState<MediaSettings | null>(null)
  // Decoded `data:` URL for the wallpaper; kept out of state serialization
  // paths because it can be tens of megabytes.
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  // The splash window reads its own image at boot, so the shell only needs the
  // persisted settings here.
  const [splash, setSplash] = useState<MediaSettings | null>(null)
  const [splashError, setSplashError] = useState<string | null>(null)
  const backgroundToken = useRef(0)
  const backgroundLayer = useRef<HTMLDivElement | null>(null)
  const splashToken = useRef(0)
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

  const rememberWorkspaceRepo = useCallback((workspaceId: string | null, repoId: string | null) => {
    if (!workspaceId || !repoId) {
      return
    }
    const next = { ...workspaceLastRepo.current, [workspaceId]: repoId }
    workspaceLastRepo.current = next
    void preferenceSet(WORKSPACE_LAST_REPO_KEY, JSON.stringify(next))
  }, [])

  const moveRepo = useCallback((repoId: string, targetId: string, side: 'before' | 'after') => {
    if (repoId === targetId) return
    setRepos((current) => {
      const from = current.findIndex((entry) => entry.repo.repoId === repoId)
      if (from < 0) return current
      const next = current.filter((entry) => entry.repo.repoId !== repoId)
      const target = next.findIndex((entry) => entry.repo.repoId === targetId)
      if (target < 0) return current
      next.splice(side === 'after' ? target + 1 : target, 0, current[from]!)
      return next
    })
  }, [])

  useEffect(() => {
    if (hydrated) {
      persist(repos, activeId)
    }
  }, [hydrated, repos, activeId, persist])

  useEffect(() => {
    if (!hydrated) {
      return
    }
    void preferenceSet(ACTIVE_WORKSPACE_KEY, activeWorkspaceId ?? '')
  }, [hydrated, activeWorkspaceId])

  // A workspace deleted from the management screen no longer names the tab set.
  useEffect(() => {
    if (!workspacesLoaded || !activeWorkspaceId) {
      return
    }
    if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
      setActiveWorkspaceId(null)
    }
  }, [workspacesLoaded, workspaces, activeWorkspaceId])

  useEffect(() => {
    let cancelled = false
    void preferenceGet(FAVOURITES_KEY)
      .then((raw) => {
        if (!cancelled) {
          setFavourites(parseFavourites(raw))
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setFavouritesLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated || !favouritesLoaded) {
      return
    }
    void preferenceSet(FAVOURITES_KEY, serializeFavourites(favourites))
  }, [hydrated, favouritesLoaded, favourites])

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

  // Wallpaper settings are applied through CSS variables on <html> and the
  // image directly on its layer; the data URL must not be re-diffed on every
  // render.
  useEffect(() => {
    applyBackground(background, backgroundUrl, backgroundLayer.current)
  }, [background, backgroundUrl])

  // Sliders fire continuously; persist once the drag settles. The splash uses
  // the same schema but is read by its own window at the next boot.
  useEffect(() => {
    if (!hydrated) {
      return
    }
    const timer = window.setTimeout(() => {
      void preferenceSet(BACKGROUND_KEY, serializeMediaSettings(background))
      void preferenceSet(SPLASH_KEY, serializeMediaSettings(splash))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [hydrated, background, splash])

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
    applyVisualPreview(visualPreview)
  }, [visualPreview])

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
            setError(t('shell.notice.openReposUnreadable'))
          }
        }
        const activePath = await preferenceGet(ACTIVE_REPO_KEY)
        const themeRaw = await preferenceGet(THEME_KEY)
        if (themeRaw === 'light' || themeRaw === 'dark' || themeRaw === 'system') {
          setTheme(themeRaw)
        }
        const languageRaw = await preferenceGet(LANGUAGE_PREFERENCE_KEY)
        if (isLocale(languageRaw)) {
          setLocaleState(languageRaw)
        }
        const densityRaw = await preferenceGet(DENSITY_KEY)
        if (densityRaw === 'compact' || densityRaw === 'comfortable') {
          setDensity(densityRaw)
        }
        setVisualPreview(parseVisualPreview(await preferenceGet(VISUAL_PREVIEW_KEY)))
        const layoutRaw = await preferenceGet(LAYOUT_KEY)
        if (layoutRaw) {
          setLayout(parseLayout(layoutRaw))
        }
        const backgroundRaw = await preferenceGet(BACKGROUND_KEY)
        const storedBackground = parseMediaSettings(backgroundRaw)
        if (storedBackground) {
          setBackground(storedBackground)
          try {
            setBackgroundUrl(await backgroundRead(storedBackground.path))
          } catch (cause) {
            setBackgroundError(errorMessage(cause))
          }
        }
        setSplash(parseMediaSettings(await preferenceGet(SPLASH_KEY)))
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
              // A duplicate binding makes one action unreachable: the conflicting
              // actions fall back to their default instead of being dropped
              // silently, and the interface reports them.
              let resolved = normalized
              const conflicting = findConflicts(normalized)
              if (conflicting.length > 0) {
                resolved = { ...normalized }
                for (const action of conflicting) {
                  resolved[action] = DEFAULT_SHORTCUTS[action]
                }
                setShortcutConflict(
                  conflicting.map((action) => t(SHORTCUT_LABELS[action])),
                )
              }
              setShortcuts(resolved)
            }
          } catch {
            // Keep the defaults when the stored shortcut map is corrupt.
          }
        }
        try {
          const [storedWorkspaces, storedActiveWorkspace, storedLastRepo] =
            await Promise.all([
              workspaceList().catch(() => [] as Workspace[]),
              preferenceGet(ACTIVE_WORKSPACE_KEY),
              preferenceGet(WORKSPACE_LAST_REPO_KEY),
            ])
          setWorkspaces(storedWorkspaces)
          if (storedActiveWorkspace) {
            setActiveWorkspaceId(
              storedWorkspaces.some(
                (workspace) => workspace.id === storedActiveWorkspace,
              )
                ? storedActiveWorkspace
                : null,
            )
          }
          if (storedLastRepo) {
            const parsed: unknown = JSON.parse(storedLastRepo)
            if (parsed && typeof parsed === 'object') {
              const map: Record<string, string> = {}
              for (const [id, repoId] of Object.entries(parsed)) {
                if (typeof repoId === 'string') {
                  map[id] = repoId
                }
              }
              workspaceLastRepo.current = map
            }
          }
        } catch {
          // Workspaces are a convenience; the tab strip still restores.
        } finally {
          setWorkspacesLoaded(true)
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
          ? t('shell.notice.installedRestart', { version: result.installedVersion })
          : t('shell.notice.installed', { version: result.installedVersion }),
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
      const [gitlab, github] = await Promise.allSettled([gitlabStatus(), githubStatus()])
      if (cancelled) {
        return
      }
      const gitlabSession = gitlab.status === 'fulfilled' ? gitlab.value : null
      const githubSession = github.status === 'fulfilled' ? github.value : null
      setGitlabConnected(Boolean(gitlabSession?.connected))
      setGithubConnected(Boolean(githubSession?.connected))
      const labels: string[] = []
      if (gitlabSession?.user) {
        labels.push(`${gitlabSession.user.name ?? gitlabSession.user.username} (GitLab)`)
      }
      if (githubSession?.user) {
        labels.push(`${githubSession.user.name ?? githubSession.user.username} (GitHub)`)
      }
      setForgeUser(labels.length > 0 ? labels.join(' · ') : null)
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
      setUndoStateRaw(null)
      return
    }
    let cancelled = false
    void undoStatus(repoId)
      .then((next) => {
        if (!cancelled) setUndoState(repoId, next)
      })
      .catch(() => {
        if (!cancelled) setUndoState(repoId, null)
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation, setUndoState])

  const openRepo = useCallback(
    async (path: string) => {
      setBusy(true)
      setError(null)
      try {
        const opened = await repoOpen(path)
        upsert(opened)
        setLauncherOpen(false)
        setDiffRequest(null)
        setView('graph')
        await reloadRecent()
        return true
      } catch (cause) {
        setError(errorMessage(cause))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reloadRecent, upsert],
  )

  /**
   * Open a favourite by slot; a repository that disappeared keeps its slot and
   * the failure names the slot instead of a generic open error.
   */
  const openFavourite = useCallback(
    async (slot: number, favourite: Favourite) => {
      const opened = await openRepo(favourite.path)
      if (!opened) {
        setError(
          t('shell.favourites.unavailable', {
            slot: slot + 1,
            name: favourite.name,
            path: favourite.path,
          }),
        )
      }
    },
    [openRepo],
  )

  const rememberFavourite = useCallback((entry: Favourite) => {
    setFavourites((current) => toggleFavourite(current, entry))
  }, [])

  const reorderFavourite = useCallback((path: string, direction: -1 | 1) => {
    setFavourites((current) => moveFavourite(current, path, direction))
  }, [])

  // Ctrl/⌘+Alt+1…9 switches to the favourite in that slot. An empty slot or a
  // missing repository is reported; nothing else is opened.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey) {
        return
      }
      const match = /^[1-9]$/.exec(event.key)
      if (!match) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      const slot = Number(match[1]) - 1
      const favourite = favourites[slot]
      if (!favourite) {
        setError(t('shell.favourites.emptySlot', { slot: slot + 1 }))
        return
      }
      void openFavourite(slot, favourite)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [favourites, openFavourite])

  /**
   * Replace the open tabs with the repositories of a workspace, in the order
   * the workspace stores them. A repository that already has a tab keeps it;
   * a clean tab outside the workspace closes, while a tab with an operation in
   * progress or unresolved conflicts stays open rather than losing work.
   */
  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      const target = workspaces.find((workspace) => workspace.id === workspaceId)
      if (!target || switching) {
        return
      }
      setWorkspaceMenuOpen(false)
      setLauncherOpen(false)
      setError(null)
      setNotice(null)
      setSwitching(true)
      try {
        const openByPath = new Map<string, RepoView>()
        for (const entry of repos) {
          const path = normalizeRepoPath(entry.repo.worktree)
          if (!openByPath.has(path)) {
            openByPath.set(path, entry)
          }
        }
        const wanted = new Map<string, Workspace['repos'][number]>()
        for (const entry of target.repos) {
          const path = normalizeRepoPath(entry.path)
          if (!wanted.has(path)) {
            wanted.set(path, entry)
          }
        }
        const reusable = new Map<string, RepoView>()
        const toOpen: Workspace['repos'] = []
        for (const [path, entry] of wanted) {
          const existing = openByPath.get(path)
          if (existing) {
            reusable.set(path, existing)
          } else {
            toOpen.push(entry)
          }
        }
        const failures: string[] = []
        const opened = await Promise.all(
          toOpen.map(async (entry) => {
            try {
              return {
                path: normalizeRepoPath(entry.path),
                view: await repoOpen(entry.path),
              }
            } catch {
              failures.push(entry.name ?? entry.path)
              return null
            }
          }),
        )
        // Never tear down a working tab set to land on an empty, broken one.
        if (
          wanted.size > 0 &&
          reusable.size === 0 &&
          opened.every((entry) => entry === null)
        ) {
          setError(t('shell.workspace.noneOpened', { name: target.name }))
          return
        }
        const byPath = new Map(reusable)
        for (const entry of opened) {
          if (entry) {
            byPath.set(entry.path, entry.view)
          }
        }
        const ordered: RepoView[] = []
        const workspaceIds = new Set<string>()
        for (const path of wanted.keys()) {
          const view = byPath.get(path)
          if (!view || workspaceIds.has(view.repo.repoId)) {
            continue
          }
          workspaceIds.add(view.repo.repoId)
          ordered.push(view)
        }
        const dropped = repos.filter((entry) => !workspaceIds.has(entry.repo.repoId))
        const closable = dropped.filter(
          (entry) => !entry.state.operation && entry.state.conflicts.files.length === 0,
        )
        const closed = new Set<string>()
        await Promise.all(
          closable.map(async (entry) => {
            try {
              if (await repoCloseChecked(entry.repo.repoId)) {
                closed.add(entry.repo.repoId)
              }
            } catch {
              // The session refused to close: keep the tab visible.
            }
          }),
        )
        const kept = dropped.filter((entry) => !closed.has(entry.repo.repoId))
        const remembered = workspaceLastRepo.current[workspaceId]
        const focus =
          ordered.find((entry) => entry.repo.repoId === remembered) ??
          ordered[0] ??
          kept[0] ??
          null
        setRepos([...ordered, ...kept])
        setActiveId(focus?.repo.repoId ?? null)
        setGeneration(focus?.generation ?? 0)
        setDiffRequest(null)
        setActiveWorkspaceId(workspaceId)
        rememberWorkspaceRepo(workspaceId, focus?.repo.repoId ?? null)
        if (focus) {
          try {
            const refreshed = await repoGetState(focus.repo.repoId)
            upsert(refreshed, false)
          } catch {
            // The tab stays usable with the state it already has.
          }
        }
        await reloadRecent()
        // The workspace selector and repository tabs already show success.
        // Only report tabs that could not be closed because work is in progress.
        if (kept.length > 0) {
          setNotice(plural('shell.workspace.kept.one', 'shell.workspace.kept.other', kept.length))
        }
        if (failures.length > 0) {
          setError(t('shell.workspace.unavailable', { list: failures.join(', ') }))
        }
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setSwitching(false)
      }
    },
    [repos, workspaces, switching, rememberWorkspaceRepo, reloadRecent, upsert],
  )

  const cloneRepo = async (input: CloneInput) => {
    setBusy(true)
    try {
      const opened = await repoClone(input)
      upsert(opened)
      setLauncherOpen(false)
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
      setLauncherOpen(false)
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
    setLauncherOpen(false)
    setDiffRequest(null)
    rememberWorkspaceRepo(activeWorkspaceId, target)
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

  const checkoutBranch = async (name: string) => {
    if (!repoId) {
      return
    }
    const operation = { kind: 'checkout' as const, name }
    const preview = await readCheckoutPreview(repoId, operation)
    // Same rule as the branch menus: a switch Git would not refuse runs
    // directly; only a blocked checkout asks, with its summary.
    const confirmed =
      preview && !checkoutNeedsConfirmation(preview)
        ? true
        : await (confirmOperation.current?.({
            title: t('workbench.operationPreview.title.checkout', { target: name }),
            confirmLabel: t('workbench.operationPreview.action.checkout'),
            operation,
          }) ?? Promise.resolve(false))
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      await branchCheckout({ repoId, name })
      const refreshed = await repoRefresh(repoId)
      upsert(refreshed, false)
      setGeneration(refreshed.generation)
      setUndoState(repoId, await undoStatus(repoId).catch(() => null))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Single entry point of every undo/redo trigger (⌘Z, palette, toolbar,
   * status bar, commit panel, toast buttons). It never rejects: the failure is
   * reported here, so callers can fire and forget. A trigger arriving while
   * one runs is ignored instead of racing it. With `expectedId`, the backend
   * only acts if that record is still the next one to undo/redo.
   */
  const performUndo = async (
    direction: 'undo' | 'redo',
    expectedId?: string,
  ): Promise<UndoOutcome | null> => {
    if (!repoId || undoInFlight.current) {
      return null
    }
    const target = repoId
    undoInFlight.current = true
    setError(null)
    setNotice(null)
    try {
      const outcome =
        direction === 'undo' ? await undoApply(target, expectedId) : await redoApply(target, expectedId)
      const reverse = direction === 'undo' ? 'redo' : 'undo'
      toasts.show({
        channel: 'undo-offer',
        tone: 'success',
        message: undoNotice(outcome.record, direction),
        action: {
          label: t(reverse === 'redo' ? 'shell.undo.redoButton' : 'shell.undo.undoButton'),
          run: () => void performUndoRef.current(reverse, outcome.record.id),
        },
      })
      const fresh = await repoGetState(target)
      upsert(fresh, false)
      setGeneration(fresh.generation)
      return outcome
    } catch (cause) {
      toasts.dismiss('undo-offer')
      setError(errorMessage(cause))
      return null
    } finally {
      setUndoState(target, await undoStatus(target).catch(() => null))
      undoInFlight.current = false
    }
  }
  useEffect(() => {
    performUndoRef.current = performUndo
  })

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

  const changeLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    void preferenceSet(LANGUAGE_PREFERENCE_KEY, next)
  }, [])

  const changeDensity = (next: Density) => {
    setDensity(next)
    void preferenceSet(DENSITY_KEY, next)
  }

  const changeVisualPreview = (next: VisualPreview) => {
    setVisualPreview(next)
    void preferenceSet(VISUAL_PREVIEW_KEY, next)
  }

  /**
   * Selecting a new file decodes it once; adjusting fit, dim or blur reuses the
   * URL already in memory instead of re-reading a possibly huge GIF.
   */
  const changeBackground = useCallback(
    async (next: MediaSettings | null) => {
      const token = ++backgroundToken.current
      if (!next) {
        setBackground(null)
        setBackgroundUrl(null)
        setBackgroundError(null)
        return
      }
      setBackgroundError(null)
      setBackground(next)
      if (background?.path === next.path && backgroundUrl) {
        return
      }
      try {
        const url = await backgroundRead(next.path)
        if (token === backgroundToken.current) {
          setBackgroundUrl(url)
        }
      } catch (cause) {
        if (token === backgroundToken.current) {
          setBackgroundUrl(null)
          setBackgroundError(errorMessage(cause))
        }
      }
    },
    [background?.path, backgroundUrl],
  )

  /**
   * The splash window decodes the file itself at the next boot, so the shell
   * only validates the selection: a rejected file never reaches the preference
   * and leaves the previous splash in place.
   */
  const changeSplash = useCallback(
    async (next: MediaSettings | null) => {
      const token = ++splashToken.current
      setSplashError(null)
      if (!next) {
        setSplash(null)
        return
      }
      if (next.path !== splash?.path) {
        try {
          await backgroundRead(next.path)
        } catch (cause) {
          if (token === splashToken.current) {
            setSplashError(errorMessage(cause))
          }
          return
        }
      }
      if (token === splashToken.current) {
        setSplash(next)
      }
    },
    [splash?.path],
  )

  const openDiff = (request: Parameters<typeof Workbench>[0]['diffRequest']) => {
    if (view !== 'diff' && navigationGuard.current?.() === false) return
    if (view !== 'diff') setPreviousView(view)
    setDiffRequest(request)
    setView('diff')
  }

  const navigate = useCallback((target: ViewId) => {
    if (navigationGuard.current?.() === false) return false
    setLauncherOpen(false)
    if (target === 'status' || target === 'commit') {
      setView('graph')
      setWorktreeRequest((value) => value + 1)
    } else {
      setView(target)
    }
    setPaletteOpen(false)
    return true
  }, [])
  const openHistoryAction = useCallback((kind: 'stash' | 'rebase' | 'conflicts') => {
    if (navigationGuard.current?.() === false) return
    setLauncherOpen(false)
    setView('graph')
    setHistoryRequest((current) => ({ kind, serial: (current?.serial ?? 0) + 1 }))
    setPaletteOpen(false)
  }, [])

  // Branch creation happens in the commit graph itself; this request is
  // forwarded to the workbench so the inline ref editor opens on HEAD.
  const newBranch = useCallback(() => {
    if (navigationGuard.current?.() === false) return
    setView('graph')
    setBranchRequest((value) => value + 1)
    setPaletteOpen(false)
  }, [])

  /** Opens the in-graph find bar (Mod+F); stays on the history view. */
  const openFindInGraph = useCallback(() => {
    if (!repoId) return
    if (navigationGuard.current?.() === false) return
    setLauncherOpen(false)
    setView('graph')
    setFindRequest((value) => value + 1)
    setPaletteOpen(false)
  }, [repoId])

  const pickCloneDirectory = useCallback(async (defaultPath?: string) => {
    const selected = await openNativeDialog({
      title: t('shell.dialog.cloneDestination'),
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === 'string' ? selected : null
  }, [])

  const pickInitParent = useCallback(async (defaultPath?: string) => {
    const selected = await openNativeDialog({
      title: t('shell.dialog.initParent'),
      directory: true,
      multiple: false,
      defaultPath,
    })
    return typeof selected === 'string' ? selected : null
  }, [])

  const openInitDialog = useCallback(() => setInitDialogOpen(true), [])

  const openLauncher = useCallback(() => {
    setLauncherOpen(true)
    setLauncherFocus((count) => count + 1)
    setPaletteOpen(false)
    void reloadRecent()
  }, [reloadRecent])

  // The launcher behaves like a tab: Escape closes it, as in the benchmark client.
  useEffect(() => {
    if (!launcherOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLauncherOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [launcherOpen])

  const openRepositoryDialog = useCallback(async () => {
    if (pickingRepository.current || busy) return
    pickingRepository.current = true
    setBusy(true)
    setError(null)
    try {
      const path = await openNativeDialog({
        title: t('shell.dialog.openRepo'),
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
    // Commands acting on the history are ranked first while it is open, so the
    // palette opens on what the current view can do.
    const graphContext = Boolean(repoId)
    const items: PaletteCommand[] = navigationGroups.flatMap((group) =>
      group.items.filter((item) => item.id !== 'commit' && item.id !== 'diff').map((item) => ({
        id: `view-${item.id}`,
        label: t('shell.palette.goTo', { view: t(item.labelKey) }),
        group: t(group.labelKey),
        available: !item.requiresRepo || Boolean(repoId),
        unavailableReason: t('shell.palette.unavailable.viewRepo'),
        run: () => navigate(item.id),
      })),
    )
    items.push(
      {
        id: 'action-open-repo',
        label: t('shell.palette.openRepo'),
        group: t('shell.palette.group.actions'),
        shortcut: displayShortcut(shortcuts.openRepo),
        run: () => openRepositoryDialog(),
      },
      {
        id: 'action-launcher',
        label: t('shell.palette.newTab'),
        group: t('shell.palette.group.actions'),
        shortcut: displayShortcut(shortcuts.newTab),
        run: () => openLauncher(),
      },
      {
        id: 'action-refresh',
        label: t('shell.palette.refresh'),
        group: t('shell.palette.group.actions'),
        available: Boolean(repoId),
        unavailableReason: t('shell.palette.unavailable.repo'),
        run: () => void refresh(),
      },
      {
        id: 'action-conflicts',
        label: t('shell.palette.resolveConflicts'),
        group: t('shell.palette.group.actions'),
        available: Boolean(repoId),
        contextual: graphContext,
        run: () => openHistoryAction('conflicts'),
      },
      {
        id: 'action-new-branch',
        label: t('shell.palette.newBranch'),
        group: t('shell.palette.group.git'),
        shortcut: displayShortcut(shortcuts.newBranch),
        available: Boolean(repoId),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.repo'),
        run: newBranch,
      },
      {
        id: 'action-find-in-graph',
        label: t('shell.palette.findInGraph'),
        group: t('shell.palette.group.actions'),
        shortcut: displayShortcut(shortcuts.findInGraph),
        available: Boolean(repoId),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.repo'),
        run: openFindInGraph,
      },
      {
        id: 'action-rebase',
        label: t('shell.palette.rebase'),
        group: t('shell.palette.group.actions'),
        available: Boolean(repoId),
        contextual: graphContext,
        run: () => openHistoryAction('rebase'),
      },
      {
        id: 'action-undo',
        label: undoState?.undo ? undoButtonLabel(undoState.undo, 'undo') : t('shell.palette.undoFallback'),
        group: t('shell.palette.group.git'),
        shortcut: displayShortcut(shortcuts.undo),
        available: Boolean(repoId && undoState?.undo && !undoState.undo.blocked),
        contextual: graphContext,
        unavailableReason: undoState?.undo?.blocked
          ? errorMessage(undoState.undo.blocked)
          : t('shell.palette.unavailable.nothingToUndo'),
        run: () => void performUndo('undo'),
      },
      {
        id: 'action-redo',
        label: undoState?.redo ? undoButtonLabel(undoState.redo, 'redo') : t('shell.palette.redoFallback'),
        group: t('shell.palette.group.git'),
        shortcut: displayShortcut(shortcuts.redo),
        available: Boolean(repoId && undoState?.redo && !undoState.redo.blocked),
        contextual: graphContext,
        unavailableReason: undoState?.redo?.blocked
          ? errorMessage(undoState.redo.blocked)
          : t('shell.palette.unavailable.nothingToRedo'),
        run: () => void performUndo('redo'),
      },
      {
        id: 'action-fetch',
        label: t('shell.palette.fetch'),
        group: t('shell.palette.group.git'),
        available: Boolean(repoId),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.repo'),
        run: () => {
          if (repoId) {
            void syncFetch(repoId, 'origin')
              .then(() => refresh())
              .catch((cause) => setError(errorMessage(cause)))
          }
        },
      },
      {
        id: 'action-fetch-all',
        label: t('shell.palette.fetchAll'),
        group: t('shell.palette.group.git'),
        available: Boolean(repoId),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.repo'),
        run: () => {
          if (repoId) {
            void syncFetchAll(repoId)
              .then(() => refresh())
              .catch((cause) => setError(errorMessage(cause)))
          }
        },
      },
      {
        id: 'action-pull',
        label: t('shell.palette.pull'),
        group: t('shell.palette.group.git'),
        available: Boolean(repoId && repo?.state.head?.kind === 'branch' && repo.state.head.upstream),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.upstream'),
        run: () => {
          if (!repoId || repo?.state.head?.kind !== 'branch' || !repo.state.head.upstream) {
            return
          }
          const [remote, ...rest] = repo.state.head.upstream.split('/')
          const branch = rest.join('/')
          void (
            confirmOperation.current?.({
              title: t('workbench.operationPreview.title.pull', { branch, remote }),
              confirmLabel: t('workbench.operationPreview.action.pull'),
              operation: { kind: 'pull', remote, branch },
            }) ?? Promise.resolve(false)
          )
            .then((confirmed) =>
              confirmed
                ? syncPull({ repoId, remote, branch }).then(() => refresh())
                : undefined,
            )
            .catch((cause) => setError(errorMessage(cause)))
        },
      },
      {
        id: 'action-push',
        label: t('shell.palette.push'),
        group: t('shell.palette.group.git'),
        available: Boolean(repoId && repo?.state.head?.kind === 'branch' && repo.state.head.upstream),
        contextual: graphContext,
        unavailableReason: t('shell.palette.unavailable.upstream'),
        run: () => {
          if (!repoId || repo?.state.head?.kind !== 'branch' || !repo.state.head.upstream) {
            return
          }
          const [remote, ...rest] = repo.state.head.upstream.split('/')
          const branch = rest.join('/')
          void (async () => {
            const preview = await readPushPreview(repoId, remote, branch)
            // The palette shell sits outside the confirmation provider, so it
            // asks the bar itself instead of using the push hook.
            const confirmed =
              preview && !pushNeedsConfirmation(preview)
                ? true
                : await (confirmOperation.current?.({
                    title: t('workbench.operationPreview.title.push', { branch, remote }),
                    confirmLabel: t('workbench.operationPreview.action.push'),
                    operation: { kind: 'push', remote, branch },
                  }) ?? Promise.resolve(false))
            if (!confirmed) return
            await syncPush({ repoId, remote, branch })
            refresh()
          })().catch((cause) => {
            if (isPushRejection(cause)) {
              setPushRejected({ repoId, remote, branch })
              return
            }
            setError(errorMessage(cause))
          })
        },
      },
      {
        id: 'action-theme',
        label: t('shell.palette.toggleTheme'),
        group: t('shell.palette.group.system'),
        run: () => changeTheme(theme === 'light' ? 'dark' : 'light'),
      },
      {
        id: 'action-visual-preview',
        label: t('shell.palette.toggleVisualPreview'),
        group: t('shell.palette.group.system'),
        run: () => changeVisualPreview(visualPreview === 'readable-beta' ? 'off' : 'readable-beta'),
      },
      {
        id: 'action-shortcut-help',
        label: t('common.shortcutHelp.palette'),
        group: t('shell.palette.group.system'),
        shortcut: '?',
        run: () => setShortcutHelpOpen(true),
      },
      {
        id: 'action-settings',
        label: t('shell.palette.settings'),
        group: t('shell.palette.group.system'),
        shortcut: displayShortcut(shortcuts.settings),
        run: () => navigate('profiles'),
      },
      {
        id: 'action-init-repo',
        label: t('shell.palette.createRepo'),
        group: t('shell.palette.group.system'),
        run: () => openInitDialog(),
      },
      {
        id: 'action-close',
        label: t('shell.palette.closeRepo'),
        group: t('shell.palette.group.system'),
        available: Boolean(repoId),
        run: () => repoId && requestClose(repoId),
      },
    )
    for (const workspace of workspaces) {
      const selected = workspace.id === activeWorkspaceId
      const count = workspace.repos.length
      items.push({
        id: `workspace-${workspace.id}`,
        label: selected
          ? plural('shell.palette.workspaceActive.one', 'shell.palette.workspaceActive.other', count, { name: workspace.name })
          : plural('shell.palette.workspace.one', 'shell.palette.workspace.other', count, { name: workspace.name }),
        group: t('shell.palette.group.workspaces'),
        shortcut: displayShortcut(shortcuts.workspaces),
        available: !switching,
        unavailableReason: t('shell.palette.unavailable.workspaceSwitching'),
        run: () => void switchWorkspace(workspace.id),
      })
    }
    favourites.forEach((favourite, slot) => {
      items.push({
        id: `favourite-${favourite.path}`,
        label: t('shell.palette.favourite', {
          name: favourite.name,
          slot: slot + 1,
        }),
        group: t('shell.palette.group.favourites'),
        shortcut: `⌘⌥${slot + 1}`,
        run: () => void openFavourite(slot, favourite),
      })
    })
    const activePath = repo?.repo.worktree ?? null
    const activeName = repo?.repo.name ?? ''
    const activeFavourite = activePath
      ? favourites.some((favourite) => favourite.path === activePath)
      : false
    items.push({
      id: 'action-favourite-toggle',
      label: activeFavourite
        ? t('shell.palette.favouriteRemove', {
            name: activeName || t('shell.palette.favouriteFallback'),
          })
        : t('shell.palette.favouriteAdd', {
            name: activeName || t('shell.palette.favouriteFallback'),
          }),
      group: t('shell.palette.group.favourites'),
      available: Boolean(activePath),
      unavailableReason: t('shell.palette.unavailable.repo'),
      run: () => {
        if (activePath) {
          rememberFavourite({ path: activePath, name: activeName || activePath })
        }
      },
    })
    return items
  }, [navigate, openHistoryAction, openFindInGraph, newBranch, repoId, repo, refresh, requestClose, theme, visualPreview, openRepositoryDialog, openInitDialog, openLauncher, undoState, performUndo, workspaces, activeWorkspaceId, switching, switchWorkspace, shortcuts, locale, view, favourites, openFavourite, rememberFavourite])

  useZoom()

  useShortcuts({
    palette: () => setPaletteOpen(true),
    settings: () => navigate('profiles'),
    newBranch: () => repoId && newBranch(),
    search: () => repoId && navigate('search'),
    findInGraph: openFindInGraph,
    openRepo: () => openRepositoryDialog(),
    newTab: openLauncher,
    // The launcher is the visible tab when open: close it, not the repo behind.
    closeTab: () => {
      if (launcherOpen) setLauncherOpen(false)
      else if (repoId) requestClose(repoId)
    },
    workspaces: () => setWorkspaceMenuOpen(true),
    undo: () => void performUndo('undo'),
    redo: () => void performUndo('redo'),
    close: () => {
      setPaletteOpen(false)
    },
    help: () => setShortcutHelpOpen(true),
  }, shortcuts)

  const showHome =
    !repo && !['profiles', 'gitlab', 'github', 'recovery', 'workspaces'].includes(view)
  // The launcher is a tab of its own: it shows the same start screen as the
  // empty state without closing the repository tabs.
  const showStart = launcherOpen || showHome
  // Repository toolbar and operation banner belong to the open repository,
  // not to the launcher or the application pages (workspaces, forges…).
  const repoChrome = !showStart && !APP_PAGES.includes(view)
  const branch =
    repo?.state.head?.kind === 'branch' ? repo.state.head.name : null

  return (
    <I18nProvider locale={locale} onChange={changeLocale}>
    <ActionBarProvider>
    <OperationConfirmProvider repoId={repoId} store={confirmOperation}>
    <div
      className={styles.app}
      data-toolbar={repoChrome ? undefined : 'hidden'}
      data-background={background && backgroundUrl ? 'image' : undefined}
      style={{ '--sidebar-width': `${layout.sidebar}px` } as CSSProperties}
    >
      {background && backgroundUrl ? (
        <div className={styles.background} aria-hidden="true">
          <div className={styles.backgroundImage} ref={backgroundLayer} />
          <div className={styles.backgroundDim} />
        </div>
      ) : null}
      <a href="#main-content" className="skip-link">
        {t('shell.skipToContent')}
      </a>
      <TopBar
        repos={repos}
        activeId={activeId}
        busy={busy}
        onActivate={(target) => void activate(target)}
        onClose={requestClose}
        onReorder={moveRepo}
        onOpenDialog={() => openRepositoryDialog()}
        launcherOpen={launcherOpen}
        onAdd={openLauncher}
        onCloseLauncher={() => setLauncherOpen(false)}
        onSettings={() => navigate('profiles')}
        updateVersion={availableUpdate}
        updateBusy={installingUpdate}
        onInstallUpdate={() => void installUpdate()}
        user={forgeUser}
        workspaceSelector={
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeId={activeWorkspaceId}
            busy={busy || switching}
            open={workspaceMenuOpen}
            onOpenChange={setWorkspaceMenuOpen}
            onSelect={(workspaceId) => void switchWorkspace(workspaceId)}
            onManage={() => {
              setWorkspaceMenuOpen(false)
              navigate('workspaces')
            }}
            shortcut={shortcuts.workspaces}
          />
        }
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
      {repoChrome ? (
        <RepoBar
          repo={repo}
          repos={repos}
          busy={busy}
          onActivate={(target) => void activate(target)}
          onOpenDialog={openRepositoryDialog}
          onOpenPalette={() => setPaletteOpen(true)}
          onRefresh={() => void refresh()}
          onNavigate={(target) => {
            if (target === 'stash' || target === 'rebase' || target === 'conflicts') openHistoryAction(target)
            else navigate(target)
          }}
          onNewBranch={newBranch}
          onError={setError}
          onPushRejected={setPushRejected}
          undo={undoState?.undo ?? null}
          redo={undoState?.redo ?? null}
          onUndo={() => performUndo('undo')}
          onRedo={() => performUndo('redo')}
        />
      ) : null}
      <div className={styles.body} data-repository={Boolean(repo) && !showStart}>
        {visualPreview === 'readable-beta' ? (
          <div className={styles.visualPreviewBar} role="status">
            <span>{t('shell.visualPreview.banner')}</span>
            <button
              type="button"
              onClick={() => changeVisualPreview('off')}
              aria-label={t('shell.visualPreview.disableAria')}
            >
              {t('shell.visualPreview.disable')}
            </button>
          </div>
        ) : null}
        {!repo || showStart ? <Sidebar
          active={view}
          repoName={repo?.repo.name ?? null}
          branch={branch}
          conflicts={repo?.state.conflicts.files.length ?? 0}
          stashes={stashCount}
          mergeRequests={0}
          gitlabConnected={gitlabConnected}
          githubConnected={githubConnected}
          version="0.4.0"
          onSelect={navigate}
        /> : null}
        <main id="main-content" tabIndex={-1} className={styles.main} aria-busy={busy}>
          {!repo || showStart ? <Resizer
            className={styles.sidebarResizer}
            label={t('shell.resizer.navigation')}
            side="right"
            value={layout.sidebar}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            onChange={(sidebar) => changeLayout({ sidebar })}
            onReset={() => changeLayout({ sidebar: 210 })}
          /> : null}
          <div className={`${styles.viewbar} ${repo && !showStart ? styles.compactViewbar : ''}`}>
            {view === 'diff' ? <button type="button" className={styles.back} onClick={() => navigate(previousView)}>{t('shell.viewbar.back')}</button> : null}
            <div className={styles.viewHeading}>
              <h1>{showStart ? t('shell.welcome') : t(VIEW_LABELS[view])}</h1>
              {!showStart && viewDescriptions[view] ? (
                <p>{t(viewDescriptions[view]!)}</p>
              ) : null}
            </div>
            {repo ? (
              <span className={styles.crumb}>{repo.repo.name}</span>
            ) : null}
            <span className={styles.spacer} />

            {busy ? <span className={styles.busy}>{t('shell.viewbar.working')}</span> : null}
          </div>

          <ActionBarSlot />

          {repo && repoChrome &&
          (repo.state.operation || repo.state.conflicts.files.length > 0) ? (
            <div className={styles.intermediate} role="status">
              <span>
                {t('shell.operation.inProgress')}{' '}
                {repo.state.operation
                  ? repo.state.operation.kind === 'rebase'
                    ? t('shell.operation.rebaseVariant', { variant: repo.state.operation.variant })
                    : repo.state.operation.kind
                  : t('shell.operation.conflicts')}
                {repo.state.conflicts.files.length > 0
                  ? ` · ${plural('shell.operation.conflictFiles.one', 'shell.operation.conflictFiles.other', repo.state.conflicts.files.length)}`
                  : ''}
              </span>
              <button type="button" onClick={() => openHistoryAction('conflicts')}>
                {repo.state.conflicts.files.length > 0
                  ? t('shell.operation.resolve')
                  : t('shell.operation.manage')}
              </button>
            </div>
          ) : null}

          <div className={styles.workspace} data-page={view}>
            {showStart ? (
              <Home
                onOpenDialog={() => openRepositoryDialog()}
                onSelect={navigate}
                recent={recent}
                focusRequest={launcherFocus}
                onOpen={(path) => void openRepo(path)}
                onClone={cloneRepo}
                onCreate={openInitDialog}
                onPickDirectory={pickCloneDirectory}
                favourites={favourites}
                onOpenFavourite={(slot) => {
                  const favourite = favourites[slot]
                  if (favourite) {
                    void openFavourite(slot, favourite)
                  }
                }}
                onToggleFavourite={rememberFavourite}
                onMoveFavourite={reorderFavourite}
              />
            ) : (
              <Workbench
                key={repo?.repo.repoId ?? 'no-repo'}
                repo={repo}
                generation={repo?.generation ?? generation}
                view={view}
                worktreeRequest={worktreeRequest}
                branchRequest={branchRequest}
                findRequest={findRequest}
                historyRequest={historyRequest}
                diffRequest={diffRequest}
                onOpenDiff={openDiff}
                onOpenRepo={(path) => void openRepo(path)}
                onMutated={() => void refresh()}
                undoTop={undoState?.undo ?? null}
                onUndo={(expectedId) => performUndo('undo', expectedId)}
                onNavigate={navigate}
                onRegisterNavigationGuard={registerNavigationGuard}
                gitlabConnected={gitlabConnected}
                githubConnected={githubConnected}
                theme={theme}
                onThemeChange={changeTheme}
                density={density}
                onDensityChange={changeDensity}
                visualPreview={visualPreview}
                onVisualPreviewChange={changeVisualPreview}
                background={background}
                backgroundError={backgroundError}
                onBackgroundChange={(next) => void changeBackground(next)}
                splash={splash}
                splashError={splashError}
                onSplashChange={(next) => void changeSplash(next)}
                shortcuts={shortcuts}
                shortcutConflict={shortcutConflict}
                onShortcutsChange={(next) => {
                  setShortcuts(next)
                  void preferenceSet(SHORTCUTS_KEY, JSON.stringify(next))
                }}
                layout={layout}
                onLayoutChange={changeLayout}
                activeWorkspaceId={activeWorkspaceId}
                onActivateWorkspace={(workspaceId) => void switchWorkspace(workspaceId)}
                onWorkspacesChanged={setWorkspaces}
                onPushRejected={setPushRejected}
              />
            )}
          </div>
        </main>
      </div>
      <StatusBar
        repo={repo}
        gitlabConnected={gitlabConnected}
        githubConnected={githubConnected}
        lastOperation={undoState?.undo ? undoActionLabel(undoState.undo) : null}
        canUndo={Boolean(undoState?.undo && !undoState.undo.blocked)}
        onNavigate={navigate}
        onCheckoutBranch={checkoutBranch}
        onNewBranch={newBranch}
        onUndo={() => void performUndo('undo')}
        onError={setError}
      />

      {initDialogOpen ? <InitRepoDialog
        busy={busy}
        defaultParent={initParent}
        onClose={() => setInitDialogOpen(false)}
        onCreate={initRepo}
        onPickParent={pickInitParent}
      /> : null}
      <PushRejectedBar
        rejection={pushRejected}
        onClose={() => setPushRejected(null)}
        onDone={() => void refresh()}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ShortcutHelp
        open={shortcutHelpOpen}
        shortcuts={shortcuts}
        onClose={() => setShortcutHelpOpen(false)}
      />
      <ConfirmBar
        open={pendingClose !== null}
        title={t('shell.closeTab.title')}
        consequence={
          pendingClose?.state.operation
            ? t('shell.closeTab.operation', {
                repo: pendingClose.repo.name,
                operation: pendingClose.state.operation.kind,
              })
            : t('shell.closeTab.conflicts', { repo: pendingClose?.repo.name ?? '' })
        }
        irreversible
        confirmLabel={t('shell.closeTab.confirmLabel')}
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
    </OperationConfirmProvider>
    </ActionBarProvider>
    </I18nProvider>
  )
}
