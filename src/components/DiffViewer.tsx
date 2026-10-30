import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { DiffHunk, DiffLine, DiffReport, FileContent, FileDiff, HunkSelection, PathSelection } from '../types/git'
import { indexDiscard, indexStage, indexUnstage } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { STATUS_LABELS, STATUS_LETTERS, splitPath } from '../lib/paths'
import { dateFromSeconds, formatDate, formatNumber, useI18n, type MessageKey } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { Markdown } from './Markdown'
import shared from './p1.module.css'
import styles from './DiffViewer.module.css'

// CodeMirror and the language modes are only needed once a file is edited:
// keeping them in a separate chunk leaves startup untouched.
const FileEditorPane = lazy(() =>
  import('./FileEditorPane').then((module) => ({
    default: module.FileEditorPane,
  })),
)

type Mode = 'hunk' | 'inline' | 'split'

type Row =
  | { kind: 'hunk'; hunk: number; header: string }
  | {
      kind: 'line'
      hunk: number
      left?: DiffLine
      right?: DiffLine
      leftIndex?: number
      rightIndex?: number
      tone: 'context' | 'added' | 'removed' | 'mixed'
      /** Emphasis for a paired line: computed when a change block has both sides. */
      leftWords?: WordDiff
      rightWords?: WordDiff
    }

const LINE_HEIGHT = 24
const OVERSCAN = 12
const HIGHLIGHT_LIMIT = 2000

const KEYWORDS: Record<string, string[]> = {
  rust: [
    'fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'if',
    'else', 'for', 'while', 'loop', 'return', 'use', 'mod', 'self', 'Self',
    'where', 'async', 'await', 'move', 'const', 'static', 'type', 'ref',
  ],
  ts: [
    'const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'import',
    'from', 'export', 'default', 'type', 'interface', 'class', 'extends', 'new',
    'async', 'await', 'try', 'catch', 'throw', 'switch', 'case', 'break',
    'continue', 'null', 'undefined', 'true', 'false',
  ],
  python: [
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
    'from', 'as', 'try', 'except', 'with', 'lambda', 'None', 'True', 'False',
  ],
  shell: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'case', 'esac', 'function', 'local'],
  dart: [
    'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch',
    'class', 'const', 'continue', 'covariant', 'default', 'deferred', 'do',
    'dynamic', 'else', 'enum', 'export', 'extends', 'extension', 'external',
    'factory', 'false', 'final', 'finally', 'for', 'get', 'hide', 'if',
    'implements', 'import', 'in', 'interface', 'is', 'late', 'library',
    'mixin', 'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow',
    'return', 'sealed', 'set', 'show', 'static', 'super', 'switch', 'sync',
    'this', 'throw', 'true', 'try', 'typedef', 'var', 'void', 'when', 'while',
    'with', 'yield', 'Future', 'Stream', 'String', 'int', 'double', 'bool',
    'List', 'Map', 'Set', 'Widget', 'BuildContext', 'ChangeNotifier',
  ],
}

function languageFor(path: string): keyof typeof KEYWORDS | null {
  if (/\.(rs)$/.test(path)) return 'rust'
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'ts'
  if (/\.(py)$/.test(path)) return 'python'
  if (/\.(sh|bash|zsh)$/.test(path)) return 'shell'
  if (/\.(dart)$/.test(path)) return 'dart'
  return null
}

function highlight(content: string, path: string) {
  const language = languageFor(path)
  if (!language || content.length > HIGHLIGHT_LIMIT) {
    return content
  }
  const keywords = KEYWORDS[language]!
  const pattern =
    /(\/\/.*$|#.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g
  const parts: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) {
      parts.push(content.slice(last, match.index))
    }
    const text = match[0]
    if (match[1]) {
      parts.push(
        <span key={key++} className={styles.comment}>
          {text}
        </span>,
      )
    } else if (match[2]) {
      parts.push(
        <span key={key++} className={styles.string}>
          {text}
        </span>,
      )
    } else if (match[3]) {
      parts.push(
        <span key={key++} className={styles.numeric}>
          {text}
        </span>,
      )
    } else if (match[4] && keywords.includes(match[4])) {
      parts.push(
        <span key={key++} className={styles.keyword}>
          {text}
        </span>,
      )
    } else {
      parts.push(text)
    }
    last = match.index + text.length
  }
  if (last < content.length) {
    parts.push(content.slice(last))
  }
  return parts
}

function hunkHeader(hunk: DiffHunk): string {
  const section = hunk.section ? ` ${hunk.section}` : ''
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}`
}

function buildRows(file: FileDiff, mode: Mode): Row[] {
  const rows: Row[] = []
  file.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ kind: 'hunk', hunk: hunkIndex, header: hunkHeader(hunk) })
    if (mode === 'hunk') {
      hunk.lines.forEach((line, lineIndex) => {
        if (line.kind === 'context') {
          return
        }
        rows.push({
          kind: 'line',
          hunk: hunkIndex,
          left: line.kind === 'removed' ? line : undefined,
          right: line.kind === 'added' ? line : undefined,
          leftIndex: line.kind === 'removed' ? lineIndex : undefined,
          rightIndex: line.kind === 'added' ? lineIndex : undefined,
          tone: line.kind,
        })
      })
      return
    }
    if (mode === 'inline') {
      // Removed and added lines are emitted in git order, but each pair shares
      // its prefix/suffix so the changed words stand out inside the line.
      let block: Array<{ line: DiffLine; index: number }> = []
      const flushBlock = () => {
        const removed = block.filter((entry) => entry.line.kind === 'removed')
        const added = block.filter((entry) => entry.line.kind === 'added')
        const paired = Math.min(removed.length, added.length)
        let removedSeen = 0
        let addedSeen = 0
        for (const entry of block) {
          const isRemoved = entry.line.kind === 'removed'
          const position = isRemoved ? removedSeen++ : addedSeen++
          const words =
            position < paired
              ? wordDiff(
                  removed[position]!.line.content,
                  added[position]!.line.content,
                )
              : undefined
          rows.push({
            kind: 'line',
            hunk: hunkIndex,
            left: isRemoved ? entry.line : undefined,
            right: isRemoved ? undefined : entry.line,
            leftIndex: isRemoved ? entry.index : undefined,
            rightIndex: isRemoved ? undefined : entry.index,
            tone: isRemoved ? 'removed' : 'added',
            leftWords: isRemoved ? words : undefined,
            rightWords: isRemoved ? undefined : words,
          })
        }
        block = []
      }
      hunk.lines.forEach((line, lineIndex) => {
        if (line.kind === 'context') {
          flushBlock()
          rows.push({
            kind: 'line',
            hunk: hunkIndex,
            left: line,
            right: line,
            leftIndex: lineIndex,
            rightIndex: lineIndex,
            tone: 'context',
          })
          return
        }
        block.push({ line, index: lineIndex })
      })
      flushBlock()
      return
    }

    let removed: Array<{ line: DiffLine; index: number }> = []
    let added: Array<{ line: DiffLine; index: number }> = []
    const flush = () => {
      const length = Math.max(removed.length, added.length)
      for (let index = 0; index < length; index += 1) {
        const left = removed[index]
        const right = added[index]
        rows.push({
          kind: 'line',
          hunk: hunkIndex,
          left: left?.line,
          right: right?.line,
          leftIndex: left?.index,
          rightIndex: right?.index,
          tone: left && right ? 'mixed' : left ? 'removed' : 'added',
        })
      }
      removed = []
      added = []
    }

    hunk.lines.forEach((line, lineIndex) => {
      if (line.kind === 'context') {
        flush()
        rows.push({
          kind: 'line',
          hunk: hunkIndex,
          left: line,
          right: line,
          tone: 'context',
        })
      } else if (line.kind === 'removed') {
        removed.push({ line, index: lineIndex })
      } else {
        added.push({ line, index: lineIndex })
      }
    })
    flush()
  })
  return rows
}

type Staging = {
  repoId: string
  target: 'worktree' | 'index'
  onMutated: () => void
}

type CommitContext = {
  sha: string
  subject: string
  author: string
  timestamp: number
}

/** Loads one file at the revision the current diff was computed for. */
export type DocumentReader = (path: string) => Promise<FileContent>

/** One comment anchored on a diff line, ready for the provider. */
export type LineCommentRequest = {
  /** Path on the old side; a rename differs from {@link newPath}. */
  oldPath: string
  /** Path on the new side; a deletion keeps the old path here. */
  newPath: string
  side: 'new' | 'old'
  /** Number printed in the gutter, never a hunk offset. */
  line: number
  content: string
}

type LineComment = {
  onComment: (request: LineCommentRequest) => void
  /** The provider accepts ```suggestion blocks inside inline comments. */
  suggestions: boolean
}

type Props = {
  report: DiffReport
  source: string
  commit?: CommitContext
  embedded?: boolean
  staging?: Staging
  /** Present when the commit is HEAD and can be amended; click opens it. */
  onAmend?: () => void
  /** Present when the caller can resolve files at the diff revision. */
  readDocument?: DocumentReader
  /** Opens the file history for the visible file. */
  onShowHistory?: (path: string) => void
  /** Present when the diff is a review request accepting line comments. */
  lineComment?: LineComment
}

const MARKDOWN_PATH = /\.(md|markdown|mdown|mkd|mdx)$/i

const MODE_LABELS: Record<Mode, MessageKey> = {
  hunk: 'diff.mode.hunk',
  inline: 'diff.mode.inline',
  split: 'diff.mode.split',
}

const MODE_TITLES: Record<Mode, MessageKey> = {
  hunk: 'diff.mode.title.hunk',
  inline: 'diff.mode.title.inline',
  split: 'diff.mode.title.split',
}

const TONE_CLASS = (tone: 'context' | 'added' | 'removed' | 'mixed') => {
  switch (tone) {
    case 'added':
      return styles.toneAdded
    case 'removed':
      return styles.toneRemoved
    case 'mixed':
      return styles.toneMixed
    default:
      return styles.toneContext
  }
}

/**
 * Where a comment on this row anchors.
 *
 * The new side wins when the line exists there, otherwise the old side. The
 * number is the one the viewer prints for that line (`oldLineno`/`newLineno`),
 * so the provider's inline comment lands on the displayed line.
 */
function commentAnchor(
  row: Extract<Row, { kind: 'line' }>,
  file: FileDiff,
): LineCommentRequest | null {
  // `/dev/null` is never a position the provider accepts: an added file keeps
  // the new path on both sides, a deleted one keeps the old path.
  const oldPath = file.oldPath === '/dev/null' ? file.newPath : file.oldPath
  const newPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath
  if (row.right && row.right.newLineno !== undefined) {
    return {
      oldPath,
      newPath,
      side: 'new',
      line: row.right.newLineno,
      content: row.right.content,
    }
  }
  if (row.left && row.left.oldLineno !== undefined) {
    return {
      oldPath,
      newPath,
      side: 'old',
      line: row.left.oldLineno,
      content: row.left.content,
    }
  }
  return null
}

type WordDiff = {
  prefix: string
  left: string
  right: string
  suffix: string
}

/** Common prefix/suffix kept out of the emphasis so paired lines stay readable. */
function wordDiff(left: string, right: string): WordDiff {
  const max = Math.min(left.length, right.length)
  let start = 0
  while (start < max && left[start] === right[start]) start += 1
  let end = 0
  while (
    end < max - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  ) {
    end += 1
  }
  return {
    prefix: left.slice(0, start),
    left: left.slice(start, left.length - end),
    right: right.slice(start, right.length - end),
    suffix: left.slice(left.length - end),
  }
}

function PathParts({ path }: { path: string }) {
  const { directory, name } = splitPath(path)
  return (
    <>
      {directory ? <span className={styles.directory}>{directory}</span> : null}
      <span className={styles.name}>{name}</span>
    </>
  )
}

export function DiffViewer({ report, source, commit, staging, embedded = false, onAmend, readDocument, onShowHistory, lineComment }: Props) {
  const { t, plural } = useI18n()
  const [mode, setMode] = useState<Mode>('inline')
  const [wrap, setWrap] = useState(() => {
    try {
      return window.localStorage.getItem('ui.diffWrap') === 'true'
    } catch {
      return false
    }
  })
  const [contentHeight, setContentHeight] = useState(0)
  const [active, setActive] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [lineSelection, setLineSelection] = useState<Record<number, number[]>>({})
  const [hunkSelection, setHunkSelection] = useState<number[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rendered, setRendered] = useState(false)
  /** Path open in the in-app editor, or `null` when the editor is closed. */
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [documentState, setDocumentState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; value: FileContent }
    | { kind: 'error'; message: string }
    | null
  >(null)
  const documentCache = useRef<WeakMap<DiffReport, Map<string, FileContent>>>(new WeakMap())
  const [pendingDiscard, setPendingDiscard] = useState<{
    selection: PathSelection
    path: string
    sha256?: string
  } | null>(null)
  /** Row the composer is anchored to, or `null` when it is closed. */
  const [commentTarget, setCommentTarget] = useState<{
    oldPath: string
    newPath: string
    side: 'new' | 'old'
    line: number
  } | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const file = report.files[active]
  const rows = useMemo(
    () => (file ? buildRows(file, mode) : []),
    [file, mode],
  )
  /** Path at the target side of the diff, or the removed path when deleted. */
  const documentPath = file
    ? file.newPath === '/dev/null'
      ? file.oldPath
      : file.newPath
    : ''
  const markdown = Boolean(readDocument && documentPath && MARKDOWN_PATH.test(documentPath))

  useEffect(() => {
    if (!rendered || !readDocument || !markdown) {
      setDocumentState(null)
      return
    }
    // A new diff report means the target revision or the working copy changed:
    // the cache is scoped to it so a render never survives a refresh.
    let cache = documentCache.current.get(report)
    if (!cache) {
      cache = new Map()
      documentCache.current.set(report, cache)
    }
    const scopedCache = cache
    const cached = scopedCache.get(documentPath)
    if (cached) {
      setDocumentState({ kind: 'ready', value: cached })
      return
    }
    let cancelled = false
    setDocumentState({ kind: 'loading' })
    readDocument(documentPath)
      .then((value) => {
        scopedCache.set(documentPath, value)
        if (!cancelled) setDocumentState({ kind: 'ready', value })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDocumentState({ kind: 'error', message: errorMessage(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [documentPath, markdown, readDocument, rendered, report])

  useEffect(() => {
    setActive(0)
    setLineSelection({})
    setHunkSelection([])
    setPendingDiscard(null)
    setActionError(null)
    setActionNotice(null)
    setCommentTarget(null)
    setCommentBody('')
  }, [report])

  useEffect(() => {
    performance.mark('diff.first-paint')
  }, [rows.length])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight))
    observer.observe(element)
    setViewportHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Editing replaces the whole viewer: no modal, no navigation away from the
  // repository, and the file list cannot silently drop the draft.
  if (editingPath && staging) {
    return (
      <div className={`${styles.root} ${styles.editorMode}`}>
        <Suspense
          fallback={<p className={styles.empty}>{t('common.loading')}</p>}
        >
          <FileEditorPane
            key={editingPath}
            repoId={staging.repoId}
            path={editingPath}
            onClose={() => setEditingPath(null)}
            onSaved={() => {
              staging.onMutated()
              setRendered(false)
            }}
          />
        </Suspense>
      </div>
    )
  }

  if (report.files.length === 0) {
    return <p className={styles.empty}>{t('diff.empty.noChanges')}</p>
  }
  if (!file) {
    return <p className={styles.empty}>{t('diff.empty.selectFile')}</p>
  }

  const hunkRows = rows
    .map((row, index) => (row.kind === 'hunk' ? index : -1))
    .filter((index) => index >= 0)

  /** Switch file and drop a composer still anchored on the previous one. */
  const selectFile = (index: number) => {
    setActive(index)
    setCommentTarget(null)
    setCommentBody('')
  }

  const jump = (direction: -1 | 1) => {
    const scroll = scrollRef.current
    if (!scroll || hunkRows.length === 0) {
      return
    }
    const current = Math.round(scroll.scrollTop / LINE_HEIGHT)
    const target =
      direction > 0
        ? hunkRows.find((index) => index > current)
        : [...hunkRows].reverse().find((index) => index < current)
    if (target !== undefined) {
      scroll.scrollTop = target * LINE_HEIGHT
      setScrollTop(scroll.scrollTop)
    }
  }

  const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN)
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN,
  )
  const visible = rows.slice(first, last)
  /**
   * Wrapping gives rows a variable height, which the virtualised renderer
   * cannot place. Large diffs therefore stay virtualised and the toggle says so.
   */
  const WRAP_ROW_LIMIT = 600
  const wrapAvailable = rows.length <= WRAP_ROW_LIMIT
  /** Minimap window, in percent of the scrollable content. */
  const scrollTotal = contentHeight || rows.length * LINE_HEIGHT
  const minimapTop =
    scrollTotal > 0 ? Math.min(100, (scrollTop / scrollTotal) * 100) : 0
  const minimapHeight =
    scrollTotal > 0
      ? Math.min(100 - minimapTop, (viewportHeight / scrollTotal) * 100)
      : 0
  const capped = report.truncated || Boolean(file?.truncated)

  const rowLineIndices = (row: Row): number[] => {
    if (row.kind !== 'line') {
      return []
    }
    return [row.leftIndex, row.rightIndex].filter(
      (value): value is number => value !== undefined,
    )
  }

  const toggleLine = (row: Row) => {
    if (row.kind !== 'line') {
      return
    }
    const indices = rowLineIndices(row)
    if (indices.length === 0) {
      return
    }
    setHunkSelection((current) => current.filter((value) => value !== row.hunk))
    setLineSelection((current) => {
      const existing = new Set(current[row.hunk] ?? [])
      const allSelected = indices.every((index) => existing.has(index))
      for (const index of indices) {
        if (allSelected) {
          existing.delete(index)
        } else {
          existing.add(index)
        }
      }
      const next = { ...current }
      if (existing.size === 0) {
        delete next[row.hunk]
      } else {
        next[row.hunk] = [...existing].sort((left, right) => left - right)
      }
      return next
    })
  }

  const toggleHunk = (hunk: number) => {
    setLineSelection((current) => {
      if (!(hunk in current)) {
        return current
      }
      const next = { ...current }
      delete next[hunk]
      return next
    })
    setHunkSelection((current) =>
      current.includes(hunk)
        ? current.filter((value) => value !== hunk)
        : [...current, hunk],
    )
  }

  const isLineSelected = (row: Row): boolean => {
    if (row.kind !== 'line') {
      return false
    }
    const indices = rowLineIndices(row)
    if (indices.length === 0) {
      return false
    }
    const selected = lineSelection[row.hunk] ?? []
    return indices.every((index) => selected.includes(index))
  }

  const buildSelection = (): PathSelection[] | null => {
    if (!file) {
      return null
    }
    const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath
    const hunks: HunkSelection[] = []
    for (const [hunk, lines] of Object.entries(lineSelection)) {
      if (lines.length > 0) {
        hunks.push({ hunk: Number(hunk), lines })
      }
    }
    for (const hunk of hunkSelection) {
      if (!(hunk in lineSelection)) {
        hunks.push({ hunk })
      }
    }
    if (hunks.length === 0) {
      setActionError(t('diff.error.selectHunk'))
      return null
    }
    return [{ path, hunks }]
  }

  const applySelection = async (kind: 'stage' | 'unstage' | 'discard') => {
    if (!staging) {
      return
    }
    const selection = buildSelection()
    if (!selection) {
      return
    }
    if (kind === 'discard') {
      const path = file.newPath === '/dev/null' ? file.oldPath : file.newPath
      setPendingDiscard({
        selection: selection[0]!,
        path,
        sha256: file.fingerprint,
      })
      return
    }
    setBusy(true)
    setActionError(null)
    setActionNotice(null)
    try {
      if (kind === 'stage') {
        await indexStage(staging.repoId, selection)
      } else {
        await indexUnstage(staging.repoId, selection)
      }
      setLineSelection({})
      setHunkSelection([])
      setActionNotice(kind === 'stage' ? t('diff.notice.staged') : t('diff.notice.unstaged'))
      staging.onMutated()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const confirmDiscard = async () => {
    if (!staging || !pendingDiscard) {
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      await indexDiscard(
        staging.repoId,
        [pendingDiscard.selection],
        [{ path: pendingDiscard.path, sha256: pendingDiscard.sha256 }],
        { acknowledged: true },
      )
      setPendingDiscard(null)
      setLineSelection({})
      setHunkSelection([])
      setActionNotice(t('diff.notice.discarded'))
      staging.onMutated()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /**
   * One rendered diff row.
   *
   * `fixed` keeps the virtualised line height; the word-wrap path lets the row
   * grow and therefore renders without the absolute translate.
   */
  const renderRow = (row: Row, absolute: number, fixed: boolean) => {
    const rowStyle = fixed ? { height: LINE_HEIGHT } : undefined
    if (row.kind === 'hunk') {
      return (
        <div key={absolute} className={styles.hunk} style={rowStyle}>
          {staging ? (
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={hunkSelection.includes(row.hunk)}
                onChange={() => toggleHunk(row.hunk)}
                aria-label={t('diff.hunk.select', { number: row.hunk + 1 })}
              />
            </label>
          ) : null}
          {row.header}
        </div>
      )
    }
    const anchor = lineComment ? commentAnchor(row, file) : null
    return (
      <div
        key={absolute}
        className={styles.lineRow}
        data-split={mode === 'split' ? 'true' : undefined}
        data-comment={lineComment ? 'true' : undefined}
        style={rowStyle}
      >
        {lineComment ? (
          anchor ? (
            <button
              type="button"
              className={styles.commentGutter}
              title={t('diff.comment.gutterTitle')}
              aria-label={t('diff.comment.gutterAria', {
                path: anchor.side === 'new' ? anchor.newPath : anchor.oldPath,
                line: anchor.line,
                side: anchor.side,
              })}
              onClick={() => {
                setCommentTarget({
                  oldPath: anchor.oldPath,
                  newPath: anchor.newPath,
                  side: anchor.side,
                  line: anchor.line,
                })
                setCommentBody(
                  lineComment.suggestions && anchor.side === 'new'
                    ? ['```suggestion', anchor.content, '```'].join('\n')
                    : '',
                )
              }}
            >
              +
            </button>
          ) : (
            <span className={styles.commentGutter} aria-hidden="true" />
          )
        ) : null}
        {staging && row.tone !== 'context' ? (
          <label className={shared.checkbox}>
            <input
              type="checkbox"
              checked={isLineSelected(row)}
              onChange={() => toggleLine(row)}
              aria-label={t('diff.line.select')}
            />
          </label>
        ) : null}
        {mode === 'split' ? (() => {
          const words =
            row.tone === 'mixed' && row.left && row.right
              ? wordDiff(row.left.content, row.right.content)
              : null
          return (
            <>
              <span
                className={`${styles.line} ${styles.splitLine} ${row.left ? TONE_CLASS(row.tone) : styles.emptyLine}`}
              >
                <span className={styles.number}>{row.left?.oldLineno ?? ''}</span>
                <span className={styles.code} title={row.left?.content}>
                  {row.left
                    ? words
                      ? <>{highlight(words.prefix, file.oldPath)}<span className={styles.word} data-diff-emphasis="word">{highlight(words.left, file.oldPath)}</span>{highlight(words.suffix, file.oldPath)}</>
                      : highlight(row.left.content, file.oldPath)
                    : ''}
                </span>
              </span>
              <span
                className={`${styles.line} ${styles.splitLine} ${row.right ? TONE_CLASS(row.tone) : styles.emptyLine}`}
              >
                <span className={styles.number}>{row.right?.newLineno ?? ''}</span>
                <span className={styles.code} title={row.right?.content}>
                  {row.right
                    ? words
                      ? <>{highlight(words.prefix, file.newPath)}<span className={styles.word} data-diff-emphasis="word">{highlight(words.right, file.newPath)}</span>{highlight(words.suffix, file.newPath)}</>
                      : highlight(row.right.content, file.newPath)
                    : ''}
                </span>
              </span>
            </>
          )
        })() : (
          <span className={`${styles.line} ${styles.inlineLine} ${TONE_CLASS(row.tone)}`}>
            <span className={styles.numbers}>
              <span className={styles.number}>{row.left?.oldLineno ?? ''}</span>
              <span className={styles.number}>{row.right?.newLineno ?? ''}</span>
            </span>
            <span className={styles.sign}>
              {row.tone === 'added' ? '+' : row.tone === 'removed' ? '−' : ' '}
            </span>
            <span className={styles.code}>
              {(() => {
                const words = row.tone === 'removed' ? row.leftWords : row.rightWords
                const path = row.tone === 'removed' ? file.oldPath : file.newPath
                const content = (row.right ?? row.left)?.content ?? ''
                if (!words) {
                  return highlight(content, path)
                }
                const part = row.tone === 'removed' ? words.left : words.right
                return (
                  <>
                    {highlight(words.prefix, path)}
                    <span className={styles.word} data-diff-emphasis="word">
                      {highlight(part, path)}
                    </span>
                    {highlight(words.suffix, path)}
                  </>
                )
              })()}
            </span>
          </span>
        )}
      </div>
    )
  }

  return (
    <div className={`${styles.root} ${report.files.length === 1 ? styles.singleFile : ''}`}>
      {report.files.length > 1 ? <aside className={styles.files} aria-label={t('diff.files.aria')}>
        {report.files.map((entry, index) => (
          <button
            key={`${entry.oldPath}->${entry.newPath}`}
            type="button"
            className={index === active ? styles.fileActive : styles.file}
            aria-current={index === active ? 'true' : undefined}
            onClick={() => {
              selectFile(index)
              setLineSelection({})
              setHunkSelection([])
              setActionError(null)
              setActionNotice(null)
              setPendingDiscard(null)
              setScrollTop(0)
              scrollRef.current?.scrollTo({ top: 0 })
            }}
          >
            <span
              className={styles.fileStatus}
              data-kind={entry.kind}
              aria-hidden="true"
            >
              {STATUS_LETTERS[entry.kind]}
            </span>
            <span
              className={styles.filePath}
              title={`${t(STATUS_LABELS[entry.kind])} · ${entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath}`}
            >
              <PathParts path={entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath} />
            </span>
            <span className={styles.stats}>
              {entry.binary ? (
                t('diff.binary')
              ) : (
                <>
                  <span className={styles.added}>+{entry.additions}</span>
                  <span className={styles.removed}>−{entry.deletions}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </aside> : null}

      <section className={styles.panel}>
        <header className={styles.toolbar}>
          {!embedded ? (
          <div className={styles.headerText}>
            {commit ? (
              <span className={styles.source} title={`${commit.sha} · ${commit.subject}`}>
                {onAmend ? (
                  <button
                    type="button"
                    className={styles.commitLink}
                    onClick={onAmend}
                    title={t('diff.amend.title')}
                    aria-label={t('diff.amend.aria', { sha: commit.sha.slice(0, 8), subject: commit.subject })}
                  >
                    <code className={styles.commitSha}>{commit.sha.slice(0, 8)}</code>
                    <span className={styles.commitSubject}>{commit.subject}</span>
                  </button>
                ) : (
                  <>
                    <code className={styles.commitSha}>{commit.sha.slice(0, 8)}</code>
                    <span className={styles.commitSubject}>{commit.subject}</span>
                  </>
                )}
                <span className={styles.commitMeta}>
                  {commit.author} ·{' '}
                  {formatDate(dateFromSeconds(commit.timestamp))}
                </span>
              </span>
            ) : source ? (
              <span className={styles.source} title={source}>
                {source}
              </span>
            ) : null}
          </div>
          ) : null}
          <div className={styles.tools}>
            {onShowHistory && documentPath && documentPath !== '/dev/null' ? (
              <button
                type="button"
                className={styles.mode}
                title={t('diff.history.openTitle', { path: documentPath })}
                aria-label={t('diff.history.openAria', { path: documentPath })}
                onClick={() => onShowHistory(documentPath)}
              >
                {t('diff.history.open')}
              </button>
            ) : null}
            {staging && documentPath && documentPath !== '/dev/null' ? (
              <button
                type="button"
                className={styles.mode}
                title={t('editor.open')}
                onClick={() => setEditingPath(documentPath)}
              >
                {t('editor.open')}
              </button>
            ) : null}
            {markdown ? (
              <div className={styles.modes} role="group" aria-label={t('diff.view.aria')}>
                <button
                  type="button"
                  className={rendered ? styles.mode : styles.modeActive}
                  aria-pressed={!rendered}
                  title={t('diff.view.diffTitle')}
                  onClick={() => setRendered(false)}
                >
                  {t('diff.view.diff')}
                </button>
                <button
                  type="button"
                  className={rendered ? styles.modeActive : styles.mode}
                  aria-pressed={rendered}
                  title={t('diff.view.renderedTitle')}
                  onClick={() => setRendered(true)}
                >
                  {t('diff.view.rendered')}
                </button>
              </div>
            ) : null}
            {!rendered ? (
              <>
                <div className={styles.modes} role="group" aria-label={t('diff.mode.aria')}>
                  {(['hunk', 'inline', 'split'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={mode === value ? styles.modeActive : styles.mode}
                      aria-pressed={mode === value}
                      title={t(MODE_TITLES[value])}
                      onClick={() => {
                        setMode(value)
                        setScrollTop(0)
                        scrollRef.current?.scrollTo({ top: 0 })
                      }}
                    >
                      {t(MODE_LABELS[value])}
                    </button>
                  ))}
                </div>
                <button type="button" className={styles.mode} onClick={() => jump(-1)} aria-label={t('diff.hunk.previous')} title={t('diff.hunk.previous')}>
                  ↑
                </button>
                <button type="button" className={styles.mode} onClick={() => jump(1)} aria-label={t('diff.hunk.next')} title={t('diff.hunk.next')}>
                  ↓
                </button>
                <button
                  type="button"
                  className={styles.mode}
                  aria-pressed={wrap}
                  disabled={!wrapAvailable}
                  title={
                    wrapAvailable
                      ? t('diff.wrap.title')
                      : t('diff.wrap.unavailable', { limit: String(WRAP_ROW_LIMIT) })
                  }
                  onClick={() => {
                    const next = !wrap
                    setWrap(next)
                    try {
                      window.localStorage.setItem('ui.diffWrap', next ? 'true' : 'false')
                    } catch {
                      // Storage unavailable: the toggle stays session-only.
                    }
                    scrollRef.current?.scrollTo({ top: 0 })
                    setScrollTop(0)
                  }}
                >
                  {t('diff.wrap.label')}
                </button>
                {report.files.length > 1 ? (
                  <>
                    <button
                      type="button"
                      className={styles.mode}
                      disabled={active === 0}
                      title={t('diff.file.previous')}
                      aria-label={t('diff.file.previous')}
                      onClick={() => {
                        selectFile(Math.max(0, active - 1))
                        scrollRef.current?.scrollTo({ top: 0 })
                        setScrollTop(0)
                      }}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className={styles.mode}
                      disabled={active >= report.files.length - 1}
                      title={t('diff.file.next')}
                      aria-label={t('diff.file.next')}
                      onClick={() => {
                        selectFile(
                          Math.min(report.files.length - 1, active + 1),
                        )
                        scrollRef.current?.scrollTo({ top: 0 })
                        setScrollTop(0)
                      }}
                    >
                      ›
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </header>
        {commentTarget && lineComment ? (
          <div
            className={styles.commentBar}
            role="group"
            aria-label={t('diff.comment.aria')}
          >
            <div className={styles.commentHead}>
              <span className={styles.commentAnchor}>
                {t('diff.comment.anchor', {
                  path:
                    commentTarget.side === 'new'
                      ? commentTarget.newPath
                      : commentTarget.oldPath,
                  line: commentTarget.line,
                })}
              </span>
              {lineComment.suggestions && commentTarget.side === 'new' ? (
                <span className={styles.commentHint}>
                  {t('diff.comment.suggestion')}
                </span>
              ) : null}
            </div>
            <textarea
              className={styles.commentBody}
              value={commentBody}
              aria-label={t('diff.comment.aria')}
              onChange={(event) => setCommentBody(event.target.value)}
              autoFocus
            />
            <div className={styles.commentActions}>
              <button
                type="button"
                className={styles.mode}
                onClick={() => {
                  setCommentTarget(null)
                  setCommentBody('')
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={styles.commentSend}
                disabled={!commentBody.trim()}
                onClick={() => {
                  lineComment.onComment({
                    ...commentTarget,
                    content: commentBody.trim(),
                  })
                  setCommentTarget(null)
                  setCommentBody('')
                }}
              >
                {t('diff.comment.send')}
              </button>
            </div>
          </div>
        ) : null}
        {!embedded ? (
        <div className={styles.fileBar}>
          <span className={styles.fileStatus} data-kind={file.kind} aria-hidden="true">
            {STATUS_LETTERS[file.kind]}
          </span>
          <span
            className={styles.fileHeading}
            title={file.newPath === '/dev/null' ? file.oldPath : file.newPath}
          >
            <PathParts path={file.newPath === '/dev/null' ? file.oldPath : file.newPath} />
          </span>
          {file.binary ? (
            <span className={styles.fileStats}>{t('diff.binary')}</span>
          ) : (
            <span className={styles.fileStats}>
              <span className={styles.added}>+{file.additions}</span>
              <span className={styles.removed}>−{file.deletions}</span>
            </span>
          )}
          <span className={styles.hunkCount}>
            {plural('diff.hunk.count.one', 'diff.hunk.count.other', file.hunks.length)}
          </span>
        </div>
        ) : null}
        {rendered && markdown ? (
          <div className={styles.document} data-markdown-view={documentPath}>
            {documentState?.kind === 'loading' ? (
              <p className={styles.empty} role="status">{t('diff.document.loading')}</p>
            ) : null}
            {documentState?.kind === 'error' ? (
              <p className={shared.danger} role="alert">{documentState.message}</p>
            ) : null}
            {documentState?.kind === 'ready' && documentState.value.path === documentPath ? (
              documentState.value.content !== null ? (
                <>
                  {documentState.value.truncated ? (
                    <p className={styles.banner} role="status">
                      {t('diff.document.truncated')}
                    </p>
                  ) : null}
                  <Markdown source={documentState.value.content} />
                </>
              ) : (
                <p className={styles.empty}>
                  {documentState.value.binary
                    ? t('diff.document.binary')
                    : t('diff.document.missing')}
                </p>
              )
            ) : null}
          </div>
        ) : (
          <>
        {mode === 'split' ? (
          <div className={styles.splitHeader} aria-hidden="true">
            <span>{t('diff.split.old')}</span>
            <span>{t('diff.split.new')}</span>
          </div>
        ) : null}

        {capped ? (
          <p className={styles.banner} role="status">
            {t('diff.banner.truncated')}
          </p>
        ) : null}
        {file?.binary ? (
          <p className={styles.banner}>{t('diff.document.binary')}</p>
        ) : null}

        {staging && !file?.binary ? (
          <div className={shared.row}>
            <span className={shared.notice}>
              {staging.target === 'worktree' ? t('diff.stage.label') : t('diff.stage.stagedLabel')}
            </span>
            <button
              type="button"
              className={shared.primary}
              disabled={busy || (hunkSelection.length === 0 && Object.keys(lineSelection).length === 0)}
              onClick={() => void applySelection(staging.target === 'worktree' ? 'stage' : 'unstage')}
            >
              {staging.target === 'worktree' ? t('diff.stage.stage') : t('diff.stage.unstage')}
            </button>
            {staging.target === 'worktree' ? (
              <button
                type="button"
                className={shared.dangerButton}
                disabled={busy}
                onClick={() => void applySelection('discard')}
              >
                {t('diff.stage.discard')}
              </button>
            ) : null}
          </div>
        ) : null}
        {actionError ? (
          <p className={shared.danger} role="alert">
            {actionError}
          </p>
        ) : null}
        {actionNotice ? <p className={shared.notice}>{actionNotice}</p> : null}

        <div className={styles.diffPane}>
        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
            setContentHeight(event.currentTarget.scrollHeight)
          }}
        >
          {wrap && wrapAvailable ? (
            <div className={`${styles.rows} ${styles.wrapped}`}>
              {rows.map((row, index) => renderRow(row, index, false))}
            </div>
          ) : (
            <div style={{ height: rows.length * LINE_HEIGHT }} className={styles.rows}>
              <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
                {visible.map((row, index) => renderRow(row, first + index, true))}
              </div>
            </div>
          )}
        </div>
          {rows.length > 0 ? (
            <div
              className={styles.minimap}
              aria-hidden="true"
              title={t('diff.minimap.title')}
              onMouseDown={(event) => {
                const total = contentHeight || rows.length * LINE_HEIGHT
                const box = event.currentTarget.getBoundingClientRect()
                if (total <= 0 || box.height <= 0) {
                  return
                }
                const ratio = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
                scrollRef.current?.scrollTo({
                  top: Math.max(0, ratio * total - viewportHeight / 2),
                })
              }}
            >
              <span
                className={styles.minimapWindow}
                style={{
                  top: `${minimapTop}%`,
                  height: `${minimapHeight}%`,
                }}
              />
            </div>
          ) : null}
        </div>
          </>
        )}
        <footer className={styles.footer}>
          {rendered && markdown ? (
            <>
              {documentState?.kind === 'ready' && documentState.value.path === documentPath
                ? t('common.bytes', { count: formatNumber(documentState.value.bytes) })
                : t('diff.footer.rendered')}
              {report.files.length > 1 ? t('diff.footer.file', { current: active + 1, total: report.files.length }) : ''}
              {documentState?.kind === 'ready' && documentState.value.path === documentPath && documentState.value.truncated
                ? t('diff.footer.truncated')
                : ''}
            </>
          ) : (
            <>
              {t('common.lines', { count: formatNumber(rows.length) })}
              {report.files.length > 1 ? t('diff.footer.file', { current: active + 1, total: report.files.length }) : ''}
              {capped ? t('diff.footer.diffTruncated') : ''}
            </>
          )}
        </footer>
      </section>
      <ConfirmDialog
        open={pendingDiscard !== null}
        title={t('diff.discard.title')}
        consequence={t('diff.discard.consequence', {
          count: pendingDiscard?.selection.hunks.length ?? 0,
          path: pendingDiscard?.path ?? '',
        })}
        irreversible
        confirmLabel={t('diff.discard.confirm')}
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
      />
    </div>
  )
}
