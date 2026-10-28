import { useEffect, useMemo, useState } from 'react'
import {
  conflictMarkResolved,
  diffGet,
  indexDiscard,
  indexIgnore,
  indexStage,
  indexUnstage,
  statusGet,
  toolOpen,
  type DiffRequest,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { StatusEntry, StatusReport } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { ConfirmDialog } from './ConfirmDialog'
import styles from './RepoStatus.module.css'

type Props = {
  repoId: string
  generation: number
  locks: string[]
  onSelectDiff: (request: DiffRequest) => void
  onMutated: () => void
  onNavigate: (view: 'commit' | 'sync' | 'stash' | 'conflicts') => void
  selectedPath?: string
}

const MAX_ROWS = 500

function entryLabel(entry: StatusEntry): string {
  switch (entry.kind) {
    case 'untracked':
      return 'non suivi'
    case 'unmerged':
      return 'conflit'
    case 'renamed':
      return 'renommé'
    case 'copied':
      return 'copié'
    case 'ignored':
      return 'ignoré'
    default:
      return `${entry.index}${entry.worktree}`
  }
}

function extPattern(path: string): string | null {
  const name = path.split('/').pop() ?? ''
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) {
    return null
  }
  return `*${name.slice(index)}`
}

function dirPattern(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? `${path.slice(0, index + 1)}` : `${path}/`
}

type PendingDiscard = {
  entry: StatusEntry
  sha256?: string
}

export function RepoStatus({
  repoId,
  generation,
  locks,
  onSelectDiff,
  onMutated,
  onNavigate,
  selectedPath,
}: Props) {
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void statusGet(repoId, undefined, includeIgnored)
      .then((statusResult) => {
        if (cancelled) {
          return
        }
        setStatus(statusResult.data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation, refresh, includeIgnored])

  const entries = useMemo(() => {
    if (!status) {
      return []
    }
    const needle = filter.trim().toLowerCase()
    return status.entries.filter((entry) =>
      needle.length === 0 ? true : entry.path.toLowerCase().includes(needle),
    )
  }, [status, filter])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(label)
      setRefresh((value) => value + 1)
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const entryPaths = (entry: StatusEntry): string[] =>
    entry.origPath ? [entry.origPath, entry.path] : [entry.path]

  const stage = (entry: StatusEntry) =>
    run(`Indexé : ${entry.path}`, () =>
      indexStage(
        repoId,
        entryPaths(entry).map((path) => ({ path, hunks: [] })),
      ),
    )

  const unstage = (entry: StatusEntry) =>
    run(`Retiré de l'index : ${entry.path}`, () =>
      indexUnstage(
        repoId,
        entryPaths(entry).map((path) => ({ path, hunks: [] })),
      ),
    )

  const requestDiscard = async (entry: StatusEntry) => {
    setError(null)
    try {
      if (entry.kind === 'untracked' || entry.kind === 'unmerged') {
        setError('Un fichier non suivi ou en conflit ne peut pas être discardé ici.')
        return
      }
      const report = await diffGet(repoId, {
        target: 'worktree',
        path: entry.path,
      })
      const file = report.data.files[0]
      setPendingDiscard({ entry, sha256: file?.fingerprint })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const confirmDiscard = async () => {
    if (!pendingDiscard) {
      return
    }
    const target = pendingDiscard
    await run(`Discard irréversible : ${target.entry.path}`, () =>
      indexDiscard(
        repoId,
        [{ path: target.entry.path, hunks: [] }],
        [{ path: target.entry.path, sha256: target.sha256 }],
        { acknowledged: true },
      ),
    )
    setPendingDiscard(null)
  }

  const ignore = (pattern: string) =>
    run(`Ajouté au .gitignore : ${pattern}`, () => indexIgnore(repoId, pattern))

  const openTool = (entry: StatusEntry, kind: 'editor' | 'merge') =>
    run(
      kind === 'merge'
        ? `Merge tool ouvert : ${entry.path}`
        : `Éditeur ouvert : ${entry.path}`,
      () => toolOpen({ repoId, kind, path: entry.path }),
    )

  const resolve = (entry: StatusEntry) =>
    run(`Conflit marqué résolu : ${entry.path}`, () =>
      conflictMarkResolved(repoId, entry.path),
    )

  if (error && !status) {
    return (
      <div className={styles.error} role="alert">
        {error}
      </div>
    )
  }
  if (!status) {
    return <div className={styles.loading}>{loading ? 'Lecture du status…' : 'Aucun status.'}</div>
  }

  const groups = [
    { id: 'conflicts', label: 'Conflits à résoudre', entries: entries.filter((e) => e.kind === 'unmerged'), staged: false },
    { id: 'worktree', label: 'À préparer', entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'ignored' && (e.kind === 'untracked' || e.worktree !== '.')), staged: false },
    { id: 'index', label: 'Prêts à committer', entries: entries.filter((e) => e.kind !== 'unmerged' && e.kind !== 'untracked' && e.kind !== 'ignored' && e.index !== '.'), staged: true },
    { id: 'ignored', label: 'Ignorés', entries: entries.filter((e) => e.kind === 'ignored'), staged: false },
  ]
  const select = (entry: StatusEntry, staged: boolean) => onSelectDiff({
    target: staged ? 'index' : 'worktree', path: entry.path,
    untracked: entry.kind === 'untracked', allowActions: entry.kind !== 'unmerged',
  })
  const stageGroup = (list: StatusEntry[], staged: boolean) => {
    const paths = [...new Set(list.flatMap(entryPaths))]
    void run(staged ? 'Fichiers retirés de l’index.' : 'Fichiers ajoutés à l’index.', () =>
      (staged ? indexUnstage : indexStage)(repoId, paths.map((path) => ({ path, hunks: [] }))))
  }
  return (
    <div className={styles.root} aria-busy={busy || loading}>
      <div className={styles.meta}>
        <input className={styles.filter} value={filter} onChange={(event) => setFilter(event.target.value)}
          placeholder="Filtrer les fichiers…" aria-label="Filtrer les chemins" />
        <ActionMenu label="Options d’affichage des fichiers"><label className={styles.ignoredToggle} title="Afficher les fichiers ignorés">
          <input type="checkbox" checked={includeIgnored} onChange={(event) => setIncludeIgnored(event.target.checked)} /> Afficher les fichiers ignorés
        </label></ActionMenu>
      </div>
      {locks.length > 0 ? <p className={styles.banner} role="alert">Verrous Git : {locks.join(', ')}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {status.truncated ? <p className={styles.banner}>Liste partielle. Filtrez pour affiner les résultats.</p> : null}
      <div className={styles.fileList}>
        {status.entries.length === 0 ? <div className={styles.clean}><span aria-hidden="true">✓</span><strong>Tout est à jour</strong><p>Aucune modification locale. Votre prochain commit commence ici.</p></div> : null}
        {filter && entries.length === 0 ? <p className={styles.notice}>Aucun fichier ne correspond à « {filter} ».</p> : null}
        {groups.map((group) => group.entries.length === 0 && (group.id === 'conflicts' || group.id === 'ignored' || status.entries.length === 0) ? null :
          <section key={group.id} className={styles.fileGroup} aria-label={group.label}>
            <header className={styles.groupHeading}><h2>{group.label} <span>{group.entries.length}</span></h2>
              {group.entries.length > 0 && (group.id === 'worktree' || group.id === 'index') ? <button type="button" disabled={busy} onClick={() => stageGroup(group.entries, group.staged)}>{group.staged ? 'Tout retirer' : 'Tout préparer'}</button> : null}
            </header>
            {group.entries.length === 0 ? <p className={styles.empty}>{group.staged ? 'Préparez les fichiers à inclure dans le commit.' : 'Aucun fichier à préparer.'}</p> : null}
            {group.entries.slice(0, MAX_ROWS).map((entry) => <div key={entry.path} className={styles.fileRow} data-selected={entry.path === selectedPath}>
              <span className={styles.state} title={entryLabel(entry)} data-kind={entry.kind}>{entry.kind === 'untracked' ? 'N' : entry.kind === 'unmerged' ? '!' : group.staged ? entry.index : entry.worktree}</span>
              <button type="button" className={styles.filePath} title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
                disabled={entry.kind === 'ignored'} onClick={() => entry.kind === 'unmerged' ? onNavigate('conflicts') : select(entry, group.staged)}><span className={styles.folder}>{entry.path.slice(0, entry.path.lastIndexOf('/') + 1)}</span><span className={styles.filename}>{entry.path.slice(entry.path.lastIndexOf('/') + 1)}</span></button>
              {entry.kind === 'unmerged' ? <button type="button" className={styles.stage} onClick={() => onNavigate('conflicts')}>Résoudre</button> : entry.kind !== 'ignored' ? <button type="button" className={styles.stage} disabled={busy} title={group.staged ? 'Retirer de l’index' : 'Préparer ce fichier'} aria-label={`${group.staged ? 'Retirer' : 'Préparer'} ${entry.path}`} onClick={() => void (group.staged ? unstage(entry) : stage(entry))}>{group.staged ? '−' : '+'}</button> : null}
              <ActionMenu label={`Actions pour ${entry.path}`}>
                  <button type="button" disabled={busy} onClick={() => void openTool(entry, 'editor')}>Ouvrir dans l’éditeur</button>
                  {entry.kind === 'unmerged' ? <><button type="button" disabled={busy} onClick={() => void openTool(entry, 'merge')}>Outil de fusion</button><button type="button" disabled={busy} onClick={() => void resolve(entry)}>Marquer résolu</button></> : null}
                  {entry.kind === 'untracked' ? <><button type="button" disabled={busy} onClick={() => void ignore(entry.path)}>Ignorer le fichier</button>{extPattern(entry.path) ? <button type="button" disabled={busy} onClick={() => void ignore(extPattern(entry.path)!)}>Ignorer {extPattern(entry.path)}</button> : null}{entry.path.includes('/') ? <button type="button" disabled={busy} onClick={() => void ignore(dirPattern(entry.path))}>Ignorer le dossier</button> : null}</> : null}
                  {!group.staged && entry.kind === 'ordinary' ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void requestDiscard(entry)}>Abandonner les modifications…</button> : null}
              </ActionMenu>
            </div>)}
            {group.entries.length > MAX_ROWS ? <p className={styles.banner}>{group.entries.length - MAX_ROWS} autres fichiers. Affinez le filtre.</p> : null}
          </section>)}
      </div>
      <ConfirmDialog
        open={pendingDiscard !== null}
        title="Discard irréversible"
        consequence={`1 fichier (${pendingDiscard?.entry.path ?? ''}) : le contenu non indexé sera remplacé par la version de l'index.`}
        irreversible
        confirmLabel="Discard"
        busy={busy}
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => void confirmDiscard()}
      />
    </div>
  )
}
