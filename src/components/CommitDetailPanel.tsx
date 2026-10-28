import type { CommitDetail } from '../types/git'
import { letterFromStatus, splitPath, statusLabel } from '../lib/paths'
import styles from './CommitDetailPanel.module.css'

type Props = {
  detail: CommitDetail | null
  loading: boolean
  error: string | null
  onShowDiff: (sha: string, path?: string) => void
  onClose: () => void
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

export function CommitDetailPanel({ detail, loading, error, onShowDiff, onClose }: Props) {
  const close = (
    <button type="button" className={styles.close} onClick={onClose} aria-label="Fermer le détail du commit">
      ×
    </button>
  )

  if (loading) {
    return (
      <aside className={styles.panel} aria-label="Détail du commit">
        <div className={styles.headerTop}>{close}</div>
        <p role="status" className={styles.hint}>Chargement du commit…</p>
      </aside>
    )
  }
  if (error) {
    return (
      <aside className={styles.panel} role="alert" aria-label="Détail du commit">
        <div className={styles.headerTop}>{close}</div>
        <p className={styles.error}>{error}</p>
      </aside>
    )
  }
  if (!detail) {
    return (
      <aside className={styles.panel} aria-label="Détail du commit">
        <div className={styles.headerTop}>{close}</div>
        <p className={styles.hint}>Sélectionnez un commit dans le graphe.</p>
      </aside>
    )
  }

  const commit = detail.summary
  const subject = commit.subject.trim()
  const rawBody = detail.message.trim()
  const body = rawBody.startsWith(subject) ? rawBody.slice(subject.length).trim() : rawBody
  const additions = detail.files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  const hasStats = detail.files.some((file) => !file.binary)
  const fileCount = detail.files.length

  return (
    <aside className={styles.panel} aria-label="Détail du commit">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <code className={styles.sha} title={commit.sha}>{commit.sha.slice(0, 12)}</code>
          {close}
        </div>
        {commit.refs.length > 0 ? (
          <div className={styles.refs}>
            {commit.refs.map((ref) => (
              <span key={ref} className={styles.ref} title={ref}>
                {ref.replace('HEAD -> ', '').replace(/^refs\/(heads|remotes)\//, '')}
              </span>
            ))}
          </div>
        ) : null}
        <h2 className={styles.subject} title={subject}>{subject}</h2>
        <p className={styles.meta}>
          <span className={styles.author}>{commit.author.name}</span>
          <span>{new Date(commit.author.timestamp * 1000).toLocaleString('fr-FR')}</span>
          <span>{commit.parents.length} parent{commit.parents.length > 1 ? 's' : ''}</span>
        </p>
        <button type="button" className={styles.diffAction} onClick={() => onShowDiff(commit.sha)}>
          Voir le diff complet
        </button>
      </header>

      {body ? (
        <section className={styles.section} aria-label="Message du commit">
          <h3 className={styles.sectionTitle}>Message</h3>
          <pre className={styles.message}>{body}</pre>
        </section>
      ) : null}

      <section className={styles.section} aria-label="Fichiers modifiés">
        <div className={styles.filesHeader}>
          <h3 className={styles.sectionTitle}>
            {fileCount} fichier{fileCount > 1 ? 's' : ''} modifié{fileCount > 1 ? 's' : ''}
          </h3>
          {hasStats ? (
            <span className={styles.changeSummary}>
              <span className={styles.add}>+{additions}</span>
              <span className={styles.del}>−{deletions}</span>
            </span>
          ) : null}
        </div>
        {detail.filesTruncated ? (
          <p className={styles.note}>Liste partielle : le commit contient davantage de fichiers.</p>
        ) : null}
        <div className={styles.files}>
          {detail.files.map((file) => (
            <button
              type="button"
              key={`${file.status}-${file.oldPath ?? ''}-${file.path}`}
              className={styles.file}
              onClick={() => onShowDiff(commit.sha, file.path)}
              title={
                file.oldPath
                  ? `${statusLabel(file.status)} · ${file.oldPath} → ${file.path}`
                  : `${statusLabel(file.status)} · ${file.path}`
              }
            >
              <span
                className={styles.status}
                data-status={letterFromStatus(file.status)}
                aria-hidden="true"
              >
                {letterFromStatus(file.status)}
              </span>
              <span className={styles.path}>
                <PathLabel path={file.path} />
              </span>
              <span className={styles.stats}>
                {file.binary ? (
                  'binaire'
                ) : (
                  <>
                    <span className={styles.add}>+{file.additions ?? 0}</span>
                    <span className={styles.del}>−{file.deletions ?? 0}</span>
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  )
}
