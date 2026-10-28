import { useMemo, useState } from 'react'
import { shortRevision } from '../lib/graphRefs'
import { STATUS_LABELS, STATUS_LETTERS, splitPath } from '../lib/paths'
import type { CommitSummary, DiffReport, FileDiff } from '../types/git'
import styles from './ComparisonPanel.module.css'

/** Stable identity: an inline `[]` would re-run memos on every render. */
const NO_FILES: FileDiff[] = []
const NO_COMMITS: CommitSummary[] = []

type Props = {
  base: string
  target: string
  baseLabel: string
  targetLabel: string
  /** Commits covered by the comparison, newest first, as the graph lists them. */
  commits?: CommitSummary[]
  report: DiffReport | null
  loading: boolean
  error: string | null
  /** Path whose patch is open in the history region, `null` when none is. */
  activePath: string | null
  onSelectPath: (path: string) => void
  onClose: () => void
  onSwap: () => void
  onFullScreen: () => void
}

type FileView = 'path' | 'tree'

/** A changed file with the path the diff request must target. */
type FileEntry = {
  entry: FileDiff
  path: string
}

type TreeDir = {
  name: string
  path: string
  dirs: TreeDir[]
  files: FileEntry[]
  /** Changed files below this directory, its own included. */
  count: number
}

type TreeRow =
  | { kind: 'dir'; key: string; name: string; depth: number; count: number; open: boolean }
  | { kind: 'file'; key: string; item: FileEntry; depth: number }

function buildTree(entries: FileEntry[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], count: 0 }
  for (const item of entries) {
    const segments = item.path.split('/')
    let node = root
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const path = segments.slice(0, depth + 1).join('/')
      let child = node.dirs.find((dir) => dir.path === path)
      if (!child) {
        child = { name: segments[depth]!, path, dirs: [], files: [], count: 0 }
        node.dirs.push(child)
      }
      node = child
    }
    node.files.push(item)
  }
  const finalise = (node: TreeDir): number => {
    node.dirs.sort((left, right) => left.name.localeCompare(right.name))
    node.files.sort((left, right) => left.path.localeCompare(right.path))
    node.count =
      node.files.length + node.dirs.reduce((sum, child) => sum + finalise(child), 0)
    return node.count
  }
  finalise(root)
  return root
}

/** A directory that only holds another one reads as `a/b/c`, like git clients show it. */
function compactDir(dir: TreeDir) {
  let current = dir
  let name = dir.name
  while (current.files.length === 0 && current.dirs.length === 1) {
    current = current.dirs[0]!
    name = `${name}/${current.name}`
  }
  return { name, dir: current }
}

function flattenTree(root: TreeDir, collapsed: Set<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: TreeDir, depth: number) => {
    for (const child of dir.dirs) {
      const compact = compactDir(child)
      const open = !collapsed.has(compact.dir.path)
      rows.push({
        kind: 'dir',
        key: compact.dir.path,
        name: compact.name,
        depth,
        count: compact.dir.count,
        open,
      })
      if (open) {
        walk(compact.dir, depth + 1)
      }
    }
    for (const item of dir.files) {
      rows.push({ kind: 'file', key: item.path, item, depth })
    }
  }
  walk(root, 0)
  return rows
}

function shortDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PathLabel({ path }: { path: string }) {
  const { directory, name } = splitPath(path)
  return (
    <>
      {directory ? <span className={styles.directory}>{directory}</span> : null}
      <span className={styles.name}>{name}</span>
    </>
  )
}

/**
 * A→B comparison docked in the history inspector: the commit tree and the
 * changed files stay listed next to the history, while the patch of the file
 * picked here opens in the history region, where it has room to be read.
 */
export function ComparisonPanel({
  base,
  target,
  baseLabel,
  targetLabel,
  commits = NO_COMMITS,
  report,
  loading,
  error,
  activePath,
  onSelectPath,
  onClose,
  onSwap,
  onFullScreen,
}: Props) {
  const [fileView, setFileView] = useState<FileView>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const files = report?.files ?? NO_FILES
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, entry) => ({
          additions: sum.additions + entry.additions,
          deletions: sum.deletions + entry.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  )
  const entries = useMemo<FileEntry[]>(
    () =>
      files.map((entry) => ({
        entry,
        path: entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath,
      })),
    [files],
  )
  const tree = useMemo(
    () => (fileView === 'tree' ? flattenTree(buildTree(entries), collapsed) : []),
    [entries, fileView, collapsed],
  )

  const toggleDir = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })

  const fileRow = (item: FileEntry, depth: number) => {
    const current = item.path === activePath
    return (
      <button
        key={`${item.entry.oldPath}->${item.entry.newPath}`}
        type="button"
        className={current ? styles.fileActive : styles.file}
        style={{ paddingLeft: 10 + depth * 12 }}
        aria-current={current ? 'true' : undefined}
        title={`${STATUS_LABELS[item.entry.kind]} · ${
          item.entry.newPath === '/dev/null'
            ? `${item.entry.oldPath} → supprimé`
            : item.entry.oldPath === '/dev/null'
              ? `${item.path} → ajouté`
              : `${item.entry.oldPath} → ${item.entry.newPath}`
        }`}
        onClick={() => onSelectPath(item.path)}
      >
        <span className={styles.status} data-kind={item.entry.kind} aria-hidden="true">
          {STATUS_LETTERS[item.entry.kind]}
        </span>
        <span className={styles.path}>
          {fileView === 'tree' ? (
            <span className={styles.name}>{splitPath(item.path).name}</span>
          ) : (
            <PathLabel path={item.path} />
          )}
        </span>
        <span className={styles.stats}>
          {item.entry.binary ? (
            'binaire'
          ) : (
            <>
              <span className={styles.added}>+{item.entry.additions}</span>
              <span className={styles.removed}>−{item.entry.deletions}</span>
            </>
          )}
        </span>
      </button>
    )
  }

  return (
    <aside className={styles.panel} aria-label="Comparaison">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.title}>
            {commits.length > 1
              ? `${commits.length} commits sélectionnés`
              : 'Comparaison'}
          </span>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.icon}
              onClick={onSwap}
              title="Inverser A et B"
              aria-label="Inverser le sens de la comparaison"
            >
              ⇄
            </button>
            <button
              type="button"
              className={styles.icon}
              onClick={onFullScreen}
              title="Ouvrir la comparaison dans la vue Diff"
              aria-label="Ouvrir la comparaison dans la vue Diff"
            >
              ⤢
            </button>
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              title="Fermer la comparaison"
              aria-label="Fermer la comparaison"
            >
              ×
            </button>
          </div>
        </div>
        <code className={styles.range} title={`${base} → ${target}`}>
          {shortRevision(base)}…{shortRevision(target)}
        </code>
        <div className={styles.ends}>
          <span className={styles.end} title={base}>{baseLabel}</span>
          <span className={styles.arrow} aria-hidden="true">→</span>
          <span className={styles.end} title={target}>{targetLabel}</span>
        </div>
        {commits.length > 1 ? (
          <section className={styles.commitBlock} aria-label="Commits comparés">
            <span className={styles.caption}>Diff de {commits.length} commits</span>
            <ol className={styles.commits}>
              {commits.map((commit) => (
                <li key={commit.sha} className={styles.commit}>
                  <span className={styles.commitSha} title={commit.sha}>
                    {commit.sha.slice(0, 8)}
                  </span>
                  <span className={styles.commitText}>
                    <span className={styles.commitSubject} title={commit.subject}>
                      {commit.subject}
                    </span>
                    <span className={styles.commitMeta}>
                      {shortDate(commit.author.timestamp)} · {commit.author.name}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </header>

      {error ? (
        <p className={styles.error} role="alert">{error}</p>
      ) : null}

      {loading ? (
        <p className={styles.loading} role="status">Calcul du diff…</p>
      ) : !error && report && files.length === 0 ? (
        <p className={styles.empty}>Aucune différence entre ces deux versions.</p>
      ) : null}

      {!loading && files.length > 0 ? (
        <>
          <div className={styles.filesBar}>
            <span>
              {files.length} fichier{files.length > 1 ? 's' : ''} modifié
              {files.length > 1 ? 's' : ''}
            </span>
            <span className={styles.totals}>
              <span className={styles.added}>+{totals.additions}</span>
              <span className={styles.removed}>−{totals.deletions}</span>
            </span>
            <div
              className={styles.viewToggle}
              role="group"
              aria-label="Présentation des fichiers"
            >
              <button
                type="button"
                aria-pressed={fileView === 'path'}
                onClick={() => setFileView('path')}
                title="Liste à plat, chemin complet"
              >
                Chemin
              </button>
              <button
                type="button"
                aria-pressed={fileView === 'tree'}
                onClick={() => setFileView('tree')}
                title="Dossiers repliables"
              >
                Arborescence
              </button>
            </div>
          </div>
          <div className={styles.files} role="group" aria-label="Fichiers comparés">
            {fileView === 'path'
              ? entries.map((item) => fileRow(item, 0))
              : tree.map((row) =>
                  row.kind === 'dir' ? (
                    <button
                      key={`dir:${row.key}`}
                      type="button"
                      className={styles.dir}
                      style={{ paddingLeft: 10 + row.depth * 12 }}
                      aria-expanded={row.open}
                      onClick={() => toggleDir(row.key)}
                      title={row.name}
                    >
                      <span className={styles.caret} aria-hidden="true">
                        {row.open ? '▾' : '▸'}
                      </span>
                      <span className={styles.dirName}>{row.name}</span>
                      <span className={styles.dirCount}>{row.count}</span>
                    </button>
                  ) : (
                    fileRow(row.item, row.depth)
                  ),
                )}
          </div>
        </>
      ) : null}
    </aside>
  )
}
