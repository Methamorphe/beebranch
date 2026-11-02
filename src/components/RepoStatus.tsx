import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  conflictMarkResolved,
  diffGet,
  fileDelete,
  indexDiscard,
  indexIgnore,
  indexStage,
  indexUnstage,
  preferenceGet,
  preferenceSet,
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
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import styles from './RepoStatus.module.css'

type Props = {
  repoId: string
  generation: number
  locks: string[]
  onSelectDiff: (request: DiffRequest) => void
  onMutated: () => void
  onNavigate: (view: 'commit' | 'sync' | 'stash' | 'conflicts') => void
  selectedPath?: string
}

const MAX_ROWS = 500

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

function dirPattern(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? `${path.slice(0, index + 1)}` : `${path}/`
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
  const [fileMenu, setFileMenu] = useState<FileMenu | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [flashPaths, setFlashPaths] = useState<Set<string>>(() => new Set())
  const selectionAnchor = useRef<string | null>(null)
  const flashTimer = useRef<number | null>(null)

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

  const ignore = (pattern: string) =>
    run(t('status.notice.ignored', { pattern }), () => indexIgnore(repoId, pattern))

  const openTool = (entry: StatusEntry, kind: 'editor' | 'merge') =>
    run(
      kind === 'merge'
        ? t('status.notice.mergeTool', { path: entry.path })
        : t('status.notice.editor', { path: entry.path }),
      () => toolOpen({ repoId, kind, path: entry.path }),
    )

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
    if (entry.kind === 'unmerged') {
      actions.push({
        key: 'resolve',
        label: t('status.row.resolve'),
        disabled: busy,
        run: () => onNavigate('conflicts'),
      })
    } else if (entry.kind !== 'ignored') {
      actions.push(staged
        ? {
            key: 'unstage',
            label: t('status.row.unstageMenu'),
            disabled: busy,
            run: () => void unstage(entry),
          }
        : {
            key: 'stage',
            label: t('status.row.stageMenu'),
            disabled: busy,
            run: () => void stage(entry),
          })
    }
    if (!isDirectory) {
      actions.push({
        key: 'editor',
        label: t('status.row.openEditor'),
        disabled: busy,
        run: () => void openTool(entry, 'editor'),
      })
    }
    if (entry.kind === 'unmerged') {
      actions.push(
        {
          key: 'merge-tool',
          label: t('status.row.mergeTool'),
          disabled: busy,
          run: () => void openTool(entry, 'merge'),
        },
        {
          key: 'mark-resolved',
          label: t('status.row.markResolved'),
          disabled: busy,
          run: () => void resolve(entry),
        },
      )
    }
    if (entry.kind === 'untracked') {
      actions.push({
        key: 'ignore-file',
        label: t('status.row.ignoreFile'),
        disabled: busy,
        run: () => void ignore(entry.path),
      })
      const pattern = extPattern(entry.path)
      if (pattern) {
        actions.push({
          key: 'ignore-extension',
          label: t('status.row.ignorePattern', { pattern }),
          disabled: busy,
          run: () => void ignore(pattern),
        })
      }
      if (entry.path.includes('/')) {
        actions.push({
          key: 'ignore-directory',
          label: t('status.row.ignoreDir'),
          disabled: busy,
          run: () => void ignore(dirPattern(entry.path)),
        })
      }
    }
    if (!staged && entry.kind === 'ordinary') {
      actions.push({
        key: 'discard',
        label: t('status.row.discardAction'),
        danger: true,
        disabled: busy,
        run: () => void requestDiscard([entry]),
      })
    }
    actions.push({
      key: 'copy-path',
      label: t('status.row.copyPath'),
      dividerBefore: true,
      run: () => void copyPath(entry),
    })
    if (!isDirectory && !entry.submodule && entry.kind !== 'unmerged') {
      actions.push({
        key: 'delete',
        label: t('status.row.deleteAction'),
        danger: true,
        dividerBefore: true,
        disabled: busy,
        run: () => setPendingDelete(entry),
      })
    }
    return actions
  }

  const menuItems = (entry: StatusEntry, staged: boolean, variant: 'popover' | 'context') =>
    rowActions(entry, staged).map((action) =>
      variant === 'popover' ? (
        <Fragment key={action.key}>
          {action.dividerBefore ? <div className={styles.menuSeparator} role="separator" /> : null}
          <button type="button" className={action.danger ? styles.danger : undefined}
            disabled={action.disabled} onClick={action.run}>{action.label}</button>
        </Fragment>
      ) : (
        <Fragment key={action.key}>
          {action.dividerBefore ? <div className={styles.menuSeparator} role="separator" /> : null}
          <button type="button" role="menuitem"
            className={action.danger ? `${styles.menuAction} ${styles.danger}` : styles.menuAction}
            disabled={action.disabled} onClick={() => {
              setFileMenu(null)
              action.run()
            }}>{action.label}</button>
        </Fragment>
      ),
    )

  const select = (entry: StatusEntry, staged: boolean) => onSelectDiff({
    target: staged ? 'index' : 'worktree', path: entry.path,
    untracked: entry.kind === 'untracked', allowActions: entry.kind !== 'unmerged',
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
  const stageGroup = (list: StatusEntry[], staged: boolean) => {
    const paths = [...new Set(list.flatMap(entryPaths))]
    markFlash(paths)
    void run(staged ? t('status.group.unstageAll') : t('status.group.stageAll'), () =>
      (staged ? indexUnstage : indexStage)(repoId, paths.map((path) => ({ path, hunks: [] }))))
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
  const fileRow = (entry: StatusEntry, staged: boolean, selectable: boolean, depth: number) => {
    const selectionKey = `${staged ? 'index' : 'worktree'}:${entry.path}`
    const { directory, name } = splitPath(entry.path)
    return (
      <div key={entry.path} className={styles.fileRow}
        style={depth > 0 ? { paddingLeft: 10 + depth * 12 } : undefined}
        data-selected={entry.path === selectedPath} data-checked={selectedKeys.has(selectionKey)} data-flash={flashPaths.has(entry.path)}
        data-menu={fileMenu?.entry.path === entry.path && fileMenu.staged === staged}
        onContextMenu={(event) => {
          event.preventDefault()
          setFileMenu({ x: event.clientX, y: event.clientY, entry, staged })
        }}>
        <input
          type="checkbox"
          className={styles.select}
          checked={selectedKeys.has(selectionKey)}
          disabled={!selectable || busy}
          aria-label={t('status.row.select', { path: entry.path })}
          title={selectable ? t('status.row.selectRange', { path: entry.path }) : undefined}
          onChange={(event) => {
            const native = event.nativeEvent
            toggleSelection(selectionKey, Boolean('shiftKey' in native && native.shiftKey))
          }}
        />
        <span className={styles.state} title={entryLabel(entry)} data-kind={entry.kind}>{entry.kind === 'untracked' ? 'N' : entry.kind === 'unmerged' ? '!' : staged ? entry.index : entry.worktree}</span>
        <button type="button" className={styles.filePath} title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
          disabled={entry.kind === 'ignored'} onClick={() => entry.kind === 'unmerged' ? onNavigate('conflicts') : select(entry, staged)}>
          {fileView === 'tree' ? <span className={styles.filename}>{name}</span> : <><span className={styles.folder}>{directory}</span><span className={styles.filename}>{name}</span></>}
        </button>
        {entry.kind === 'unmerged' ? <button type="button" className={styles.stage} onClick={() => onNavigate('conflicts')}>{t('status.row.resolve')}</button> : entry.kind !== 'ignored' ? <button type="button" className={styles.stage} disabled={busy} title={staged ? t('status.row.unstageTitle') : t('status.row.stageTitle')} aria-label={staged ? t('status.row.unstageAria', { path: entry.path }) : t('status.row.stageAria', { path: entry.path })} onClick={() => void (staged ? unstage(entry) : stage(entry))}>{staged ? '−' : '+'}</button> : null}
        <ActionMenu label={t('status.row.actionsAria', { path: entry.path })}>
          {menuItems(entry, staged, 'popover')}
        </ActionMenu>
      </div>
    )
  }
  return (
    <div className={styles.root} aria-busy={busy || loading}>
      <div className={styles.meta}>
        <input className={styles.filter} value={filter} onChange={(event) => {
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
      <div className={styles.fileList}>
        {status.entries.length === 0 ? <div className={styles.clean}><span aria-hidden="true">✓</span><strong>{t('status.clean.title')}</strong><p>{t('status.clean.body')}</p></div> : null}
        {filter && entries.length === 0 ? <p className={styles.notice}>{t('status.filter.none', { filter })}</p> : null}
        {groups.map((group) => {
          if (group.entries.length === 0 && (group.id === 'conflicts' || group.id === 'ignored' || status.entries.length === 0)) {
            return null
          }
          const selectable = group.id === 'worktree' || group.id === 'index'
          // Ignored paths are not in `trees`, so they keep the flat list.
          const rows = trees?.get(group.id)
          return (
            <section key={group.id} className={styles.fileGroup} aria-label={group.label}>
              <header className={styles.groupHeading}><h2>{group.label} <span>{group.entries.length}</span></h2>
                {group.entries.length > 0 && selectable ? <button type="button" disabled={busy} onClick={() => stageGroup(group.entries, group.staged)}>{group.staged ? t('status.group.unstageAllAction') : t('status.group.stageAllAction')}</button> : null}
              </header>
              {group.entries.length === 0 ? <p className={styles.empty}>{group.staged ? t('status.group.emptyStaged') : t('status.group.emptyUnstaged')}</p> : null}
              {rows
                ? rows.map((row) => row.kind === 'dir'
                  ? <button key={`dir:${row.key}`} type="button" className={styles.dirRow}
                      style={{ paddingLeft: 10 + row.depth * 12 }} aria-expanded={row.open}
                      onClick={() => toggleDir(row.key)} title={row.name}>
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
      <ConfirmDialog
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
      <ConfirmDialog
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
