import { useEffect, useMemo, useState } from 'react'
import { shortRevision } from '../lib/graphRefs'
import { STATUS_LABELS, STATUS_LETTERS, splitPath } from '../lib/paths'
import type { DiffReport, FileDiff } from '../types/git'
import { DiffViewer } from './DiffViewer'
import styles from './ComparisonPanel.module.css'

/** Stable identity: an inline `[]` would re-run memos on every render. */
const NO_FILES: FileDiff[] = []

type Props = {
  base: string
  target: string
  baseLabel: string
  targetLabel: string
  report: DiffReport | null
  loading: boolean
  error: string | null
  onClose: () => void
  onSwap: () => void
  onFullScreen: () => void
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
 * A→B comparison docked in the history inspector: the commit tree stays
 * visible while the changed files and their patch are read next to it.
 */
export function ComparisonPanel({
  base,
  target,
  baseLabel,
  targetLabel,
  report,
  loading,
  error,
  onClose,
  onSwap,
  onFullScreen,
}: Props) {
  const [active, setActive] = useState(0)
  const files = report?.files ?? NO_FILES
  const index = files.length === 0 ? -1 : Math.min(active, files.length - 1)
  const file = index >= 0 ? files[index]! : null
  // DiffViewer resets its own state whenever the report identity changes, so the
  // single-file slice must stay referentially stable across renders.
  const singleReport = useMemo(
    () => (file ? { files: [file], truncated: report?.truncated ?? false } : null),
    [file, report?.truncated],
  )
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

  // A new request replaces the list: the previous file index means nothing.
  useEffect(() => {
    setActive(0)
  }, [report])

  return (
    <aside className={styles.panel} aria-label="Comparaison">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.title}>Comparaison</span>
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
        <div className={styles.summary}>
          {loading ? (
            <span role="status">Calcul du diff…</span>
          ) : error ? (
            <span>Comparaison impossible</span>
          ) : (
            <span>
              {files.length} fichier{files.length > 1 ? 's' : ''} modifié
              {files.length > 1 ? 's' : ''}
            </span>
          )}
          {!loading && !error ? (
            <span className={styles.totals}>
              <span className={styles.added}>+{totals.additions}</span>
              <span className={styles.removed}>−{totals.deletions}</span>
            </span>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className={styles.error} role="alert">{error}</p>
      ) : null}

      {!loading && !error && report && files.length === 0 ? (
        <p className={styles.empty}>Aucune différence entre ces deux versions.</p>
      ) : null}

      {files.length > 0 ? (
        <>
          <div className={styles.files} role="group" aria-label="Fichiers comparés">
            {files.map((entry, position) => {
              const path = entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath
              return (
                <button
                  key={`${entry.oldPath}->${entry.newPath}`}
                  type="button"
                  className={position === index ? styles.fileActive : styles.file}
                  aria-current={position === index ? 'true' : undefined}
                  title={`${STATUS_LABELS[entry.kind]} · ${entry.newPath === '/dev/null' ? `${entry.oldPath} → supprimé` : entry.oldPath === '/dev/null' ? `${entry.newPath} → ajouté` : `${entry.oldPath} → ${entry.newPath}`}`}
                  onClick={() => setActive(position)}
                >
                  <span className={styles.status} data-kind={entry.kind} aria-hidden="true">
                    {STATUS_LETTERS[entry.kind]}
                  </span>
                  <span className={styles.path}>
                    <PathLabel path={path} />
                  </span>
                  <span className={styles.stats}>
                    {entry.binary ? (
                      'binaire'
                    ) : (
                      <>
                        <span className={styles.added}>+{entry.additions}</span>
                        <span className={styles.removed}>−{entry.deletions}</span>
                      </>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          {file && singleReport ? (
            <div className={styles.diff} aria-label={`Diff de ${file.newPath}`}>
              <DiffViewer
                key={`${file.oldPath}->${file.newPath}`}
                embedded
                report={singleReport}
                source=""
              />
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  )
}
