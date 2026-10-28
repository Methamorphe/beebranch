import {
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
import { ConfirmDialog } from './ConfirmDialog'
import { Markdown } from './Markdown'
import shared from './p1.module.css'
import styles from './DiffViewer.module.css'

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
}

const MARKDOWN_PATH = /\.(md|markdown|mdown|mkd|mdx)$/i

const MODE_LABELS: Record<Mode, string> = {
  hunk: 'Changements',
  inline: 'Unifié',
  split: 'Côte à côte',
}

const MODE_TITLES: Record<Mode, string> = {
  hunk: 'Uniquement les lignes modifiées',
  inline: 'Diff unifié avec contexte',
  split: 'Ancien et nouveau côte à côte',
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

export function DiffViewer({ report, source, commit, staging, embedded = false, onAmend, readDocument }: Props) {
  const [mode, setMode] = useState<Mode>('inline')
  const [active, setActive] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [lineSelection, setLineSelection] = useState<Record<number, number[]>>({})
  const [hunkSelection, setHunkSelection] = useState<number[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rendered, setRendered] = useState(false)
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

  if (report.files.length === 0) {
    return <p className={styles.empty}>Aucun changement pour cette sélection.</p>
  }
  if (!file) {
    return <p className={styles.empty}>Sélectionnez un fichier.</p>
  }

  const hunkRows = rows
    .map((row, index) => (row.kind === 'hunk' ? index : -1))
    .filter((index) => index >= 0)

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
      setActionError('Sélectionnez un hunk ou des lignes.')
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
      setActionNotice(kind === 'stage' ? 'Sélection indexée.' : 'Sélection retirée de l’index.')
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
      setActionNotice('Discard appliqué.')
      staging.onMutated()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${styles.root} ${embedded && report.files.length === 1 ? styles.singleFile : ''}`}>
      {(!embedded || report.files.length > 1) ? <aside className={styles.files} aria-label="Fichiers modifiés">
        {report.files.map((entry, index) => (
          <button
            key={`${entry.oldPath}->${entry.newPath}`}
            type="button"
            className={index === active ? styles.fileActive : styles.file}
            aria-current={index === active ? 'true' : undefined}
            onClick={() => {
              setActive(index)
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
              title={`${STATUS_LABELS[entry.kind]} · ${entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath}`}
            >
              <PathParts path={entry.newPath === '/dev/null' ? entry.oldPath : entry.newPath} />
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
                    title="Amender ce commit — réécrit l’historique"
                    aria-label={`Amender le commit ${commit.sha.slice(0, 8)} : ${commit.subject}`}
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
                  {new Date(commit.timestamp * 1000).toLocaleDateString('fr-FR')}
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
            {markdown ? (
              <div className={styles.modes} role="group" aria-label="Affichage du fichier">
                <button
                  type="button"
                  className={rendered ? styles.mode : styles.modeActive}
                  aria-pressed={!rendered}
                  title="Afficher les changements"
                  onClick={() => setRendered(false)}
                >
                  Diff
                </button>
                <button
                  type="button"
                  className={rendered ? styles.modeActive : styles.mode}
                  aria-pressed={rendered}
                  title="Afficher le Markdown rendu"
                  onClick={() => setRendered(true)}
                >
                  Rendu
                </button>
              </div>
            ) : null}
            {!rendered ? (
              <>
                <div className={styles.modes} role="group" aria-label="Mode de diff">
                  {(['hunk', 'inline', 'split'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={mode === value ? styles.modeActive : styles.mode}
                      aria-pressed={mode === value}
                      title={MODE_TITLES[value]}
                      onClick={() => {
                        setMode(value)
                        setScrollTop(0)
                        scrollRef.current?.scrollTo({ top: 0 })
                      }}
                    >
                      {MODE_LABELS[value]}
                    </button>
                  ))}
                </div>
                <button type="button" className={styles.mode} onClick={() => jump(-1)} aria-label="Hunk précédent" title="Hunk précédent">
                  ↑
                </button>
                <button type="button" className={styles.mode} onClick={() => jump(1)} aria-label="Hunk suivant" title="Hunk suivant">
                  ↓
                </button>
              </>
            ) : null}
          </div>
        </header>
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
            <span className={styles.fileStats}>binaire</span>
          ) : (
            <span className={styles.fileStats}>
              <span className={styles.added}>+{file.additions}</span>
              <span className={styles.removed}>−{file.deletions}</span>
            </span>
          )}
          <span className={styles.hunkCount}>
            {file.hunks.length} hunk{file.hunks.length > 1 ? 's' : ''}
          </span>
        </div>
        ) : null}
        {rendered && markdown ? (
          <div className={styles.document} data-markdown-view={documentPath}>
            {documentState?.kind === 'loading' ? (
              <p className={styles.empty} role="status">Chargement du fichier…</p>
            ) : null}
            {documentState?.kind === 'error' ? (
              <p className={shared.danger} role="alert">{documentState.message}</p>
            ) : null}
            {documentState?.kind === 'ready' && documentState.value.path === documentPath ? (
              documentState.value.content !== null ? (
                <>
                  {documentState.value.truncated ? (
                    <p className={styles.banner} role="status">
                      Fichier tronqué au plafond de lecture ; le rendu est partiel.
                    </p>
                  ) : null}
                  <Markdown source={documentState.value.content} />
                </>
              ) : (
                <p className={styles.empty}>
                  {documentState.value.binary
                    ? 'Fichier binaire — aucun rendu textuel.'
                    : 'Fichier absent à cette révision.'}
                </p>
              )
            ) : null}
          </div>
        ) : (
          <>
        {mode === 'split' ? (
          <div className={styles.splitHeader} aria-hidden="true">
            <span>Ancien</span>
            <span>Nouveau</span>
          </div>
        ) : null}

        {capped ? (
          <p className={styles.banner} role="status">
            Diff tronqué par le plafond de sécurité (fichiers, lignes ou octets).
          </p>
        ) : null}
        {file?.binary ? (
          <p className={styles.banner}>Fichier binaire — aucun rendu textuel.</p>
        ) : null}

        {staging && !file?.binary ? (
          <div className={shared.row}>
            <span className={shared.notice}>
              {staging.target === 'worktree' ? 'Préparer les changements' : 'Fichier préparé'}
            </span>
            <button
              type="button"
              className={shared.primary}
              disabled={busy || (hunkSelection.length === 0 && Object.keys(lineSelection).length === 0)}
              onClick={() => void applySelection(staging.target === 'worktree' ? 'stage' : 'unstage')}
            >
              {staging.target === 'worktree' ? 'Préparer la sélection' : 'Retirer la sélection'}
            </button>
            {staging.target === 'worktree' ? (
              <button
                type="button"
                className={shared.dangerButton}
                disabled={busy}
                onClick={() => void applySelection('discard')}
              >
                Abandonner la sélection…
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

        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: rows.length * LINE_HEIGHT }} className={styles.rows}>
            <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
              {visible.map((row, index) => {
                const absolute = first + index
                if (row.kind === 'hunk') {
                  return (
                    <div
                      key={absolute}
                      className={styles.hunk}
                      style={{ height: LINE_HEIGHT }}
                    >
                      {staging ? (
                        <label className={shared.checkbox}>
                          <input
                            type="checkbox"
                            checked={hunkSelection.includes(row.hunk)}
                            onChange={() => toggleHunk(row.hunk)}
                            aria-label={`Sélectionner le hunk ${row.hunk + 1}`}
                          />
                        </label>
                      ) : null}
                      {row.header}
                    </div>
                  )
                }
                return (
                  <div
                    key={absolute}
                    className={styles.lineRow}
                    data-split={mode === 'split' ? 'true' : undefined}
                    style={{ height: LINE_HEIGHT }}
                  >
                    {staging && row.tone !== 'context' ? (
                      <label className={shared.checkbox}>
                        <input
                          type="checkbox"
                          checked={isLineSelected(row)}
                          onChange={() => toggleLine(row)}
                          aria-label="Sélectionner cette ligne"
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
                            const words =
                              row.tone === 'removed' ? row.leftWords : row.rightWords
                            const path =
                              row.tone === 'removed' ? file.oldPath : file.newPath
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
              })}
            </div>
          </div>
        </div>
          </>
        )}
        <footer className={styles.footer}>
          {rendered && markdown ? (
            <>
              {documentState?.kind === 'ready' && documentState.value.path === documentPath
                ? `${documentState.value.bytes.toLocaleString('fr-FR')} octets`
                : 'Rendu Markdown'}
              {report.files.length > 1 ? ` · fichier ${active + 1}/${report.files.length}` : ''}
              {documentState?.kind === 'ready' && documentState.value.path === documentPath && documentState.value.truncated
                ? ' · tronqué'
                : ''}
            </>
          ) : (
            <>
              {rows.length.toLocaleString('fr-FR')} lignes
              {report.files.length > 1 ? ` · fichier ${active + 1}/${report.files.length}` : ''}
              {capped ? ' · diff tronqué' : ''}
            </>
          )}
        </footer>
      </section>
      <ConfirmDialog
        open={pendingDiscard !== null}
        title="Discard irréversible"
        consequence={`${pendingDiscard?.selection.hunks.length ?? 0} hunk(s) de ${pendingDiscard?.path ?? ''} seront remplacés par la version de l'index.`}
        irreversible
        confirmLabel="Discard"
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
      />
    </div>
  )
}
