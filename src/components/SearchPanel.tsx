import { useRef, useState } from 'react'
import {
  operationCancel,
  searchCommits,
  searchContent,
  searchPaths,
  type DiffRequest,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
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

const MODES: { value: Mode; label: string }[] = [
  { value: 'message', label: 'Message' },
  { value: 'author', label: 'Auteur' },
  { value: 'sha', label: 'SHA' },
  { value: 'path', label: 'Chemin' },
  { value: 'content', label: 'Contenu' },
]

export function SearchPanel({
  repoId,
  onShowInGraph,
  onOpenFile,
}: Props) {
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

  const run = async (after?: string, offset = 0) => {
    if (!text.trim() || running.current) {
      return
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

  const scope = [
    allRefs ? 'toutes les refs' : revision.trim() || 'HEAD',
    `profondeur ${depth}`,
    pathScope.trim() ? `chemin ${pathScope.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={p2.pageColumn}>
      <div className={p2.stack} style={{ flex: 1, minHeight: 0 }}>
        <div className={p2.tabs} style={{ padding: '0 0 8px', borderBottom: 0 }}>
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={mode === item.value ? p2.tabOn : p2.tab}
              onClick={() => setMode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className={p2.row} style={{ alignItems: 'flex-end' }}>
          <label className={p2.field} style={{ flex: 2 }}>
            Recherche
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void run()
                }
              }}
              placeholder={
                mode === 'sha'
                  ? 'sha ou préfixe'
                  : mode === 'path'
                    ? 'src/payment'
                    : mode === 'content'
                      ? 'texte dans le contenu des fichiers'
                      : 'texte à chercher'
              }
              spellCheck={false}
            />
          </label>
          {mode === 'message' || mode === 'author' ? (
            <label className={p2.field}>
              Profondeur
              <input
                value={depth}
                onChange={(event) => setDepth(Number(event.target.value) || 0)}
                inputMode="numeric"
              />
            </label>
          ) : null}
          <button type="button" className={p2.primary} disabled={busy || !text.trim()} onClick={() => void run()}>
            Rechercher
          </button>
          {busy ? (
            <button type="button" className={p2.danger} onClick={() => void cancel()}>
              Annuler
            </button>
          ) : null}
        </div>

        {mode === 'message' || mode === 'author' || mode === 'sha' ? (
          <div className={p2.row}>
            <label className={p2.field}>
              Révision
              <input
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                placeholder="HEAD ou branche"
                spellCheck={false}
              />
            </label>
            <label className={p2.checkbox}>
              <input type="checkbox" checked={allRefs} onChange={(event) => setAllRefs(event.target.checked)} />
              toutes les refs
            </label>
            <label className={p2.field}>
              Chemin
              <input
                value={pathScope}
                onChange={(event) => setPathScope(event.target.value)}
                placeholder="src/"
                spellCheck={false}
              />
            </label>
            <label className={p2.field}>
              Auteur (filtre)
              <input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label className={p2.field}>
              Depuis
              <input value={since} onChange={(event) => setSince(event.target.value)} placeholder="2026-01-01" />
            </label>
            <label className={p2.field}>
              Jusqu’à
              <input value={until} onChange={(event) => setUntil(event.target.value)} placeholder="2026-12-31" />
            </label>
          </div>
        ) : null}

        <span className={p2.pill}>Périmètre : {scope}</span>
        {error ? <p className={p2.errorText} role="alert">{error}</p> : null}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {mode === 'path' && paths ? (
            <>
              <div className={p2.between}>
                <span className={p2.small}>{paths.items.length} chemin(s)</span>
                {paths.truncated ? <span className={p2.warn}>résultats plafonnés</span> : null}
              </div>
              <div className={p2.list}>
                {paths.items.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className={p2.listItem}
                    onClick={() => onOpenFile(item.path)}
                  >
                    <span className={p2.mono}>{item.path}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {mode === 'content' && content ? (
            <>
              <div className={p2.between}>
                <span className={p2.small}>
                  {content.items.length} correspondance(s)
                  {content.path ? ` dans ${content.path}` : ''}
                </span>
                {content.truncated ? <span className={p2.warn}>résultats plafonnés</span> : null}
              </div>
              <div className={p2.list}>
                {content.items.map((item) => (
                  <button
                    key={`${item.path}:${item.line}:${item.text}`}
                    type="button"
                    className={p2.listItem}
                    onClick={() => onOpenFile(item.path)}
                  >
                    <span className={p2.mono}>
                      {item.path}:{item.line}
                    </span>
                    <span className={p2.listSub} style={{ color: 'var(--text)' }}>
                      {item.text}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {mode !== 'path' && mode !== 'content' && result ? (
            <>
              <div className={p2.between}>
                <span className={p2.small}>
                  {result.commits.length} commit(s) · profondeur {result.depth}
                </span>
                {result.truncated ? <span className={p2.warn}>plafond atteint</span> : null}
              </div>
              <div className={p2.list}>
                {result.commits.map((commit) => (
                  <button
                    key={commit.sha}
                    type="button"
                    className={p2.listItem}
                    onClick={() => onShowInGraph(commit.sha)}
                  >
                    <span>
                      <span className={p2.mono}>{commit.sha.slice(0, 10)}</span>{' '}
                      {commit.subject}
                    </span>
                    <span className={p2.listSub}>
                      {commit.author.name} ·{' '}
                      {new Date(commit.author.timestamp * 1000).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
              {result.next ? (
                <button type="button" className={p2.secondary} onClick={() => void run(result.next)}>
                  Page suivante
                </button>
              ) : null}
            </>
          ) : null}

          {!busy && !error && (
            (mode === 'path' && paths?.items.length === 0) ||
            (mode === 'content' && content?.items.length === 0) ||
            (mode !== 'path' && mode !== 'content' && result?.commits.length === 0)
          ) ? (
            <div className={p2.empty} role="status">
              <h2>Aucun résultat</h2>
              <p>Essayez un autre terme ou élargissez les filtres de recherche.</p>
            </div>
          ) : null}

          {!paths && !content && !result && !busy ? (
            <div className={p2.empty}>
              <h2>Recherche approfondie</h2>
              <p>
                Choisissez le type de recherche, saisissez un terme puis lancez
                la recherche. Vous pouvez annuler une recherche en cours.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
