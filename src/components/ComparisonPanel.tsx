import { useMemo, useState } from 'react'
import { buildFileTree, flattenFileTree } from '../lib/fileTree'
import { shortRevision } from '../lib/graphRefs'
import { STATUS_LABELS, STATUS_LETTERS, splitPath } from '../lib/paths'
import { dateFromSeconds, formatDateTime, useI18n } from '../i18n'
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
  const { t, plural } = useI18n()
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
    () => (fileView === 'tree' ? flattenFileTree(buildFileTree(entries), collapsed) : []),
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
        title={`${t(STATUS_LABELS[item.entry.kind])} · ${
          item.entry.newPath === '/dev/null'
            ? t('diff.comparison.removed', { path: item.entry.oldPath })
            : item.entry.oldPath === '/dev/null'
              ? t('diff.comparison.added', { path: item.path })
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
            t('diff.binary')
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
    <aside className={styles.panel} aria-label={t('diff.comparison.aria')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.title}>
            {commits.length > 1
              ? t('diff.comparison.commitsSelected', { count: commits.length })
              : t('diff.comparison.title')}
          </span>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.icon}
              onClick={onSwap}
              title={t('diff.comparison.swap')}
              aria-label={t('diff.comparison.swapAria')}
            >
              ⇄
            </button>
            <button
              type="button"
              className={styles.icon}
              onClick={onFullScreen}
              title={t('diff.comparison.fullScreen')}
              aria-label={t('diff.comparison.fullScreen')}
            >
              ⤢
            </button>
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              title={t('diff.comparison.close')}
              aria-label={t('diff.comparison.close')}
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
          <section className={styles.commitBlock} aria-label={t('diff.comparison.commitsAria')}>
            <span className={styles.caption}>{t('diff.comparison.diffOf', { count: commits.length })}</span>
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
                      {formatDateTime(dateFromSeconds(commit.author.timestamp))} · {commit.author.name}
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
        <p className={styles.loading} role="status">{t('diff.comparison.loading')}</p>
      ) : !error && report && files.length === 0 ? (
        <p className={styles.empty}>{t('diff.comparison.noDifference')}</p>
      ) : null}

      {!loading && files.length > 0 ? (
        <>
          <div className={styles.filesBar}>
            <span>
              {plural('diff.files.modified.one', 'diff.files.modified.other', files.length)}
            </span>
            <span className={styles.totals}>
              <span className={styles.added}>+{totals.additions}</span>
              <span className={styles.removed}>−{totals.deletions}</span>
            </span>
            <div
              className={styles.viewToggle}
              role="group"
              aria-label={t('diff.comparison.viewAria')}
            >
              <button
                type="button"
                aria-pressed={fileView === 'path'}
                onClick={() => setFileView('path')}
                title={t('diff.comparison.viewPathTitle')}
              >
                {t('diff.comparison.viewPath')}
              </button>
              <button
                type="button"
                aria-pressed={fileView === 'tree'}
                onClick={() => setFileView('tree')}
                title={t('diff.comparison.viewTreeTitle')}
              >
                {t('diff.comparison.viewTree')}
              </button>
            </div>
          </div>
          <div className={styles.files} role="group" aria-label={t('diff.comparison.filesAria')}>
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
