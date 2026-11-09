import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { save as saveNativeDialog } from '@tauri-apps/plugin-dialog'
import {
  conflictMarkResolved,
  diffGet,
  fileDelete,
  indexDiscard,
  indexIgnore,
  indexStage,
  indexUnstage,
  patchCreate,
  patchSave,
  pathOpen,
  preferenceGet,
  preferenceSet,
  stashCreate,
  statusGet,
  toolOpen,
  type DiffRequest,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { t, useI18n } from '../i18n'
import { buildFileTree, flattenFileTree, type FileTreeRow } from '../lib/fileTree'
import { splitPath } from '../lib/paths'
import type { Fingerprint, StatusEntry, StatusReport } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { FileStatusIcon } from './FileStatusIcon'
import { ConfirmBar } from './ConfirmBar'
import { ContextMenu, ContextSubmenu } from './ContextMenu'
import styles from './RepoStatus.module.css'

type Props = {
  repoId: string
  generation: number
  locks: string[]
  onSelectDiff: (request: DiffRequest) => void
  onMutated: () => void
  onNavigate: (view: 'commit' | 'sync' | 'stash' | 'conflicts') => void
  /** Opens the file in the in-app editor of the central preview. */
  onEditFile: (path: string) => void
  onShowHistory: (path: string) => void
  selectedPath?: string
}

const MAX_ROWS = 500

function entrySelectionKey(staged: boolean, path: string): string {
  return `${staged ? 'index' : 'worktree'}:${path}`
}

/** Files the group header can select: the ones actually listed, not the overflow. */
function groupSelectionKeys(group: { entries: StatusEntry[]; staged: boolean }): string[] {
  return group.entries.slice(0, MAX_ROWS).map((entry) => entrySelectionKey(group.staged, entry.path))
}

/** Persisted display mode of the file lists: flat paths or a directory tree. */
const FILE_VIEW_KEY = 'ui.status.view'

type FileView = 'path' | 'tree'

function entryLabel(entry: StatusEntry): string {
  switch (entry.kind) {
    case 'untracked':
      return t('status.entry.untracked')
    case 'unmerged':
      return t('status.entry.unmerged')
    case 'renamed':
      return t('status.entry.renamed')
    case 'copied':
      return t('status.entry.copied')
    case 'ignored':
      return t('status.entry.ignored')
    default:
      return `${entry.index}${entry.worktree}`
  }
}

function extPattern(path: string): string | null {
  const name = path.split('/').pop() ?? ''
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) {
    return null
  }
  return `*${name.slice(index)}`
}

/**
 * `.gitignore` patterns covering `path`, most specific first. A leading `/`
 * anchors the pattern at the repository root; a bare name matches anywhere.
 */
function ignoreChoices(path: string): { key: string; pattern: string; kind: 'file' | 'name' | 'extension' | 'folder' }[] {
  const segments = path.split('/')
  const name = segments.pop() ?? path
  const choices: { key: string; pattern: string; kind: 'file' | 'name' | 'extension' | 'folder' }[] = [
    { key: 'ignore-file', pattern: `/${path}`, kind: 'file' },
    { key: 'ignore-name', pattern: name, kind: 'name' },
  ]
  const extension = extPattern(path)
  if (extension) {
    choices.push({ key: 'ignore-extension', pattern: extension, kind: 'extension' })
  }
  for (let depth = segments.length; depth > 0; depth -= 1) {
    choices.push({ key: `ignore-folder-${depth}`, pattern: `/${segments.slice(0, depth).join('/')}/`, kind: 'folder' })
  }
  return choices
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

/** Text caret keys stay in the field; checkboxes and the status filter do not. */
function isTypingField(target: EventTarget | null, filter: HTMLInputElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === filter) {
    return false
  }
  if (target instanceof HTMLInputElement) {
    return target.type !== 'checkbox' && target.type !== 'radio' && target.type !== 'button'
      && target.type !== 'submit' && target.type !== 'reset'
  }
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable
}

type PendingIgnore = {
  entry: StatusEntry
  pattern: string
}

type PendingDiscard = {
  entries: StatusEntry[]
  expected: Fingerprint[]
}

/** One entry of the row `···` popover and of the right-click menu. */
type RowAction = {
  key: string
  label: string
  danger?: boolean
  disabled?: boolean
  dividerBefore?: boolean
  run: () => void
  /** Opens a submenu in the right-click menu; listed inline in the popover. */
  children?: RowAction[]
}

type FileMenu = {
  x: number
  y: number
  entry: StatusEntry
  staged: boolean
}

export function RepoStatus({
  repoId,
  generation,
  locks,
  onSelectDiff,
  onMutated,
  onNavigate,
  onEditFile,
  onShowHistory,
  selectedPath,
}: Props) {
  const { t, plural } = useI18n()
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [fileView, setFileView] = useState<FileView>('path')
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const [refresh, setRefresh] = useState(0)
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StatusEntry | null>(null)
  const [pendingIgnore, setPendingIgnore] = useState<PendingIgnore | null>(null)
  const [fileMenu, setFileMenu] = useState<FileMenu | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [flashPaths, setFlashPaths] = useState<Set<string>>(() => new Set())
  const selectionAnchor = useRef<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const fileListRef = useRef<HTMLDivElement>(null)
  const navCursorRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void statusGet(repoId, undefined, includeIgnored)
      .then((statusResult) => {
        if (cancelled) {
          return
        }
        setStatus(statusResult.data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation, refresh, includeIgnored])

  useEffect(() => {
    let cancelled = false
    void preferenceGet(FILE_VIEW_KEY)
      .then((value) => {
        if (!cancelled && value === 'tree') {
          setFileView('tree')
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const chooseView = (next: FileView) => {
    setFileView(next)
    void preferenceSet(FILE_VIEW_KEY, next).catch(() => undefined)
  }

  const entries = useMemo(() => {
    if (!status) {
      return []
    }
    const needle = filter.trim().toLowerCase()
    return status.entries.filter((entry) =>
      needle.length === 0 ? true : entry.path.toLowerCase().includes(needle),
    )
  }, [status, filter])

  const groups = useMemo(() => [
    { id: 'conflicts', label: t('status.group.conflicts'), entries: entries.filter((e) => e.kind === 'unmerged'), staged: false },
    { id: 'worktree', label: t('status.group.worktree'), entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'ignored' && (e.kind === 'untracked' || e.worktree !== '.')), staged: false },
    { id: 'index', label: t('status.group.index'), entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'untracked' && e.kind !== 'ignored' && e.index !== '.'), staged: true },
    { id: 'ignored', label: t('status.group.ignored'), entries: entries.filter((e) => e.kind === 'ignored'), staged: false },
  ], [entries, t])

  /** Ignored paths may name directories (`build/`), so they stay a flat list. */
  const trees = useMemo(() => {
    if (fileView !== 'tree') {
      return null
    }
    const built = new Map<string, FileTreeRow<StatusEntry>[]>()
    for (const group of groups) {
      if (group.id === 'ignored') {
        continue
      }
      built.set(
        group.id,
        flattenFileTree(
          buildFileTree(group.entries.slice(0, MAX_ROWS)),
          collapsedDirs,
          `${group.id}:`,
        ),
      )
    }
    return built
  }, [groups, fileView, collapsedDirs])

  const selectableEntries = useMemo(
    () => groups
      .filter((group) => group.id === 'worktree' || group.id === 'index')
      .flatMap((group) => group.entries.map((entry) => ({
        key: `${group.staged ? 'index' : 'worktree'}:${entry.path}`,
        entry,
        staged: group.staged,
      }))),
    [groups],
  )
  /** Row order as displayed, so Maj+clic spans what the user sees. */
  const selectionOrder = useMemo(() => {
    if (!trees) {
      return selectableEntries
    }
    return groups.flatMap((group) => {
      if (group.id !== 'worktree' && group.id !== 'index') {
        return []
      }
      return (trees.get(group.id) ?? []).flatMap((row) =>
        row.kind === 'file'
          ? [{
              key: `${group.staged ? 'index' : 'worktree'}:${row.item.path}`,
              entry: row.item,
              staged: group.staged,
            }]
          : [],
      )
    })
  }, [trees, groups, selectableEntries])

  /**
   * Display order of every file and folder row, so ↑/↓ move between files
   * instead of the checkbox, +/− or ··· of the current row.
   */
  const navRows = useMemo(() => {
    const rows: Array<
      | { key: string; kind: 'file'; entry: StatusEntry; staged: boolean }
      | { key: string; kind: 'dir'; dirKey: string; open: boolean }
    > = []
    for (const group of groups) {
      if (group.entries.length === 0 && (group.id === 'conflicts' || group.id === 'ignored' || !status || status.entries.length === 0)) {
        continue
      }
      const treeRows = trees?.get(group.id)
      if (treeRows) {
        for (const row of treeRows) {
          if (row.kind === 'dir') {
            rows.push({ key: `dir:${row.key}`, kind: 'dir', dirKey: row.key, open: row.open })
          } else {
            rows.push({
              key: `${group.staged ? 'index' : 'worktree'}:${row.item.path}`,
              kind: 'file',
              entry: row.item,
              staged: group.staged,
            })
          }
        }
      } else {
        for (const entry of group.entries.slice(0, MAX_ROWS)) {
          rows.push({
            key: `${group.staged ? 'index' : 'worktree'}:${entry.path}`,
            kind: 'file',
            entry,
            staged: group.staged,
          })
        }
      }
    }
    return rows
  }, [groups, trees, status])
  const selectedEntries = useMemo(
    () => selectableEntries.filter((item) => selectedKeys.has(item.key)),
    [selectableEntries, selectedKeys],
  )
  const selectionIndex = useMemo(
    () => new Map(selectionOrder.map((item, index) => [item.key, index])),
    [selectionOrder],
  )

  const markFlash = (paths: string[]) => {
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current)
    }
    setFlashPaths(new Set(paths))
    flashTimer.current = window.setTimeout(() => {
      setFlashPaths(new Set())
      flashTimer.current = null
    }, 320)
  }

  useEffect(() => () => {
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current)
    }
  }, [])

  const navRowsRef = useRef(navRows)
  navRowsRef.current = navRows
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const onSelectDiffRef = useRef(onSelectDiff)
  onSelectDiffRef.current = onSelectDiff

  const select = (entry: StatusEntry, staged: boolean) => {
    navCursorRef.current = `${staged ? 'index' : 'worktree'}:${entry.path}`
    onSelectDiffRef.current({
      target: staged ? 'index' : 'worktree', path: entry.path,
      untracked: entry.kind === 'untracked', allowActions: entry.kind !== 'unmerged',
    })
  }
  const toggleDir = (key: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const focusNavRow = (row: (typeof navRows)[number]) => {
    navCursorRef.current = row.key
    const root = fileListRef.current
    if (!root) {
      return
    }
    const current = root.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(row.key)}"]`)
    const focusable = current?.querySelector<HTMLElement>('[data-nav-focus]:not(:disabled)') ?? current
    focusable?.focus()
    focusable?.scrollIntoView({ block: 'nearest' })
    if (row.kind === 'file' && row.entry.kind !== 'ignored' && row.entry.kind !== 'unmerged') {
      select(row.entry, row.staged)
    }
  }

  const navIndexOf = (target: EventTarget | null) => {
    const rows = navRowsRef.current
    if (target instanceof HTMLElement) {
      const key = target.closest<HTMLElement>('[data-nav-key]')?.dataset.navKey
      if (key) {
        const index = rows.findIndex((row) => row.key === key)
        if (index >= 0) {
          return index
        }
      }
    }
    if (navCursorRef.current) {
      const index = rows.findIndex((row) => row.key === navCursorRef.current)
      if (index >= 0) {
        return index
      }
    }
    const selected = selectedPathRef.current
    if (selected) {
      const index = rows.findIndex((row) => row.kind === 'file' && row.entry.path === selected)
      if (index >= 0) {
        return index
      }
    }
    return -1
  }

  // Capture at the window so ↑/↓ stay in this list even after the diff, the
  // graph canvas or <main> has taken focus (their yellow ring would otherwise
  // swallow the next arrow).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.defaultPrevented) {
        return
      }
      if (document.querySelector('[popover]:popover-open, [role="menu"], [role="dialog"], [role="alertdialog"]')) {
        return
      }
      const filter = filterRef.current
      const inFilter = event.target === filter
      if (isTypingField(event.target, filter)) {
        return
      }
      const rows = navRowsRef.current
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        if (rows.length === 0) {
          return
        }
        // Home/End keep their caret behaviour in the filter; only ↓ opens the list.
        if (inFilter && event.key !== 'ArrowDown') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const index = navIndexOf(event.target)
        const nextIndex = event.key === 'Home' || (inFilter && event.key === 'ArrowDown')
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : index < 0
              ? event.key === 'ArrowDown' ? 0 : rows.length - 1
              : event.key === 'ArrowUp' && index === 0
                ? -1
                : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        if (nextIndex < 0) {
          filter?.focus()
          return
        }
        const row = rows[nextIndex]
        if (row) {
          focusNavRow(row)
        }
        return
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !inFilter) {
        const row = rows[navIndexOf(event.target)]
        if (row?.kind !== 'dir') {
          return
        }
        const shouldOpen = event.key === 'ArrowRight'
        if (row.open === shouldOpen) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        navCursorRef.current = row.key
        toggleDir(row.dirKey)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      setRefresh((value) => value + 1)
      onMutated()
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const entryPaths = (entry: StatusEntry): string[] =>
    entry.origPath ? [entry.origPath, entry.path] : [entry.path]

  const stage = (entry: StatusEntry) => {
    markFlash(entryPaths(entry))
    return run(t('status.notice.staged', { path: entry.path }), () =>
      indexStage(
        repoId,
        entryPaths(entry).map((path) => ({ path, hunks: [] })),
      ),
    )
  }

  const unstage = (entry: StatusEntry) => {
    markFlash(entryPaths(entry))
    return run(t('status.notice.unstaged', { path: entry.path }), () =>
      indexUnstage(
        repoId,
        entryPaths(entry).map((path) => ({ path, hunks: [] })),
      ),
    )
  }

  const requestDiscard = async (selected: StatusEntry[]) => {
    setError(null)
    const eligible = selected.filter(
      (entry) => entry.kind !== 'untracked' && entry.kind !== 'unmerged',
    )
    if (eligible.length === 0) {
      setError(t('status.error.discardUnsupported'))
      return
    }
    try {
      const reports = await Promise.all(
        eligible.map((entry) =>
          diffGet(repoId, { target: 'worktree', path: entry.path }),
        ),
      )
      const expected = eligible.map((entry, index) => {
        const file = reports[index]?.data.files[0]
        return file?.fingerprint
          ? { path: entry.path, sha256: file.fingerprint }
          : { path: entry.path }
      })
      setPendingDiscard({ entries: eligible, expected })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const confirmDiscard = async () => {
    if (!pendingDiscard) {
      return
    }
    const target = pendingDiscard
    const label = target.entries.length === 1
      ? t('status.notice.discardOne', { path: target.entries[0]!.path })
      : t('status.notice.discardMany', { count: target.entries.length })
    await run(label, () =>
      indexDiscard(
        repoId,
        target.entries.map((entry) => ({ path: entry.path, hunks: [] })),
        target.expected,
        { acknowledged: true },
      ),
    )
    setPendingDiscard(null)
    setSelectedKeys(new Set())
  }

  const ignore = (pattern: string, untrack: string[] = []) =>
    run(
      untrack.length > 0
        ? t('status.notice.ignoredUntracked', { pattern })
        : t('status.notice.ignored', { pattern }),
      () => indexIgnore(repoId, pattern, untrack),
    )

  /** A tracked file stays tracked despite `.gitignore`: confirm untracking it. */
  const requestIgnore = (entry: StatusEntry, pattern: string) => {
    if (entry.kind === 'untracked') {
      void ignore(pattern)
    } else {
      setPendingIgnore({ entry, pattern })
    }
  }

  const confirmIgnore = async () => {
    if (!pendingIgnore) {
      return
    }
    // Only the current path: a rename source is no longer in the index.
    await ignore(pendingIgnore.pattern, [pendingIgnore.entry.path])
    setPendingIgnore(null)
  }

  const openTool = (entry: StatusEntry, kind: 'editor' | 'merge') =>
    run(
      kind === 'merge'
        ? t('status.notice.mergeTool', { path: entry.path })
        : t('status.notice.editor', { path: entry.path }),
      () => toolOpen({ repoId, kind, path: entry.path }),
    )

  /** The external tool compares the worktree file with the side shown. */
  const openDiffTool = (entry: StatusEntry, staged: boolean) =>
    run(t('status.notice.diffTool', { path: entry.path }), () =>
      toolOpen({
        repoId,
        kind: 'diff',
        path: entry.path,
        base: entry.kind === 'untracked' ? 'empty' : staged ? 'head' : 'index',
      }),
    )

  const openPath = (entry: StatusEntry, reveal: boolean) =>
    run(
      reveal
        ? t('status.notice.revealed', { path: entry.path })
        : t('status.notice.opened', { path: entry.path }),
      () => pathOpen({ repoId, path: entry.path, reveal }),
    )

  const stashFile = (entry: StatusEntry) => {
    markFlash(entryPaths(entry))
    return run(t('status.notice.stashed', { path: entry.path }), () =>
      stashCreate({
        repoId,
        includeUntracked: entry.kind === 'untracked',
        paths: entryPaths(entry),
      }),
    )
  }

  const createPatch = async (entry: StatusEntry, staged: boolean) => {
    setError(null)
    setNotice(null)
    try {
      const patch = await patchCreate({
        repoId,
        source: { kind: staged ? 'index' : 'worktree', paths: entryPaths(entry) },
      })
      if (!patch.text.trim()) {
        setError(t('status.error.emptyPatch'))
        return
      }
      const name = entry.path.split('/').pop() ?? 'changes'
      const path = await saveNativeDialog({ defaultPath: `${name}.patch` })
      if (!path) {
        return
      }
      await patchSave(path, patch.text)
      setNotice(t('status.notice.patchSaved', { path }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const resolve = (entry: StatusEntry) =>
    run(t('status.notice.resolved', { path: entry.path }), () =>
      conflictMarkResolved(repoId, entry.path),
    )

  if (error && !status) {
    return (
      <div className={styles.error} role="alert">
        {error}
      </div>
    )
  }
  if (!status) {
    return <div className={styles.loading}>{loading ? t('status.loading') : t('status.empty')}</div>
  }

  const copyPath = async (entry: StatusEntry) => {
    setError(null)
    try {
      await navigator.clipboard.writeText(entry.path)
      setNotice(t('status.notice.copiedPath', { path: entry.path }))
    } catch {
      setError(t('status.error.clipboardUnavailable'))
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) {
      return
    }
    const ok = await run(t('status.notice.deleted', { path: target.path }), () =>
      fileDelete(repoId, target.path, { acknowledged: true }),
    )
    if (ok) {
      setSelectedKeys((current) => {
        const next = new Set(current)
        next.delete(`worktree:${target.path}`)
        next.delete(`index:${target.path}`)
        return next
      })
    }
    setPendingDelete(null)
  }

  /**
   * The single source of truth for both entry points: the row `···` popover
   * and the right-click menu. `ignored` paths may be directories (`build/`),
   * which the backend never deletes recursively.
   */
  const rowActions = (entry: StatusEntry, staged: boolean): RowAction[] => {
    const actions: RowAction[] = []
    const isDirectory = entry.path.endsWith('/')
    const unmerged = entry.kind === 'unmerged'
    const ignored = entry.kind === 'ignored'
    const untracked = entry.kind === 'untracked'
    // A deleted file has no worktree copy to open, edit or reveal.
    const onDisk = !isDirectory && entry.worktree !== 'D' && !(staged && entry.index === 'D')
    const changes = !ignored && !unmerged && !entry.submodule
    let divider = false
    const group = () => {
      divider = actions.length > 0
    }
    const push = (action: RowAction) => {
      actions.push(divider ? { ...action, dividerBefore: true } : action)
      divider = false
    }

    if (unmerged) {
      push({ key: 'resolve', label: t('status.row.resolve'), disabled: busy, run: () => onNavigate('conflicts') })
      push({ key: 'merge-tool', label: t('status.row.mergeTool'), disabled: busy, run: () => void openTool(entry, 'merge') })
      push({ key: 'mark-resolved', label: t('status.row.markResolved'), disabled: busy, run: () => void resolve(entry) })
    } else if (!ignored) {
      push(staged
        ? { key: 'unstage', label: t('status.row.unstageMenu'), disabled: busy, run: () => void unstage(entry) }
        : { key: 'stage', label: t('status.row.stageMenu'), disabled: busy, run: () => void stage(entry) })
    }
    if (changes && !isDirectory) {
      push({
        key: 'ignore',
        label: t('status.row.ignoreMenu'),
        disabled: busy,
        run: () => undefined,
        children: ignoreChoices(entry.path).map((choice) => ({
          key: choice.key,
          label: choice.kind === 'file'
            ? t('status.row.ignoreThisFile', { pattern: choice.pattern })
            : choice.kind === 'name'
              ? t('status.row.ignoreName', { pattern: choice.pattern })
              : choice.kind === 'extension'
                ? t('status.row.ignoreExtension', { pattern: choice.pattern })
                : t('status.row.ignoreFolder', { pattern: choice.pattern }),
          disabled: busy,
          run: () => requestIgnore(entry, choice.pattern),
        })),
      })
      push({ key: 'stash', label: t('status.row.stashFile'), disabled: busy, run: () => void stashFile(entry) })
    }
    if (!staged && entry.kind === 'ordinary') {
      push({ key: 'discard', label: t('status.row.discardAction'), danger: true, disabled: busy, run: () => void requestDiscard([entry]) })
    }

    group()
    if (changes && onDisk) {
      push({ key: 'diff-tool', label: t('status.row.diffTool'), disabled: busy, run: () => void openDiffTool(entry, staged) })
    }
    if (onDisk) {
      push({ key: 'editor', label: t('status.row.openEditor'), disabled: busy, run: () => void openTool(entry, 'editor') })
      push({ key: 'open-default', label: t('status.row.openDefault'), disabled: busy, run: () => void openPath(entry, false) })
    }
    if (!isDirectory || ignored) {
      push({
        key: 'reveal',
        label: IS_MAC ? t('status.row.revealFinder') : t('status.row.revealFiles'),
        disabled: busy || (!onDisk && !isDirectory),
        run: () => void openPath(entry, true),
      })
    }

    group()
    push({ key: 'copy-path', label: t('status.row.copyPath'), run: () => void copyPath(entry) })
    if (changes && !untracked && !isDirectory) {
      push({ key: 'patch', label: t('status.row.createPatch'), disabled: busy, run: () => void createPatch(entry, staged) })
    }
    if (!untracked && !ignored && !isDirectory) {
      push({ key: 'history', label: t('status.row.fileHistory'), run: () => onShowHistory(entry.path) })
    }

    group()
    if (onDisk && !entry.submodule) {
      push({ key: 'edit', label: t('status.row.editFile'), disabled: busy, run: () => onEditFile(entry.path) })
    }
    if (!isDirectory && !entry.submodule && !unmerged) {
      push({ key: 'delete', label: t('status.row.deleteAction'), danger: true, disabled: busy, run: () => setPendingDelete(entry) })
    }
    return actions
  }

  const menuItems = (entry: StatusEntry, staged: boolean, variant: 'popover' | 'context') =>
    rowActions(entry, staged).map((action) => {
      const separator = action.dividerBefore ? <div className={styles.menuSeparator} role="separator" /> : null
      if (variant === 'popover') {
        const items = action.children ?? [action]
        return (
          <Fragment key={action.key}>
            {separator}
            {items.map((item) => (
              <button key={item.key} type="button" className={item.danger ? styles.danger : undefined}
                disabled={item.disabled} onClick={item.run}>{item.label}</button>
            ))}
          </Fragment>
        )
      }
      const button = (item: RowAction) => (
        <button key={item.key} type="button" role="menuitem"
          className={item.danger ? `${styles.menuAction} ${styles.danger}` : styles.menuAction}
          disabled={item.disabled} onClick={() => {
            setFileMenu(null)
            item.run()
          }}>{item.label}</button>
      )
      return (
        <Fragment key={action.key}>
          {separator}
          {action.children ? (
            <ContextSubmenu label={action.label} className={styles.menuAction} disabled={action.disabled}>
              <div className={styles.menuActions}>{action.children.map(button)}</div>
            </ContextSubmenu>
          ) : button(action)}
        </Fragment>
      )
    })

  const toggleSelection = (key: string, shiftKey: boolean) => {
    const index = selectionIndex.get(key)
    if (index === undefined) {
      return
    }
    setSelectedKeys((current) => {
      const next = new Set(current)
      const anchor = selectionAnchor.current
      const anchorIndex = anchor === null ? undefined : selectionIndex.get(anchor)
      if (shiftKey && anchorIndex !== undefined) {
        const selecting = !current.has(key)
        const start = Math.min(anchorIndex, index)
        const end = Math.max(anchorIndex, index)
        for (let position = start; position <= end; position += 1) {
          const item = selectionOrder[position]
          if (!item) {
            continue
          }
          if (selecting) {
            next.add(item.key)
          } else {
            next.delete(item.key)
          }
        }
      } else if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
    selectionAnchor.current = key
  }
  const bulkStage = async () => {
    const targets = selectedEntries.filter((item) => !item.staged)
    if (targets.length === 0) {
      return
    }
    const paths = [...new Set(targets.flatMap((item) => entryPaths(item.entry)))]
    markFlash(paths)
    const ok = await run(
      plural('status.bulk.staged.one', 'status.bulk.staged.other', targets.length, { count: targets.length }),
      () => indexStage(repoId, paths.map((path) => ({ path, hunks: [] }))),
    )
    if (ok) {
      setSelectedKeys(new Set())
    }
  }
  const bulkUnstage = async () => {
    const targets = selectedEntries.filter((item) => item.staged)
    if (targets.length === 0) {
      return
    }
    const paths = [...new Set(targets.flatMap((item) => entryPaths(item.entry)))]
    markFlash(paths)
    const ok = await run(
      plural('status.bulk.unstaged.one', 'status.bulk.unstaged.other', targets.length, { count: targets.length }),
      () => indexUnstage(repoId, paths.map((path) => ({ path, hunks: [] }))),
    )
    if (ok) {
      setSelectedKeys(new Set())
    }
  }
  const discardableSelection = selectedEntries.filter(
    (item) =>
      !item.staged &&
      item.entry.kind !== 'untracked' &&
      item.entry.kind !== 'unmerged',
  )
  const canDiscardSelection =
    selectedEntries.length > 0 && discardableSelection.length === selectedEntries.length
  const toggleGroupSelection = (group: { entries: StatusEntry[]; staged: boolean }) => {
    const keys = groupSelectionKeys(group)
    setSelectedKeys((current) => {
      const next = new Set(current)
      const allSelected = keys.length > 0 && keys.every((key) => next.has(key))
      for (const key of keys) {
        if (allSelected) {
          next.delete(key)
        } else {
          next.add(key)
        }
      }
      return next
    })
    selectionAnchor.current = keys[0] ?? null
  }
  /**
   * With nothing checked, prepare or unstage the whole group. With a
   * selection, keep the unchecked files out of the operation.
   */
  const stageGroup = async (group: { entries: StatusEntry[]; staged: boolean }) => {
    const keys = groupSelectionKeys(group)
    const selectedInGroup = keys.filter((key) => selectedKeys.has(key))
    const selectedSet = new Set(selectedInGroup)
    const coversEveryEntry = group.entries.length > 0
      && group.entries.every((entry) => selectedSet.has(entrySelectionKey(group.staged, entry.path)))
    const partial = selectedInGroup.length > 0 && !coversEveryEntry
    const targets = partial
      ? group.entries.filter((entry) => selectedSet.has(entrySelectionKey(group.staged, entry.path)))
      : group.entries
    if (targets.length === 0) {
      return
    }
    const paths = [...new Set(targets.flatMap(entryPaths))]
    markFlash(paths)
    const label = partial
      ? plural(
          group.staged ? 'status.bulk.unstaged.one' : 'status.bulk.staged.one',
          group.staged ? 'status.bulk.unstaged.other' : 'status.bulk.staged.other',
          targets.length,
          { count: targets.length },
        )
      : group.staged
        ? t('status.group.unstageAll')
        : t('status.group.stageAll')
    const ok = await run(label, () =>
      (group.staged ? indexUnstage : indexStage)(repoId, paths.map((path) => ({ path, hunks: [] }))))
    if (ok && selectedInGroup.length > 0) {
      setSelectedKeys((current) => {
        const next = new Set(current)
        for (const key of selectedInGroup) {
          next.delete(key)
        }
        return next
      })
    }
  }
  const fileRow = (entry: StatusEntry, staged: boolean, selectable: boolean, depth: number) => {
    const selectionKey = entrySelectionKey(staged, entry.path)
    const { directory, name } = splitPath(entry.path)
    const mark = entry.kind === 'untracked' ? 'N' : entry.kind === 'unmerged' ? '!' : staged ? entry.index : entry.worktree
    return (
      <div key={entry.path} className={styles.fileRow}
        style={depth > 0 ? { paddingLeft: 10 + depth * 12 } : undefined}
        data-nav-key={selectionKey}
        tabIndex={entry.kind === 'ignored' ? -1 : undefined}
        data-selected={entry.path === selectedPath} data-checked={selectedKeys.has(selectionKey)} data-flash={flashPaths.has(entry.path)}
        data-menu={fileMenu?.entry.path === entry.path && fileMenu.staged === staged}
        onContextMenu={(event) => {
          event.preventDefault()
          setFileMenu({ x: event.clientX, y: event.clientY, entry, staged })
        }}>
        <input
          type="checkbox"
          className={`${styles.select} ${styles.rowTool}`}
          checked={selectedKeys.has(selectionKey)}
          disabled={!selectable || busy}
          aria-label={t('status.row.select', { path: entry.path })}
          title={selectable ? t('status.row.selectRange', { path: entry.path }) : undefined}
          onChange={(event) => {
            const native = event.nativeEvent
            toggleSelection(selectionKey, Boolean('shiftKey' in native && native.shiftKey))
          }}
        />
        <span className={styles.state} title={entryLabel(entry)} data-kind={entry.kind}>
          <FileStatusIcon kind={entry.kind} letter={mark} />
        </span>
        <button type="button" className={styles.filePath} data-nav-focus title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
          disabled={entry.kind === 'ignored'} onClick={() => entry.kind === 'unmerged' ? onNavigate('conflicts') : select(entry, staged)}>
          {fileView === 'tree' ? <span className={styles.filename}>{name}</span> : <><span className={styles.folder}>{directory}</span><span className={styles.filename}>{name}</span></>}
        </button>
        {entry.kind === 'unmerged' ? <button type="button" className={styles.stage} onClick={() => onNavigate('conflicts')}>{t('status.row.resolve')}</button> : entry.kind !== 'ignored' ? <button type="button" className={`${styles.stage} ${styles.rowTool}`} disabled={busy} title={staged ? t('status.row.unstageTitle') : t('status.row.stageTitle')} aria-label={staged ? t('status.row.unstageAria', { path: entry.path }) : t('status.row.stageAria', { path: entry.path })} onClick={() => void (staged ? unstage(entry) : stage(entry))}>{staged ? '−' : '+'}</button> : null}
        <ActionMenu label={t('status.row.actionsAria', { path: entry.path })} triggerClassName={styles.rowTool}>
          {menuItems(entry, staged, 'popover')}
        </ActionMenu>
      </div>
    )
  }
  return (
    <div className={styles.root} aria-busy={busy || loading} data-bulk={selectedKeys.size > 0}>
      <div className={styles.meta}>
        <input ref={filterRef} className={styles.filter} value={filter} onChange={(event) => {
          setFilter(event.target.value)
          setSelectedKeys(new Set())
          selectionAnchor.current = null
        }}
          placeholder={t('status.filter.placeholder')} aria-label={t('status.filter.aria')} />
        <ActionMenu label={t('status.view.options')}>
          <label className={styles.ignoredToggle} title={t('status.view.treeTitle')}>
            <input type="checkbox" checked={fileView === 'tree'} onChange={(event) => chooseView(event.target.checked ? 'tree' : 'path')} /> {t('status.view.tree')}
          </label>
          <label className={styles.ignoredToggle} title={t('status.view.ignoredTitle')}>
            <input type="checkbox" checked={includeIgnored} onChange={(event) => setIncludeIgnored(event.target.checked)} /> {t('status.view.ignored')}
          </label>
        </ActionMenu>
      </div>
      {locks.length > 0 ? <p className={styles.banner} role="alert">{t('status.locks', { list: locks.join(', ') })}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {status.truncated ? <p className={styles.banner}>{t('status.truncated')}</p> : null}
      {selectedEntries.length > 0 ? (
        <div className={styles.bulkBar} role="region" aria-label={t('status.bulk.regionAria')}>
          <strong>{plural('status.bulk.selected.one', 'status.bulk.selected.other', selectedEntries.length, { count: selectedEntries.length })}</strong>
          <button type="button" disabled={busy || !selectedEntries.some((item) => !item.staged)} onClick={() => void bulkStage()}>
            {t('status.bulk.stage')}
          </button>
          <button type="button" disabled={busy || !selectedEntries.some((item) => item.staged)} onClick={() => void bulkUnstage()}>
            {t('status.bulk.unstage')}
          </button>
          <button type="button" className={styles.danger} disabled={busy || !canDiscardSelection} title={canDiscardSelection ? undefined : t('status.bulk.discardTitle')} onClick={() => void requestDiscard(discardableSelection.map((item) => item.entry))}>
            {t('status.bulk.discard')}
          </button>
          <button type="button" className={styles.clearSelection} aria-label={t('common.clearSelection')} onClick={() => setSelectedKeys(new Set())}>×</button>
        </div>
      ) : null}
      <div ref={fileListRef} className={styles.fileList}>
        {status.entries.length === 0 ? <div className={styles.clean}><span aria-hidden="true">✓</span><strong>{t('status.clean.title')}</strong><p>{t('status.clean.body')}</p></div> : null}
        {filter && entries.length === 0 ? <p className={styles.notice}>{t('status.filter.none', { filter })}</p> : null}
        {groups.map((group) => {
          if (group.entries.length === 0 && (group.id === 'conflicts' || group.id === 'ignored' || status.entries.length === 0)) {
            return null
          }
          const selectable = group.id === 'worktree' || group.id === 'index'
          const keys = selectable ? groupSelectionKeys(group) : []
          const selectedCount = keys.filter((key) => selectedKeys.has(key)).length
          const allSelected = keys.length > 0 && selectedCount === keys.length
          const partial = selectedCount > 0 && !group.entries.every((entry) => selectedKeys.has(entrySelectionKey(group.staged, entry.path)))
          // Ignored paths are not in `trees`, so they keep the flat list.
          const rows = trees?.get(group.id)
          return (
            <section key={group.id} className={styles.fileGroup} aria-label={group.label}>
              <header className={styles.groupHeading}>
                <div className={styles.groupTitle}>
                  {group.entries.length > 0 && selectable ? (
                    <input
                      type="checkbox"
                      className={styles.groupSelect}
                      checked={allSelected}
                      ref={(node) => {
                        if (node) {
                          node.indeterminate = selectedCount > 0 && !allSelected
                        }
                      }}
                      disabled={busy || keys.length === 0}
                      aria-label={t('status.group.selectAll', { group: group.label })}
                      title={t('status.group.selectAllHint')}
                      onChange={() => toggleGroupSelection(group)}
                    />
                  ) : null}
                  <h2>{group.label} <span>{group.entries.length}</span></h2>
                </div>
                {group.entries.length > 0 && selectable ? (
                  <button type="button" disabled={busy} onClick={() => void stageGroup(group)}>
                    {partial
                      ? group.staged ? t('status.group.unstageSelection') : t('status.group.stageSelection')
                      : group.staged ? t('status.group.unstageAllAction') : t('status.group.stageAllAction')}
                  </button>
                ) : null}
              </header>
              {group.entries.length === 0 ? <p className={styles.empty}>{group.staged ? t('status.group.emptyStaged') : t('status.group.emptyUnstaged')}</p> : null}
              {rows
                ? rows.map((row) => row.kind === 'dir'
                  ? <button key={`dir:${row.key}`} type="button" className={styles.dirRow}
                      data-nav-key={`dir:${row.key}`}
                      style={{ paddingLeft: 10 + row.depth * 12 }} aria-expanded={row.open}
                      onClick={() => {
                        navCursorRef.current = `dir:${row.key}`
                        toggleDir(row.key)
                      }} title={row.name}>
                      <span className={styles.caret} aria-hidden="true">{row.open ? '▾' : '▸'}</span>
                      <span className={styles.dirName}>{row.name}</span>
                      <span className={styles.dirCount}>{row.count}</span>
                    </button>
                  : fileRow(row.item, group.staged, selectable, row.depth))
                : group.entries.slice(0, MAX_ROWS).map((entry) => fileRow(entry, group.staged, selectable, 0))}
              {group.entries.length > MAX_ROWS ? <p className={styles.banner}>{t('status.more', { count: group.entries.length - MAX_ROWS })}</p> : null}
            </section>
          )
        })}
      </div>
      {fileMenu ? (
        <ContextMenu x={fileMenu.x} y={fileMenu.y} title={fileMenu.entry.path}
          subtitle={entryLabel(fileMenu.entry)}
          ariaLabel={t('status.menu.aria', { path: fileMenu.entry.path })}
          onClose={() => setFileMenu(null)}>
          <div className={styles.menuActions}>
            {menuItems(fileMenu.entry, fileMenu.staged, 'context')}
          </div>
        </ContextMenu>
      ) : null}
      <ConfirmBar
        open={pendingDiscard !== null}
        title={t('status.discard.title')}
        consequence={pendingDiscard
          ? pendingDiscard.entries.length === 1
            ? t('status.discard.consequenceOne', { path: pendingDiscard.entries[0]!.path })
            : t('status.discard.consequenceMany', {
                count: pendingDiscard.entries.length,
                list: `${pendingDiscard.entries.slice(0, 3).map((entry) => entry.path).join(', ')}${pendingDiscard.entries.length > 3 ? '…' : ''}`,
              })
          : ''}
        irreversible
        confirmLabel={t('status.discard.confirm')}
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
      />
      <ConfirmBar
        open={pendingIgnore !== null}
        title={t('status.ignoreTracked.title')}
        consequence={pendingIgnore
          ? t('status.ignoreTracked.consequence', { path: pendingIgnore.entry.path, pattern: pendingIgnore.pattern })
          : ''}
        confirmLabel={t('status.ignoreTracked.confirm')}
        busy={busy}
        onCancel={() => setPendingIgnore(null)}
        onConfirm={() => void confirmIgnore()}
      />
      <ConfirmBar
        open={pendingDelete !== null}
        title={t('status.delete.title')}
        consequence={pendingDelete
          ? t('status.delete.consequenceOne', { path: pendingDelete.path })
          : ''}
        irreversible
        confirmLabel={t('status.delete.confirm')}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
