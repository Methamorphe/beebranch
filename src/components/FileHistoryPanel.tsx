import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  blameGet,
  fileHistoryGet,
  statusGet,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { dateFromSeconds, formatDateTime, useI18n } from '../i18n'
import type { BlameReport, FileHistory } from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  initialPath?: string
  onShowCommit: (sha: string) => void
  /** Opens the diff of the file at a revision. */
  onShowDiff?: (path: string, revision: string) => void
}

type Tab = 'history' | 'blame'

/**
 * Stable colour per author: the same name always gets the same tone, whatever
 * the order of the log. Six tones keep the palette readable and theme-aware.
 */
const AUTHOR_TONES = ['accent', 'info', 'good', 'warn', 'bad', ''] as const

function authorTone(author: string): string {
  let hash = 0
  for (let index = 0; index < author.length; index += 1) {
    hash = (hash * 31 + author.charCodeAt(index)) % 4096
  }
  return AUTHOR_TONES[hash % AUTHOR_TONES.length] ?? ''
}

const STATUS_TONE: Record<string, string> = {
  A: p2.chipGood,
  D: p2.chipBad,
  R: p2.chipInfo,
  C: p2.chipInfo,
  M: p2.chipWarn,
}

export function FileHistoryPanel({
  repoId,
  generation,
  initialPath,
  onShowCommit,
  onShowDiff,
}: Props) {
  const { t, plural } = useI18n()
  const [paths, setPaths] = useState<string[]>([])
  const [path, setPath] = useState(initialPath ?? '')
  const [revision, setRevision] = useState('')
  const [tab, setTab] = useState<Tab>('history')
  const [follow, setFollow] = useState(true)
  const [history, setHistory] = useState<FileHistory | null>(null)
  const [blame, setBlame] = useState<BlameReport | null>(null)
  const [start, setStart] = useState('1')
  const [end, setEnd] = useState('400')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialPath) {
      setPath(initialPath)
    }
  }, [initialPath])

  useEffect(() => {
    let cancelled = false
    void statusGet(repoId)
      .then((result) => {
        if (cancelled) {
          return
        }
        const unique = Array.from(
          new Set(
            result.data.entries
              .map((entry) => entry.path)
              .filter((value) => Boolean(value)),
          ),
        ).slice(0, 400)
        setPaths(unique)
        setPath((current) => current || unique[0] || '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId, generation])

  const load = useCallback(async (nextPath = path) => {
    if (!nextPath.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (tab === 'history') {
        setHistory(
          await fileHistoryGet({
            repoId,
            path: nextPath.trim(),
            follow,
            maxEntries: 300,
            revision: revision.trim() || undefined,
          }),
        )
      } else {
        setBlame(
          await blameGet({
            repoId,
            path: nextPath.trim(),
            start: Number(start) || 1,
            end: Number(end) || 400,
            maxLines: 2000,
          }),
        )
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [repoId, tab, follow, start, end, path, revision])

  useEffect(() => {
    if (path.trim()) {
      void load()
    }
  }, [load, path])

  const groups = useMemo(() => {
    const result: { sha: string; author: string; time: number; summary: string; start: number; lines: string[] }[] = []
    for (const line of blame?.lines ?? []) {
      const last = result[result.length - 1]
      if (!last || last.sha !== line.sha) {
        result.push({
          sha: line.sha,
          author: line.author,
          time: line.authorTime,
          summary: line.summary,
          start: line.line,
          lines: [line.content],
        })
      } else {
        last.lines.push(line.content)
      }
    }
    return result
  }, [blame])

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <div className={p2.segmented} role="group" aria-label={t('diff.history.aria')}>
          <button
            type="button"
            className={tab === 'history' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'history'}
            onClick={() => setTab('history')}
          >
            {t('diff.history.tab')}
          </button>
          <button
            type="button"
            className={tab === 'blame' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'blame'}
            onClick={() => setTab('blame')}
          >
            {t('diff.history.blameTab')}
          </button>
        </div>

        <label className={`${p2.fieldInline} ${p2.grow}`}>
          <span className={p2.toolbarLabel}>{t('diff.history.file')}</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="src/App.tsx"
            aria-label={t('diff.history.pathAria')}
            list="file-history-paths"
            spellCheck={false}
          />
        </label>
        <datalist id="file-history-paths">
          {paths.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>

        {tab === 'history' ? (
          <>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('diff.history.revision')}</span>
              <input
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                placeholder="HEAD"
                aria-label={t('diff.history.revisionAria')}
                spellCheck={false}
              />
            </label>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              {t('diff.history.followRenames')}
            </label>
          </>
        ) : (
          <>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('diff.history.line')}</span>
              <input
                value={start}
                onChange={(event) => setStart(event.target.value)}
                inputMode="numeric"
                aria-label={t('diff.history.firstLineAria')}
              />
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('diff.history.to')}</span>
              <input
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                inputMode="numeric"
                aria-label={t('diff.history.lastLineAria')}
              />
            </label>
          </>
        )}

        <button
          type="button"
          className={p2.secondary}
          disabled={busy || !path.trim()}
          onClick={() => void load()}
        >
          {busy ? t('diff.history.loading') : t('diff.history.load')}
        </button>
        {onShowDiff ? (
          <button
            type="button"
            className={p2.ghost}
            disabled={!path.trim()}
            title={t('diff.history.diffHint')}
            onClick={() => onShowDiff(path.trim(), revision.trim() || 'HEAD')}
          >
            {t('diff.history.diff')}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          {tab === 'history' ? (
            history ? (
              <>
                <div className={p2.listHeader}>
                  <span className={`${p2.label} ${p2.mono}`}>{history.path}</span>
                  <span className={`${p2.count} ${p2.tabnum}`}>
                    {plural('diff.history.commits.one', 'diff.history.commits.other', history.entries.length)}
                  </span>
                  <span className={p2.spacer} />
                  {history.truncated ? (
                    <span className={`${p2.chip} ${p2.chipWarn}`}>{t('diff.history.capped')}</span>
                  ) : null}
                  {history.follow ? (
                    <span className={`${p2.chip} ${p2.chipInfo}`}>{t('diff.history.renamesFollowed')}</span>
                  ) : null}
                </div>
                <div className={p2.rows}>
                  {history.entries.map((entry) => (
                    <button
                      key={`${entry.sha}-${entry.status}`}
                      type="button"
                      className={p2.entry}
                      onClick={() => onShowCommit(entry.sha)}
                    >
                      <span className={`${p2.chip} ${STATUS_TONE[entry.status] ?? ''}`}>
                        {entry.status}
                      </span>
                      <span className={p2.entryStack}>
                        <span className={p2.entryTitle}>{entry.subject}</span>
                        <span className={p2.entryMeta}>
                          <span className={p2.mono}>{entry.sha.slice(0, 8)}</span>
                          <span>·</span>
                          <span>{entry.author}</span>
                          <span>·</span>
                          <span>{formatDateTime(dateFromSeconds(entry.authorTime))}</span>
                          {entry.previousPath ? (
                            <>
                              <span>·</span>
                              <span className={p2.mono}>{t('diff.history.fromPath', { path: entry.previousPath })}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      <span className={p2.meta} aria-hidden="true">
                        →
                      </span>
                    </button>
                  ))}
                </div>
                {history.entries.length === 0 ? (
                  <div className={p2.empty} role="status">
                    <h2>{t('diff.history.emptyTitle')}</h2>
                    <p>{t('diff.history.emptyHint')}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <div className={p2.empty}>
                <h2>{t('diff.history.pickTitle')}</h2>
                <p>{t('diff.history.pickHint')}</p>
              </div>
            )
          ) : blame ? (
            <>
              <div className={p2.listHeader}>
                <span className={`${p2.label} ${p2.mono}`}>{blame.path}</span>
                <span className={`${p2.count} ${p2.tabnum}`}>
                  {t('diff.history.linesRange', { first: blame.firstLine, last: blame.lastLine })}
                </span>
                <span className={p2.spacer} />
                {blame.truncated ? (
                  <span className={`${p2.chip} ${p2.chipWarn}`}>{t('diff.blame.capped')}</span>
                ) : null}
              </div>
              <div className={p2.scroller}>
                {groups.map((group) => (
                  <section
                    key={`${group.sha}-${group.start}`}
                    className={p2.blameGroup}
                  >
                    <button
                      type="button"
                      className={p2.blameHeader}
                      onClick={() => onShowCommit(group.sha)}
                      title={group.summary}
                    >
                      <span className={p2.mono}>{group.sha.slice(0, 8)}</span>
                      <span className={p2.entryMeta}>
                        <span className={p2.dot} data-tone={authorTone(group.author) || undefined} />
                        <span>{group.author}</span>
                        <span>·</span>
                        <span>{formatDateTime(dateFromSeconds(group.time))}</span>
                        <span>·</span>
                        <span>{group.summary}</span>
                      </span>
                    </button>
                    <pre className={p2.blameCode}>
                      {group.lines
                        .map(
                          (line, index) =>
                            `${String(group.start + index).padStart(5)}  ${line}`,
                        )
                        .join('\n')}
                    </pre>
                  </section>
                ))}
                {blame.lines.length === 0 ? (
                  <div className={p2.empty} role="status">
                    <h2>{t('diff.blame.emptyTitle')}</h2>
                    <p>{t('diff.blame.emptyHint')}</p>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className={p2.empty}>
              <h2>{t('diff.blame.title')}</h2>
              <p>{t('diff.blame.hint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
