import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitDetail, CommitFile } from '../types/git'
import { buildFileTree, flattenFileTree } from '../lib/fileTree'
import { letterFromStatus, splitPath, statusLabel } from '../lib/paths'
import { FileStatusIcon } from './FileStatusIcon'
import { ToolbarIcon } from './ToolbarIcon'
import { useI18n, type MessageKey } from '../i18n'
import { formatGraphCommitDate } from '../lib/graphDate'
import { useGraphDateFormat } from '../lib/useGraphDateFormat'
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
  /** Path currently shown in the diff viewer, when the commit diff is open. */
  activePath?: string
  onShowDiff: (sha: string, path?: string) => void
  onClose: () => void
}

type FileView = 'path' | 'tree'

const NO_FILES: CommitFile[] = []

function refScope(ref: string): 'remote' | 'local' {
  return /refs\/remotes\/|(^|\/)origin\//.test(ref) ? 'remote' : 'local'
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

export function CommitDetailPanel({ detail, loading, error, activePath, onShowDiff, onClose }: Props) {
  const { t, plural, locale } = useI18n()
  const graphDate = useGraphDateFormat()
  const filesRef = useRef<HTMLDivElement>(null)
  const [fileView, setFileView] = useState<FileView>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const sha = detail?.summary.sha ?? ''
  const [collapsedSha, setCollapsedSha] = useState(sha)
  if (collapsedSha !== sha) {
    setCollapsedSha(sha)
    setCollapsed(new Set())
  }
  const files = detail?.files ?? NO_FILES
  const tree = useMemo(
    () => (fileView === 'tree' ? flattenFileTree(buildFileTree(files), collapsed) : []),
    [files, fileView, collapsed],
  )

  const toggleDir = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  useEffect(() => {
    if (!activePath) return
    const current = filesRef.current?.querySelector('[aria-current="true"]')
    if (current instanceof HTMLElement) {
      current.scrollIntoView({ block: 'nearest' })
    }
  }, [activePath])

  const close = (
    <button type="button" className={styles.close} data-frame="icon" data-kind="close" onClick={onClose} aria-label={t('diff.commit.closeAria')}>
      <ToolbarIcon name="x" size={14} />
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
  const authoredAt = commit.author.timestamp
  const authoredLabel = formatGraphCommitDate(authoredAt, graphDate, locale)
  const authoredExact = formatGraphCommitDate(
    authoredAt,
    graphDate === 'relative' ? 'dateTime' : graphDate,
    locale,
  )
  const rawBody = detail.message.trim()
  const body = rawBody.startsWith(subject) ? rawBody.slice(subject.length).trim() : rawBody
  const additions = detail.files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  const hasStats = detail.files.some((file) => !file.binary)
  const fileCount = detail.files.length

  const fileButton = (file: CommitFile, depth: number, nested: boolean) => {
    const current = Boolean(activePath && activePath === file.path)
    return (
      <div key={`${file.status}-${file.oldPath ?? ''}-${file.path}`} className={styles.fileRow}>
        <button
          type="button"
          className={current ? styles.fileActive : styles.file}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-diff-file={file.path}
          aria-current={current ? 'true' : undefined}
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
            <FileStatusIcon letter={file.status} />
          </span>
          <span className={styles.path}>
            {nested ? <span className={styles.name}>{splitPath(file.path).name}</span> : <PathLabel path={file.path} />}
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
      </div>
    )
  }

  return (
    <aside className={styles.panel} aria-label={t('diff.commit.aria')}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.panelTitle}>{t('diff.commit.title')}</span>
          <code className={styles.sha} title={commit.sha}>{commit.sha.slice(0, 12)}</code>
          {close}
        </div>
        {commit.refs.length > 0 ? (
          <div className={styles.refs}>
            {commit.refs.map((ref) => (
              <span key={ref} className={styles.ref} data-scope={refScope(ref)} title={ref}>
                {ref.replace('HEAD -> ', '').replace(/^refs\/(heads|remotes)\//, '')}
              </span>
            ))}
          </div>
        ) : null}
        <h2 className={styles.subject} title={subject}>{subject}</h2>
        <p className={styles.meta}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('diff.commit.author')}</span>
            <span className={styles.author}>{commit.author.name}</span>
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('diff.commit.date')}</span>
            <span title={authoredExact}>
              {authoredLabel}
              {authoredLabel !== authoredExact ? ` · ${authoredExact}` : ''}
            </span>
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('diff.commit.parentsLabel')}</span>
            <span>{plural('diff.commit.parents.one', 'diff.commit.parents.other', commit.parents.length)}</span>
          </span>
          {detail.signature ? (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('diff.commit.signatureLabel')}</span>
              <span
                className={styles.signature}
                data-code={detail.signature}
                title={t(SIGNATURE_LABELS[detail.signature] ?? 'diff.commit.signature.other')}
              >
                {t(SIGNATURE_LABELS[detail.signature] ?? 'diff.commit.signature.other')}
              </span>
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
          <div className={styles.filesTools}>
            {hasStats ? (
              <span className={styles.changeSummary}>
                <span className={styles.add}>+{additions}</span>
                <span className={styles.del}>−{deletions}</span>
              </span>
            ) : null}
            <div className={styles.viewToggle} role="group" aria-label={t('diff.comparison.viewAria')}>
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
        </div>
        {detail.filesTruncated ? (
          <p className={styles.note}>{t('diff.commit.filesPartial')}</p>
        ) : null}
        <div ref={filesRef} className={styles.files}>
          {fileView === 'tree'
            ? tree.map((row) =>
                row.kind === 'dir' ? (
                  <button
                    key={`dir:${row.key}`}
                    type="button"
                    className={styles.dir}
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    aria-expanded={row.open}
                    onClick={() => toggleDir(row.key)}
                    title={row.name}
                  >
                    <span className={styles.caret} aria-hidden="true">
                      <ToolbarIcon name={row.open ? 'chevron' : 'chevronRight'} size={12} />
                    </span>
                    <span className={styles.dirName}>{row.name}</span>
                    <span className={styles.dirCount}>{row.count}</span>
                  </button>
                ) : (
                  fileButton(row.item, row.depth, true)
                ),
              )
            : detail.files.map((file) => fileButton(file, 0, false))}
        </div>
      </section>
    </aside>
  )
}
