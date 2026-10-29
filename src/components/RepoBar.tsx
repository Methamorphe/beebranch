import { useEffect, useState } from 'react'
import type { RepoView, StashEntry, UndoEntry } from '../types/git'
import { errorMessage } from '../ipc/client'
import { branchCheckout, refsGet, stashList, stashPop, syncFetch, syncPull, syncPush, toolOpen } from '../ipc/commands'
import type { ViewId } from '../data/navigation'
import { ActionMenu } from './ActionMenu'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './RepoBar.module.css'

type Props = {
  repo: RepoView | null
  repos: RepoView[]
  busy: boolean
  onActivate: (repoId: string) => void
  onOpenDialog: () => void
  onOpenPalette: () => void
  onRefresh: () => void
  onNavigate: (view: ViewId) => void
  onNewBranch: () => void
  onError: (message: string) => void
  undo: UndoEntry | null
  redo: UndoEntry | null
  onUndo: () => Promise<unknown>
  onRedo: () => Promise<unknown>
}

function branchLabel(repo: RepoView | null) {
  const head = repo?.state.head
  if (head?.kind === 'branch') return head.name
  if (head?.kind === 'detached') return `HEAD · ${head.sha.slice(0, 8)}`
  return head?.kind === 'unborn' ? head.branch ?? 'Nouvelle branche' : 'Aucune branche'
}

export function RepoBar({ repo, repos, busy, onActivate, onOpenDialog, onOpenPalette, onRefresh, onNavigate, onNewBranch, onError, undo, redo, onUndo, onRedo }: Props) {
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [latestStash, setLatestStash] = useState<StashEntry | null>(null)
  const repoId = repo?.repo.repoId ?? null
  useEffect(() => {
    let cancelled = false
    setLatestStash(null)
    setBranches([])
    if (repoId) void Promise.allSettled([stashList(repoId), refsGet(repoId)]).then(([stashes, refs]) => {
      if (cancelled) return
      if (stashes.status === 'fulfilled') setLatestStash(stashes.value[0] ?? null)
      if (refs.status === 'fulfilled') setBranches(refs.value.data.entries.filter((entry) => entry.kind === 'branch').map((entry) => entry.name))
    })
    return () => { cancelled = true }
  }, [repoId, repo?.generation])
  const head = repo?.state.head
  const upstream = head?.kind === 'branch' ? head.upstream : undefined
  const [remote, ...parts] = upstream?.split('/') ?? ['origin']
  const remoteBranch = parts.join('/')
  const disabled = !repoId || busy || pending !== null
  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label); setNotice(null)
    try { await action(); setNotice(`${label} terminé.`); onRefresh() }
    catch (cause) { onError(errorMessage(cause)) }
    finally { setPending(null) }
  }
  const sync = (kind: 'pull' | 'push') => {
    if (!repoId) return
    if (!upstream || !remoteBranch) { onNavigate('sync'); return }
    void run(kind === 'pull' ? 'Pull' : 'Push', () => kind === 'pull' ? syncPull({ repoId, remote, branch:remoteBranch }) : syncPush({ repoId, remote, branch:remoteBranch }))
  }
  return <div className={styles.root} role="region" aria-label="Actions du dépôt" onFocusCapture={(event) => { if (event.target instanceof HTMLElement && !event.target.closest('[popover]')) event.target.scrollIntoView({ block:'nearest', inline:'nearest' }) }}>
    <div className={styles.identity}>
      <ActionMenu label="Choisir un dépôt" triggerClassName={styles.selector} triggerContent={<><span className={styles.caption}>dépôt</span><span className={styles.value}><span className={styles.contextName}>{repo?.repo.name ?? 'Ouvrir un dépôt'}</span><ToolbarIcon name="chevron" /></span></>}>
        {repos.map((entry) => <button key={entry.repo.repoId} type="button" onClick={() => onActivate(entry.repo.repoId)} aria-current={entry.repo.repoId === repoId ? 'true' : undefined}>{entry.repo.repoId === repoId ? '✓ ' : ''}{entry.repo.name}</button>)}
        <button type="button" onClick={onOpenDialog}>Ouvrir un autre dépôt…</button>
      </ActionMenu>
      <span className={styles.contextSeparator} aria-hidden="true">›</span>
      <ActionMenu label="Choisir une branche" triggerClassName={styles.selector} disabled={!repoId || busy || pending !== null} triggerContent={<><span className={styles.caption}>branche</span><span className={styles.value}><span className={styles.contextName}>{branchLabel(repo)}</span><ToolbarIcon name="chevron" /></span></>}>
        {branches.map((name) => <button key={name} type="button" disabled={name === branchLabel(repo) || Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)} aria-current={name === branchLabel(repo) ? 'true' : undefined} onClick={() => repoId && void run('Checkout', () => branchCheckout({ repoId, name }))}>{name === branchLabel(repo) ? '✓ ' : ''}{name}</button>)}
        <button type="button" onClick={onNewBranch}>Créer une branche dans le graphe…</button>
      </ActionMenu>
    </div>
    <div className={styles.gitActions} role="group" aria-label="Actions Git">
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title="Récupérer les références distantes" onClick={() => repoId && void run('Fetch', () => syncFetch(repoId, remote))}><ToolbarIcon name="fetch" /><span>Fetch</span></button>
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title="Récupérer et intégrer les commits de la branche distante" onClick={() => sync('pull')}><ToolbarIcon name="pull" /><span>Pull</span></button>
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title="Envoyer les commits de la branche courante" onClick={() => sync('push')}><ToolbarIcon name="push" /><span>Push</span></button>
      <button type="button" className={styles.action} disabled={!repoId || busy} onClick={onNewBranch} title="Créer une branche dans le graphe"><ToolbarIcon name="branch" /><span>Branche</span></button>
      <button type="button" className={styles.action} disabled={disabled} onClick={() => onNavigate('stash')} title="Créer et gérer les stashes"><ToolbarIcon name="stash" /><span>Stash</span></button>
      <button type="button" className={styles.action} disabled={disabled || !latestStash || Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)} title={latestStash ? `Réappliquer le dernier stash : ${latestStash.message}` : 'Aucun stash à réappliquer'} onClick={() => repoId && latestStash && void run('Pop', () => stashPop(repoId, latestStash.selector))}><ToolbarIcon name="pop" /><span>Pop</span></button>
      <span className={styles.divider} aria-hidden="true" />
      <button
        type="button"
        className={`${styles.action} ${styles.wideOnly}`}
        disabled={!repoId || busy || pending !== null || !undo}
        title={undo?.undoLabel ?? 'Aucune opération annulable'}
        aria-keyshortcuts="Meta+Z Control+Z"
        onClick={() => void run('Annulation', onUndo)}
      >
        <ToolbarIcon name="undo" /><span>Undo</span>
      </button>
      <button
        type="button"
        className={`${styles.action} ${styles.wideOnly}`}
        disabled={!repoId || busy || pending !== null || !redo}
        title={redo?.redoLabel ?? 'Aucune opération à rétablir'}
        aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
        onClick={() => void run('Rétablissement', onRedo)}
      >
        <ToolbarIcon name="redo" /><span>Redo</span>
      </button>
      <button type="button" className={`${styles.action} ${styles.wideOnly}`} disabled={disabled} title="Ouvrir le terminal dans ce dépôt" onClick={() => repoId && void run('Terminal', () => toolOpen({ repoId, kind:'terminal' }))}><ToolbarIcon name="terminal" /><span>Terminal</span></button>
    </div>
    <div className={styles.utilities}>
      <span className={styles.notice} role="status">{pending ? `${pending}…` : notice}</span>
      <ActionMenu label="Autres actions du dépôt" triggerClassName={styles.action} triggerContent={<><ToolbarIcon name="actions" /><span>Actions</span></>}>
        <button type="button" disabled={!repoId || busy || pending !== null || !undo} onClick={() => void run('Annulation', onUndo)}>
          Annuler · {undo?.undoLabel ?? 'aucune opération'}
        </button>
        <button type="button" disabled={!repoId || busy || pending !== null || !redo} onClick={() => void run('Rétablissement', onRedo)}>
          Rétablir · {redo?.redoLabel ?? 'aucune opération'}
        </button>
        <button type="button" disabled={disabled} onClick={() => repoId && void run('Terminal', () => toolOpen({ repoId, kind:'terminal' }))}>
          Ouvrir le terminal
        </button>
        <button type="button" onClick={onRefresh} disabled={!repoId || busy} aria-label="Rafraîchir l'état du dépôt">Rafraîchir l’état du dépôt</button>
        <button type="button" onClick={() => onNavigate('sync')} disabled={!repoId}>Options de synchronisation</button>
        <button type="button" onClick={() => onNavigate('tools')} disabled={!repoId}>Outils externes</button>
        <button type="button" onClick={() => onNavigate('recovery')}>Journal et récupération</button>
      </ActionMenu>
      <button type="button" className={styles.action} onClick={onOpenPalette} aria-label="Rechercher une commande" title="Ouvrir la palette de commandes · ⌘K"><ToolbarIcon name="search" /><span>Commandes</span></button>
    </div>
  </div>
}
