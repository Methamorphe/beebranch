import { useState } from 'react'
import type { ViewId } from '../data/navigation'
import { operationJournal, refsGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type { OperationRecord, RepoView } from '../types/git'
import { ActionMenu } from './ActionMenu'
import styles from './StatusBar.module.css'

type Props = {
  repo: RepoView | null
  gitlabConnected: boolean
  githubConnected: boolean
  lastOperation?: string | null
  canUndo?: boolean
  onNavigate: (view: ViewId) => void
  onCheckoutBranch: (name: string) => Promise<unknown>
  onNewBranch: () => void
  onUndo: () => void
  onError: (message: string) => void
}

function branchName(repo: RepoView | null): string {
  const head = repo?.state.head
  if (!head) {
    return '—'
  }
  if (head.kind === 'branch') {
    return head.name
  }
  if (head.kind === 'detached') {
    return `detached ${head.sha.slice(0, 8)}`
  }
  return head.branch ?? 'unborn'
}

function operation(repo: RepoView | null): string | null {
  const value = repo?.state.operation
  if (!value) {
    return null
  }
  if (value.kind === 'rebase') {
    return `rebase (${value.variant})`
  }
  if (value.kind === 'sequencer') {
    return value.sequencer
  }
  return value.kind
}

const OPERATION_LABELS: Record<OperationRecord['state'], string> = {
  queued: 'en attente',
  running: 'en cours',
  done: 'terminée',
  failed: 'échouée',
  cancelled: 'annulée',
  interrupted: 'interrompue',
}

export function StatusBar({
  repo,
  gitlabConnected,
  githubConnected,
  lastOperation,
  canUndo = false,
  onNavigate,
  onCheckoutBranch,
  onNewBranch,
  onUndo,
  onError,
}: Props) {
  const repoId = repo?.repo.repoId ?? null
  const worktree = repo?.state.worktree
  const conflicts = repo?.state.conflicts.files.length ?? 0
  const activeOperation = operation(repo)
  const undoLabel = lastOperation?.replace(/^annuler\s+/i, '') ?? null
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchPending, setBranchPending] = useState<string | null>(null)
  const [journal, setJournal] = useState<OperationRecord[]>([])
  const [journalLoading, setJournalLoading] = useState(false)

  const loadBranches = async () => {
    if (!repoId) {
      return
    }
    setBranchesLoading(true)
    try {
      const snapshot = await refsGet(repoId)
      setBranches(
        snapshot.data.entries
          .filter((entry) => entry.kind === 'branch')
          .map((entry) => entry.name),
      )
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBranchesLoading(false)
    }
  }

  const loadJournal = async () => {
    setJournalLoading(true)
    try {
      const records = await operationJournal(8)
      setJournal(
        records.filter((record) => !record.repoId || record.repoId === repoId),
      )
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setJournalLoading(false)
    }
  }

  const checkout = async (name: string) => {
    setBranchPending(name)
    try {
      await onCheckoutBranch(name)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBranchPending(null)
    }
  }

  return (
    <footer className={styles.status} aria-label="État du dépôt">
      <ActionMenu
        label={`Choisir une branche · ${branchName(repo)}`}
        triggerClassName={`${styles.segment} ${styles.branch}`}
        disabled={!repoId}
        onOpen={() => void loadBranches()}
        triggerContent={<><span aria-hidden="true">⑂</span><span>{branchPending ? `checkout ${branchPending}…` : branchName(repo)}</span></>}
      >
        {branchesLoading ? <span className={styles.menuState}>Chargement des branches…</span> : null}
        {!branchesLoading && branches.length === 0 ? <span className={styles.menuState}>Aucune branche locale.</span> : null}
        {branches.map((name) => (
          <button
            key={name}
            type="button"
            aria-current={name === branchName(repo) ? 'true' : undefined}
            disabled={
              branchPending !== null ||
              name === branchName(repo) ||
              Boolean(repo?.state.operation) ||
              conflicts > 0
            }
            onClick={() => void checkout(name)}
          >
            {name === branchName(repo) ? '✓ ' : ''}
            {name}
          </button>
        ))}
        <button type="button" onClick={onNewBranch}>Créer une branche dans le graphe…</button>
      </ActionMenu>
      {worktree ? (
        <button type="button" className={`${styles.segment} ${styles.counts}`} onClick={() => onNavigate('status')} title="Ouvrir les modifications">
          {worktree.staged} préparé(s) · {worktree.unstaged} modifié(s) · {worktree.untracked} nouveau(x)
        </button>
      ) : null}
      {conflicts > 0 ? (
        <button type="button" className={`${styles.segment} ${styles.conflicts}`} onClick={() => onNavigate('conflicts')}>
          {conflicts} conflit(s)
        </button>
      ) : null}
      {activeOperation ? (
        <button
          key={activeOperation}
          type="button"
          className={`${styles.segment} ${styles.operation}`}
          onClick={() => onNavigate(repo?.state.operation?.kind === 'rebase' ? 'rebase' : 'conflicts')}
          title="Gérer l’opération en cours"
        >
          opération : {activeOperation}
        </button>
      ) : null}
      <span className={styles.spacer} />

      <button
        type="button"
        className={styles.segment}
        onClick={() => onNavigate(gitlabConnected ? 'gitlab' : 'github')}
        title={gitlabConnected ? 'Ouvrir la connexion GitLab' : 'Ouvrir la connexion GitHub'}
      >
        <span
          className={styles.dot}
          data-connected={gitlabConnected || githubConnected}
          aria-hidden="true"
        />
        <span className={styles.muted}>
          {gitlabConnected && githubConnected
            ? 'GitLab + GitHub'
            : gitlabConnected
              ? 'GitLab connecté'
              : githubConnected
                ? 'GitHub connecté'
                : 'Local-first'}
        </span>
      </button>
      <ActionMenu
        label="Journal des opérations"
        triggerClassName={`${styles.segment} ${styles.journal}`}
        disabled={!repoId}
        onOpen={() => void loadJournal()}
        triggerContent="Opérations"
      >
        <span className={styles.menuHeading}>Opérations récentes</span>
        {activeOperation ? (
          <button type="button" onClick={() => onNavigate(repo?.state.operation?.kind === 'rebase' ? 'rebase' : 'conflicts')}>
            Gérer l’opération en cours
          </button>
        ) : null}
        {canUndo && undoLabel ? (
          <button type="button" onClick={onUndo}>Annuler · {undoLabel}</button>
        ) : null}
        {journalLoading ? <span className={styles.menuState}>Chargement…</span> : null}
        {!journalLoading && journal.length === 0 ? <span className={styles.menuState}>Aucune opération récente.</span> : null}
        {journal.map((record) => (
          <span key={record.id} className={styles.journalRow}>
            <span>{record.kind}</span>
            <em data-state={record.state}>{OPERATION_LABELS[record.state]}</em>
          </span>
        ))}
        <button type="button" onClick={() => onNavigate('recovery')}>Journal et récupération</button>
      </ActionMenu>
      <span className={styles.srOnly} role="status">
        {activeOperation ? `Opération en cours : ${activeOperation}` : ''}
      </span>
    </footer>
  )
}
