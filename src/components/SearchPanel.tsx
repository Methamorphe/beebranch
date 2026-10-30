import { useEffect, useRef, useState } from 'react'
import {
  operationCancel,
  preferenceGet,
  preferenceSet,
  searchCommits,
  searchContent,
  searchPaths,
  type DiffRequest,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { dateFromSeconds, formatDateTime, useI18n, type MessageKey } from '../i18n'
import type {
  ContentSearch,
  PathSearch,
  SearchMode,
  SearchResult,
} from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  onOpenDiff: (request: DiffRequest) => void
  onShowInGraph: (sha: string) => void
  onOpenFile: (path: string) => void
}

type Mode = SearchMode | 'path' | 'content'

const MODES: { value: Mode; labelKey: MessageKey }[] = [
  { value: 'message', labelKey: 'search.mode.message' },
  { value: 'author', labelKey: 'search.mode.author' },
  { value: 'sha', labelKey: 'search.mode.sha' },
  { value: 'path', labelKey: 'search.mode.path' },
  { value: 'content', labelKey: 'search.mode.content' },
]

const PLACEHOLDERS: Record<Mode, MessageKey> = {
  message: 'search.placeholder.message',
  author: 'search.placeholder.author',
  sha: 'search.placeholder.sha',
  path: 'search.placeholder.path',
  content: 'search.placeholder.content',
}

/** One search configuration kept per repository. */
type SavedSearch = {
  id: string
  label: string
  mode: Mode
  text: string
  depth: number
  allRefs: boolean
  revision: string
  path: string
  author: string
  since: string
  until: string
}

const SAVED_SEARCHES_KEY = 'ui.savedSearches'
const SAVED_SEARCHES_LIMIT = 20

/** Read the per-repository saved searches; a corrupt entry is dropped. */
function parseSaved(raw: string | null, repoId: string): SavedSearch[] {
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return []
    }
    const byRepo = parsed as Record<string, unknown>
    const list = byRepo[repoId]
    if (!Array.isArray(list)) {
      return []
    }
    return list
      .filter((entry): entry is SavedSearch => {
        if (!entry || typeof entry !== 'object') {
          return false
        }
        const candidate = entry as Partial<SavedSearch>
        return (
          typeof candidate.id === 'string' &&
          typeof candidate.label === 'string' &&
          typeof candidate.text === 'string' &&
          typeof candidate.mode === 'string' &&
          typeof candidate.depth === 'number'
        )
      })
      .slice(0, SAVED_SEARCHES_LIMIT)
  } catch {
    return []
  }
}

export function SearchPanel({
  repoId,
  onShowInGraph,
  onOpenFile,
}: Props) {
  const { t, plural } = useI18n()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('message')
  const [depth, setDepth] = useState(5000)
  const [allRefs, setAllRefs] = useState(false)
  const [revision, setRevision] = useState('')
  const [pathScope, setPathScope] = useState('')
  const [author, setAuthor] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [paths, setPaths] = useState<PathSearch | null>(null)
  const [content, setContent] = useState<ContentSearch | null>(null)
  const [busy, setBusy] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const requestRef = useRef(0)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const runRef = useRef<(after?: string, offset?: number) => Promise<void>>(async () => {})

  const run = async (after?: string, offset = 0) => {
    if (!text.trim()) {
      return
    }
    if (running.current) {
      // A newer query supersedes the one in flight: invalidate its result and
      // abort the process instead of queueing behind it.
      requestRef.current += 1
      if (operationId) {
        void operationCancel(operationId).catch(() => undefined)
      }
      running.current = false
    }
    running.current = true
    const token = ++requestRef.current
    setBusy(true)
    setError(null)
    try {
      if (mode === 'path') {
        setPaths(await searchPaths(repoId, text.trim(), 300, offset))
        setResult(null)
        setContent(null)
      } else if (mode === 'content') {
        const id = crypto.randomUUID()
        setOperationId(id)
        const found = await searchContent({
          repoId,
          text: text.trim(),
          path: pathScope.trim() || undefined,
          limit: 300,
          offset,
          operationId: id,
        })
        if (requestRef.current === token) {
          setContent(found)
          setResult(null)
          setPaths(null)
        }
      } else {
        const id = crypto.randomUUID()
        setOperationId(id)
        const found = await searchCommits({
          repoId,
          text: text.trim(),
          mode,
          revision: revision.trim() || undefined,
          allRefs,
          depth,
          path: pathScope.trim() || undefined,
          since: since.trim() || undefined,
          until: until.trim() || undefined,
          author: author.trim() || undefined,
          request: { after, limit: 100 },
          operationId: id,
        })
        if (requestRef.current === token) {
          setResult(found)
          setPaths(null)
          setContent(null)
        }
      }
    } catch (cause) {
      if (requestRef.current === token) {
        setError(errorMessage(cause))
      }
    } finally {
      if (requestRef.current === token) {
        setBusy(false)
        running.current = false
        setOperationId(null)
      }
    }
  }

  const cancel = async () => {
    if (operationId) {
      try {
        await operationCancel(operationId)
      } catch {
        // The process may already have finished.
      }
    }
    requestRef.current += 1
    setBusy(false)
    running.current = false
    setOperationId(null)
  }

  const commitMode = mode === 'message' || mode === 'author' || mode === 'sha'

  runRef.current = run

  // Live search: a short debounce for each keystroke; a new query cancels the
  // previous one, and one-character queries wait for an explicit submit.
  useEffect(() => {
    if (text.trim().length < 2) {
      return
    }
    const timer = window.setTimeout(() => {
      void runRef.current()
    }, 350)
    return () => window.clearTimeout(timer)
  }, [text, mode, revision, allRefs, depth, since, until, author, pathScope])

  useEffect(() => {
    let cancelled = false
    void preferenceGet(SAVED_SEARCHES_KEY)
      .then((raw) => {
        if (!cancelled) {
          setSaved(parseSaved(raw, repoId))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId])

  const persistSaved = async (next: SavedSearch[]) => {
    setSaved(next)
    try {
      const raw = await preferenceGet(SAVED_SEARCHES_KEY)
      const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      all[repoId] = next
      await preferenceSet(SAVED_SEARCHES_KEY, JSON.stringify(all))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const saveCurrent = () => {
    const label = text.trim()
    if (!label) {
      return
    }
    const entry: SavedSearch = {
      id: crypto.randomUUID(),
      label,
      mode,
      text: label,
      depth,
      allRefs,
      revision,
      path: pathScope,
      author,
      since,
      until,
    }
    const next = [entry, ...saved.filter((item) => item.label !== label)].slice(
      0,
      SAVED_SEARCHES_LIMIT,
    )
    void persistSaved(next)
  }

  const applySaved = (entry: SavedSearch) => {
    setMode(entry.mode)
    setText(entry.text)
    setDepth(entry.depth)
    setAllRefs(entry.allRefs)
    setRevision(entry.revision)
    setPathScope(entry.path)
    setAuthor(entry.author)
    setSince(entry.since)
    setUntil(entry.until)
  }

  const scope = [
    allRefs ? t('search.scope.allRefs') : revision.trim() || 'HEAD',
    commitMode ? t('search.scope.depth', { depth }) : null,
    pathScope.trim() ? t('search.scope.path', { path: pathScope.trim() }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const total =
    mode === 'path'
      ? (paths?.items.length ?? 0)
      : mode === 'content'
        ? (content?.items.length ?? 0)
        : (result?.commits.length ?? 0)
  const truncated =
    mode === 'path'
      ? Boolean(paths?.truncated)
      : mode === 'content'
        ? Boolean(content?.truncated)
        : Boolean(result?.truncated)
  const hasResults =
    mode === 'path' ? paths !== null : mode === 'content' ? content !== null : result !== null

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <div className={p2.segmented} role="group" aria-label={t('search.typeAria')}>
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={mode === item.value ? p2.segmentOn : p2.segment}
              aria-pressed={mode === item.value}
              onClick={() => setMode(item.value)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <label className={`${p2.fieldInline} ${p2.grow}`}>
          <span className={p2.toolbarLabel}>{t('search.label')}</span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void run()
              }
            }}
            placeholder={t(PLACEHOLDERS[mode])}
            aria-label={t('search.termAria')}
            spellCheck={false}
          />
        </label>

        <button
          type="button"
          className={p2.primary}
          disabled={busy || !text.trim()}
          onClick={() => void run()}
        >
          {t('common.search')}
        </button>
        {busy ? (
          <button type="button" className={p2.ghost} onClick={() => void cancel()}>
            {t('common.cancel')}
          </button>
        ) : null}
        <button
          type="button"
          className={p2.ghost}
          disabled={!text.trim()}
          title={t('search.saveHint')}
          onClick={saveCurrent}
        >
          {t('search.save')}
        </button>
        <span className={p2.spacer} />
        <span className={p2.chip} title={t('search.scopeTitle')}>
          {scope}
        </span>
      </div>

      {saved.length > 0 ? (
        <div className={p2.toolbar} aria-label={t('search.savedAria')}>
          <span className={p2.toolbarLabel}>{t('search.savedLabel')}</span>
          {saved.map((entry) => (
            <span key={entry.id} className={p2.chip}>
              <button
                type="button"
                className={p2.linkButton}
                onClick={() => applySaved(entry)}
              >
                {entry.label}
              </button>
              <button
                type="button"
                className={p2.ghost}
                aria-label={t('search.savedRemove', { label: entry.label })}
                onClick={() =>
                  void persistSaved(saved.filter((item) => item.id !== entry.id))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className={p2.toolbar}>
        {commitMode ? (
          <>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('search.revisionLabel')}</span>
              <input
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                placeholder={t('search.revisionPlaceholder')}
                spellCheck={false}
              />
            </label>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={allRefs}
                onChange={(event) => setAllRefs(event.target.checked)}
              />
              {t('search.allRefs')}
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('search.depthLabel')}</span>
              <input
                value={depth}
                onChange={(event) => setDepth(Number(event.target.value) || 0)}
                inputMode="numeric"
                aria-label={t('search.depthAria')}
              />
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('search.mode.author')}</span>
              <input
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder={t('search.authorPlaceholder')}
                aria-label={t('search.authorAria')}
              />
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('search.sinceLabel')}</span>
              <input
                value={since}
                onChange={(event) => setSince(event.target.value)}
                placeholder="2026-01-01"
                aria-label={t('search.sinceAria')}
              />
            </label>
            <label className={p2.fieldInline}>
              <span className={p2.toolbarLabel}>{t('search.untilLabel')}</span>
              <input
                value={until}
                onChange={(event) => setUntil(event.target.value)}
                placeholder="2026-12-31"
                aria-label={t('search.untilAria')}
              />
            </label>
          </>
        ) : null}
        <label className={p2.fieldInline}>
          <span className={p2.toolbarLabel}>{t('search.mode.path')}</span>
          <input
            value={pathScope}
            onChange={(event) => setPathScope(event.target.value)}
            placeholder="src/"
            aria-label={t('search.pathAria')}
            spellCheck={false}
          />
        </label>
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          {hasResults ? (
            <div className={p2.listHeader}>
              <span className={p2.label}>
                {mode === 'content'
                  ? plural('search.results.matches.one', 'search.results.matches.other', total)
                  : mode === 'path'
                    ? plural('search.results.paths.one', 'search.results.paths.other', total)
                    : plural('search.results.commits.one', 'search.results.commits.other', total)}
                {mode === 'content' && content?.path ? ` · ${content.path}` : ''}
              </span>
              {truncated ? (
                <span className={`${p2.chip} ${p2.chipWarn}`}>{t('search.resultsCapped')}</span>
              ) : null}
              <span className={p2.spacer} />
              {busy ? <span className={p2.count}>{t('search.running')}</span> : null}
            </div>
          ) : null}

          {mode === 'path' && paths ? (
            <div className={p2.rows}>
              {paths.items.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className={p2.entry}
                  onClick={() => onOpenFile(item.path)}
                >
                  <span className={p2.meta} aria-hidden="true">
                    ⌖
                  </span>
                  <span className={p2.entryStack}>
                    <span className={`${p2.entryTitle} ${p2.mono}`}>{item.path}</span>
                    <span className={p2.entryMeta}>{t('search.openFileHistory')}</span>
                  </span>
                  <span className={p2.meta} aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {mode === 'content' && content ? (
            <div className={p2.rows}>
              {content.items.map((item) => (
                <button
                  key={`${item.path}:${item.line}:${item.text}`}
                  type="button"
                  className={p2.entry}
                  onClick={() => onOpenFile(item.path)}
                >
                  <span className={`${p2.count} ${p2.tabnum}`}>
                    {t('search.line')} {item.line}
                  </span>
                  <span className={p2.entryStack}>
                    <span className={`${p2.entryTitle} ${p2.mono}`}>{item.path}</span>
                    <span className={`${p2.entryMeta} ${p2.mono}`}>{item.text.trim()}</span>
                  </span>
                  <span className={p2.meta} aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {commitMode && result ? (
            <div className={p2.rows}>
              {result.commits.map((commit) => (
                <button
                  key={commit.sha}
                  type="button"
                  className={p2.entry}
                  onClick={() => onShowInGraph(commit.sha)}
                >
                  <span className={`${p2.count} ${p2.mono}`}>
                    {commit.sha.slice(0, 8)}
                  </span>
                  <span className={p2.entryStack}>
                    <span className={p2.entryTitle}>{commit.subject}</span>
                    <span className={p2.entryMeta}>
                      <span>{commit.author.name}</span>
                      <span>·</span>
                      <span>{formatDateTime(dateFromSeconds(commit.author.timestamp))}</span>
                    </span>
                  </span>
                  <span className={p2.meta} aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {commitMode && result?.next ? (
            <div className={p2.footerBar}>
              <span className={p2.count}>{t('search.nextPageAvailable')}</span>
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.secondary}
                disabled={busy}
                onClick={() => void run(result.next)}
              >
                {t('search.nextPage')}
              </button>
            </div>
          ) : null}

          {!commitMode && (paths?.next != null || content?.next != null) ? (
            <div className={p2.footerBar}>
              <span className={p2.count}>{t('search.nextPageAvailable')}</span>
              <span className={p2.spacer} />
              <button
                type="button"
                className={p2.secondary}
                disabled={busy}
                onClick={() => void run(undefined, paths?.next ?? content?.next ?? 0)}
              >
                {t('search.nextPage')}
              </button>
            </div>
          ) : null}

          {!busy && !error && hasResults && total === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('common.noResults')}</h2>
              <p>{t('search.emptyBody')}</p>
            </div>
          ) : null}

          {!busy && !hasResults ? (
            <div className={p2.empty}>
              <h2>{t('search.title')}</h2>
              <p>{t('search.intro')}</p>
            </div>
          ) : null}

          {busy && !hasResults ? (
            <div className={p2.empty} role="status">
              <h2>{t('search.runningTitle')}</h2>
              <p>{t('search.runningBody')}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
