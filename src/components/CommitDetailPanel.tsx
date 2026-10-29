import type { CommitDetail } from '../types/git'
import { letterFromStatus, splitPath, statusLabel } from '../lib/paths'
import { dateFromSeconds, formatDateTime, useI18n, type MessageKey } from '../i18n'
import styles from './CommitDetailPanel.module.css'

/** Verification code from `git show --format=%G?`, mapped to a label. */
const SIGNATURE_LABELS: Partial<Record<string, MessageKey>> = {
  G: 'diff.commit.signature.good',
  B: 'diff.commit.signature.bad',
  U: 'diff.commit.signature.untrusted',
  N: 'diff.commit.signature.none',
  X: 'diff.commit.signature.expired',
  Y: 'diff.commit.signature.expiredKey',
  R: 'diff.commit.signature.revokedKey',
  E: 'diff.commit.signature.error',
}

type Props = {
  detail: CommitDetail | null
  loading: boolean
  error: string | null
  onShowDiff: (sha: string, path?: string) => void
  /** Opens the history of one file of this commit. */
  onShowHistory?: (path: string) => void
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

export function CommitDetailPanel({ detail, loading, error, onShowDiff, onShowHistory, onClose }: Props) {
  const { t, plural } = useI18n()
  const close = (
    <button type="button" className={styles.close} onClick={onClose} aria-label={t('diff.commit.closeAria')}>
      ×
    </button>
  )

  if (loading) {
    return (
      <aside className={styles.panel} aria-label={t('diff.commit.aria')}>
        <div className={styles.headerTop}>{close}</div>
        <p role="status" className={styles.hint}>{t('diff.commit.loading')}</p>
      </aside>
    )
  }
  if (error) {
    return (
      <aside className={styles.panel} role="alert" aria-label={t('diff.commit.aria')}>
        <div className={styles.headerTop}>{close}</div>
        <p className={styles.error}>{error}</p>
      </aside>
    )
  }
  if (!detail) {
    return (
      <aside className={styles.panel} aria-label={t('diff.commit.aria')}>
        <div className={styles.headerTop}>{close}</div>
        <p className={styles.hint}>{t('diff.commit.empty')}</p>
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
    <aside className={styles.panel} aria-label={t('diff.commit.aria')}>
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
          <span>{formatDateTime(dateFromSeconds(commit.author.timestamp))}</span>
          <span>{plural('diff.commit.parents.one', 'diff.commit.parents.other', commit.parents.length)}</span>
          {detail.signature ? (
            <span
              className={styles.signature}
              data-code={detail.signature}
              title={t(SIGNATURE_LABELS[detail.signature] ?? 'diff.commit.signature.other')}
            >
              {t(SIGNATURE_LABELS[detail.signature] ?? 'diff.commit.signature.other')}
            </span>
          ) : null}
        </p>
        <button type="button" className={styles.diffAction} onClick={() => onShowDiff(commit.sha)}>
          {t('diff.commit.showDiff')}
        </button>
      </header>

      {body ? (
        <section className={styles.section} aria-label={t('diff.commit.messageAria')}>
          <h3 className={styles.sectionTitle}>{t('diff.commit.message')}</h3>
          <pre className={styles.message}>{body}</pre>
        </section>
      ) : null}

      <section className={styles.section} aria-label={t('diff.commit.filesAria')}>
        <div className={styles.filesHeader}>
          <h3 className={styles.sectionTitle}>
            {plural('diff.files.modified.one', 'diff.files.modified.other', fileCount)}
          </h3>
          {hasStats ? (
            <span className={styles.changeSummary}>
              <span className={styles.add}>+{additions}</span>
              <span className={styles.del}>−{deletions}</span>
            </span>
          ) : null}
        </div>
        {detail.filesTruncated ? (
          <p className={styles.note}>{t('diff.commit.filesPartial')}</p>
        ) : null}
        <div className={styles.files}>
          {detail.files.map((file) => (
            <div key={`${file.status}-${file.oldPath ?? ''}-${file.path}`} className={styles.fileRow}>
              <button
                type="button"
                className={styles.file}
                onClick={() => onShowDiff(file.revision ?? commit.sha, file.path)}
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
                    t('diff.binary')
                  ) : (
                    <>
                      <span className={styles.add}>+{file.additions ?? 0}</span>
                      <span className={styles.del}>−{file.deletions ?? 0}</span>
                    </>
                  )}
                </span>
              </button>
              {onShowHistory ? (
                <button
                  type="button"
                  className={styles.fileHistory}
                  onClick={() => onShowHistory(file.path)}
                  title={t('diff.commit.historyTitle', { path: file.path })}
                  aria-label={t('diff.commit.historyAria', { path: file.path })}
                >
                  ⌖
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </aside>
  )
}
