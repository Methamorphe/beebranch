import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  blameGet,
  fileHistoryGet,
  statusGet,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { BlameReport, FileHistory } from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  initialPath?: string
  onShowCommit: (sha: string) => void
}

export function FileHistoryPanel({
  repoId,
  generation,
  initialPath,
  onShowCommit,
}: Props) {
  const [paths, setPaths] = useState<string[]>([])
  const [path, setPath] = useState(initialPath ?? '')
  const [tab, setTab] = useState<'history' | 'blame'>('history')
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
  }, [repoId, tab, follow, start, end, path])

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
    <div className={p2.pageColumn}>
      <div className={p2.between}>
        <h2 className={p2.cardTitle}>Historique de fichier & blame</h2>
        <span className={p2.pill}>Historique et attribution des lignes</span>
      </div>
      <div className={p2.row} style={{ alignItems: 'flex-end' }}>
        <label className={p2.field} style={{ flex: 1 }}>
          Fichier
          <span className={p2.inlineField}>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="src/App.tsx"
              spellCheck={false}
            />
            <select value="" onChange={(event) => setPath(event.target.value)} aria-label="Choisir un fichier modifié">
              <option value="">fichiers du status…</option>
              {paths.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </span>
        </label>
        <button type="button" className={p2.secondary} disabled={busy || !path.trim()} onClick={() => void load()}>
          Charger
        </button>
      </div>

      <div className={p2.tabs} style={{ padding: '8px 0', borderBottom: 0 }}>
        <button type="button" className={tab === 'history' ? p2.tabOn : p2.tab} onClick={() => setTab('history')}>
          Historique
        </button>
        <button type="button" className={tab === 'blame' ? p2.tabOn : p2.tab} onClick={() => setTab('blame')}>
          Blame
        </button>
      </div>

      {error ? <p className={p2.errorText} role="alert">{error}</p> : null}

      {tab === 'history' ? (
        <div className={p2.stack}>
          <label className={p2.checkbox}>
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
            Suivre les renommages
          </label>
          {!history && !busy && !error ? (
            <div className={p2.empty}>
              <h2>Choisissez un fichier</h2>
              <p>Saisissez son chemin dans le dépôt puis chargez son historique.</p>
            </div>
          ) : null}
          {history?.truncated ? <p className={p2.warn}>Historique plafonné à 300 entrées.</p> : null}
          <div className={p2.table}>
            <div className={p2.tableHead}>
              <span>Commit</span>
              <span>Auteur</span>
              <span>Date</span>
              <span />
            </div>
            {history?.entries.map((entry) => (
              <div key={`${entry.sha}-${entry.status}`} className={p2.tableRow}>
                <div style={{ minWidth: 0 }}>
                  <div className={p2.mono}>{entry.sha.slice(0, 10)} · {entry.status}</div>
                  <div className={p2.listSub} style={{ color: 'var(--text)' }}>{entry.subject}</div>
                  {entry.previousPath ? (
                    <div className={p2.listSub}>depuis {entry.previousPath}</div>
                  ) : null}
                </div>
                <span className={p2.listSub}>{entry.author}</span>
                <span className={p2.listSub}>
                  {new Date(entry.authorTime * 1000).toLocaleString()}
                </span>
                <button type="button" className={p2.ghost} onClick={() => onShowCommit(entry.sha)}>
                  Voir
                </button>
              </div>
            ))}
            {history && history.entries.length === 0 ? (
              <p className={p2.notice} style={{ padding: 12 }}>Aucun commit pour ce fichier.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={p2.stack}>
          <div className={p2.row}>
            <label className={p2.field}>
              Ligne de début
              <input value={start} onChange={(event) => setStart(event.target.value)} inputMode="numeric" />
            </label>
            <label className={p2.field}>
              Ligne de fin
              <input value={end} onChange={(event) => setEnd(event.target.value)} inputMode="numeric" />
            </label>
            <button type="button" className={p2.secondary} disabled={busy} onClick={() => void load()}>
              Charger la plage
            </button>
            {blame?.truncated ? <span className={p2.warn}>plafonné à 2 000 lignes</span> : null}
          </div>
          <div className={p2.code} style={{ padding: 0 }}>
            {groups.map((group) => (
              <div key={`${group.sha}-${group.start}`} style={{ borderBottom: '1px solid var(--border)' }}>
                <button
                  type="button"
                  className={p2.ghost}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px' }}
                  onClick={() => onShowCommit(group.sha)}
                  title={group.summary}
                >
                  <span className={p2.mono}>{group.sha.slice(0, 8)}</span>{' '}
                  <span className={p2.muted}>
                    {group.author} · {new Date(group.time * 1000).toLocaleDateString()} · {group.summary}
                  </span>
                </button>
                <pre className={p2.sideCode} style={{ padding: '0 10px 8px' }}>
                  {group.lines.map((line, index) => `${String(group.start + index).padStart(5)}  ${line}`).join('\n')}
                </pre>
              </div>
            ))}
            {blame && blame.lines.length === 0 ? (
              <p className={p2.notice} style={{ padding: 12 }}>Aucune ligne dans cette plage.</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
