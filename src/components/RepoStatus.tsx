import { useEffect, useMemo, useRef, useState } from 'react'
import {
  conflictMarkResolved,
  diffGet,
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
import { buildFileTree, flattenFileTree, type FileTreeRow } from '../lib/fileTree'
import { splitPath } from '../lib/paths'
import type { Fingerprint, StatusEntry, StatusReport } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ConfirmDialog } from './ConfirmDialog'
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
      return 'non suivi'
    case 'unmerged':
      return 'conflit'
    case 'renamed':
      return 'renommé'
    case 'copied':
      return 'copié'
    case 'ignored':
      return 'ignoré'
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

export function RepoStatus({
  repoId,
  generation,
  locks,
  onSelectDiff,
  onMutated,
  onNavigate,
  selectedPath,
}: Props) {
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
    { id: 'conflicts', label: 'Conflits à résoudre', entries: entries.filter((e) => e.kind === 'unmerged'), staged: false },
    { id: 'worktree', label: 'À préparer', entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'ignored' && (e.kind === 'untracked' || e.worktree !== '.')), staged: false },
    { id: 'index', label: 'Prêts à committer', entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'untracked' && e.kind !== 'ignored' && e.index !== '.'), staged: true },
    { id: 'ignored', label: 'Ignorés', entries: entries.filter((e) => e.kind === 'ignored'), staged: false },
  ], [entries])

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
    return run(`Indexé : ${entry.path}`, () =>
      indexStage(
        repoId,
        entryPaths(entry).map((path) => ({ path, hunks: [] })),
      ),
    )
  }

  const unstage = (entry: StatusEntry) => {
    markFlash(entryPaths(entry))
    return run(`Retiré de l'index : ${entry.path}`, () =>
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
      setError('Un fichier non suivi ou en conflit ne peut pas être discardé ici.')
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
      ? `Discard irréversible : ${target.entries[0]!.path}`
      : `Discard irréversible : ${target.entries.length} fichiers`
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
    run(`Ajouté au .gitignore : ${pattern}`, () => indexIgnore(repoId, pattern))

  const openTool = (entry: StatusEntry, kind: 'editor' | 'merge') =>
    run(
      kind === 'merge'
        ? `Merge tool ouvert : ${entry.path}`
        : `Éditeur ouvert : ${entry.path}`,
      () => toolOpen({ repoId, kind, path: entry.path }),
    )

  const resolve = (entry: StatusEntry) =>
    run(`Conflit marqué résolu : ${entry.path}`, () =>
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
    return <div className={styles.loading}>{loading ? 'Lecture du status…' : 'Aucun status.'}</div>
  }

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
      `${targets.length} fichier(s) préparé(s).`,
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
      `${targets.length} fichier(s) retiré(s) de l’index.`,
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
    void run(staged ? 'Fichiers retirés de l’index.' : 'Fichiers ajoutés à l’index.', () =>
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
        data-selected={entry.path === selectedPath} data-checked={selectedKeys.has(selectionKey)} data-flash={flashPaths.has(entry.path)}>
        <input
          type="checkbox"
          className={styles.select}
          checked={selectedKeys.has(selectionKey)}
          disabled={!selectable || busy}
          aria-label={`Sélectionner ${entry.path}`}
          title={selectable ? `Sélectionner ${entry.path} · Maj+clic pour une plage` : undefined}
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
        {entry.kind === 'unmerged' ? <button type="button" className={styles.stage} onClick={() => onNavigate('conflicts')}>Résoudre</button> : entry.kind !== 'ignored' ? <button type="button" className={styles.stage} disabled={busy} title={staged ? 'Retirer de l’index' : 'Préparer ce fichier'} aria-label={`${staged ? 'Retirer' : 'Préparer'} ${entry.path}`} onClick={() => void (staged ? unstage(entry) : stage(entry))}>{staged ? '−' : '+'}</button> : null}
        <ActionMenu label={`Actions pour ${entry.path}`}>
            <button type="button" disabled={busy} onClick={() => void openTool(entry, 'editor')}>Ouvrir dans l’éditeur</button>
            {entry.kind === 'unmerged' ? <><button type="button" disabled={busy} onClick={() => void openTool(entry, 'merge')}>Outil de fusion</button><button type="button" disabled={busy} onClick={() => void resolve(entry)}>Marquer résolu</button></> : null}
            {entry.kind === 'untracked' ? <><button type="button" disabled={busy} onClick={() => void ignore(entry.path)}>Ignorer le fichier</button>{extPattern(entry.path) ? <button type="button" disabled={busy} onClick={() => void ignore(extPattern(entry.path)!)}>Ignorer {extPattern(entry.path)}</button> : null}{entry.path.includes('/') ? <button type="button" disabled={busy} onClick={() => void ignore(dirPattern(entry.path))}>Ignorer le dossier</button> : null}</> : null}
            {!staged && entry.kind === 'ordinary' ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void requestDiscard([entry])}>Abandonner les modifications…</button> : null}
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
          placeholder="Filtrer les fichiers…" aria-label="Filtrer les chemins" />
        <ActionMenu label="Options d’affichage des fichiers">
          <label className={styles.ignoredToggle} title="Regrouper les fichiers par dossier, avec des dossiers repliables">
            <input type="checkbox" checked={fileView === 'tree'} onChange={(event) => chooseView(event.target.checked ? 'tree' : 'path')} /> Afficher en arborescence
          </label>
          <label className={styles.ignoredToggle} title="Afficher les fichiers ignorés">
            <input type="checkbox" checked={includeIgnored} onChange={(event) => setIncludeIgnored(event.target.checked)} /> Afficher les fichiers ignorés
          </label>
        </ActionMenu>
      </div>
      {locks.length > 0 ? <p className={styles.banner} role="alert">Verrous Git : {locks.join(', ')}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {status.truncated ? <p className={styles.banner}>Liste partielle. Filtrez pour affiner les résultats.</p> : null}
      {selectedEntries.length > 0 ? (
        <div className={styles.bulkBar} role="region" aria-label="Fichiers sélectionnés">
          <strong>{selectedEntries.length} sélectionné{selectedEntries.length > 1 ? 's' : ''}</strong>
          <button type="button" disabled={busy || !selectedEntries.some((item) => !item.staged)} onClick={() => void bulkStage()}>
            Préparer
          </button>
          <button type="button" disabled={busy || !selectedEntries.some((item) => item.staged)} onClick={() => void bulkUnstage()}>
            Retirer
          </button>
          <button type="button" className={styles.danger} disabled={busy || !canDiscardSelection} title={canDiscardSelection ? undefined : 'Sélectionnez uniquement des fichiers modifiés non préparés.'} onClick={() => void requestDiscard(discardableSelection.map((item) => item.entry))}>
            Abandonner…
          </button>
          <button type="button" className={styles.clearSelection} aria-label="Vider la sélection" onClick={() => setSelectedKeys(new Set())}>×</button>
        </div>
      ) : null}
      <div className={styles.fileList}>
        {status.entries.length === 0 ? <div className={styles.clean}><span aria-hidden="true">✓</span><strong>Tout est à jour</strong><p>Aucune modification locale. Votre prochain commit commence ici.</p></div> : null}
        {filter && entries.length === 0 ? <p className={styles.notice}>Aucun fichier ne correspond à « {filter} ».</p> : null}
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
                {group.entries.length > 0 && selectable ? <button type="button" disabled={busy} onClick={() => stageGroup(group.entries, group.staged)}>{group.staged ? 'Tout retirer' : 'Tout préparer'}</button> : null}
              </header>
              {group.entries.length === 0 ? <p className={styles.empty}>{group.staged ? 'Préparez les fichiers à inclure dans le commit.' : 'Aucun fichier à préparer.'}</p> : null}
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
              {group.entries.length > MAX_ROWS ? <p className={styles.banner}>{group.entries.length - MAX_ROWS} autres fichiers. Affinez le filtre.</p> : null}
            </section>
          )
        })}
      </div>
      <ConfirmDialog
        open={pendingDiscard !== null}
        title="Discard irréversible"
        consequence={pendingDiscard
          ? pendingDiscard.entries.length === 1
            ? `1 fichier (${pendingDiscard.entries[0]!.path}) : le contenu non indexé sera remplacé par la version de l'index.`
            : `${pendingDiscard.entries.length} fichiers (${pendingDiscard.entries.slice(0, 3).map((entry) => entry.path).join(', ')}${pendingDiscard.entries.length > 3 ? '…' : ''}) : le contenu non indexé sera remplacé par la version de l'index.`
          : ''}
        irreversible
        confirmLabel="Discard"
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
      />
    </div>
  )
}
