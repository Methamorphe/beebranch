import { useState } from 'react'
import type { ViewId } from '../data/navigation'
import { operationJournal, refsGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { formatNumber, useI18n, type I18n, type MessageKey } from '../i18n'
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

function operation(repo: RepoView | null, t: I18n['t']): string | null {
  const value = repo?.state.operation
  if (!value) {
    return null
  }
  if (value.kind === 'rebase') {
    return t('shell.operation.rebaseVariant', { variant: value.variant })
  }
  if (value.kind === 'sequencer') {
    return value.sequencer
  }
  return value.kind
}

const OPERATION_STATE_KEYS: Record<OperationRecord['state'], MessageKey> = {
  queued: 'shell.operation.state.queued',
  running: 'shell.operation.state.running',
  done: 'shell.operation.state.done',
  failed: 'shell.operation.state.failed',
  cancelled: 'shell.operation.state.cancelled',
  interrupted: 'shell.operation.state.interrupted',
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
  const { t, plural } = useI18n()
  const repoId = repo?.repo.repoId ?? null
  const worktree = repo?.state.worktree
  const conflicts = repo?.state.conflicts.files.length ?? 0
  const activeOperation = operation(repo, t)
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
    <footer className={styles.status} aria-label={t('shell.statusBar.aria')}>
      <ActionMenu
        label={t('shell.statusBar.chooseBranch', { name: branchName(repo) })}
        triggerClassName={`${styles.segment} ${styles.branch}`}
        disabled={!repoId}
        onOpen={() => void loadBranches()}
        triggerContent={<><span aria-hidden="true">⑂</span><span>{branchPending ? t('shell.statusBar.checkoutPending', { name: branchPending }) : branchName(repo)}</span></>}
      >
        {branchesLoading ? <span className={styles.menuState}>{t('shell.statusBar.loadingBranches')}</span> : null}
        {!branchesLoading && branches.length === 0 ? <span className={styles.menuState}>{t('shell.statusBar.noLocalBranch')}</span> : null}
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
        <button type="button" onClick={onNewBranch}>{t('shell.action.createBranchInGraph')}</button>
      </ActionMenu>
      {worktree ? (
        <button type="button" className={`${styles.segment} ${styles.counts}`} onClick={() => onNavigate('status')} title={t('shell.statusBar.openChanges')}>
          {plural('shell.statusBar.staged.one', 'shell.statusBar.staged.other', worktree.staged, { count: formatNumber(worktree.staged) })} · {plural('shell.statusBar.modified.one', 'shell.statusBar.modified.other', worktree.unstaged, { count: formatNumber(worktree.unstaged) })} · {plural('shell.statusBar.untracked.one', 'shell.statusBar.untracked.other', worktree.untracked, { count: formatNumber(worktree.untracked) })}
        </button>
      ) : null}
      {conflicts > 0 ? (
        <button type="button" className={`${styles.segment} ${styles.conflicts}`} onClick={() => onNavigate('conflicts')}>
          {plural('shell.statusBar.conflicts.one', 'shell.statusBar.conflicts.other', conflicts, { count: formatNumber(conflicts) })}
        </button>
      ) : null}
      {activeOperation ? (
        <button
          key={activeOperation}
          type="button"
          className={`${styles.segment} ${styles.operation}`}
          onClick={() => onNavigate(repo?.state.operation?.kind === 'rebase' ? 'rebase' : 'conflicts')}
          title={t('shell.statusBar.manageOperation')}
        >
          {t('shell.statusBar.operation', { operation: activeOperation })}
        </button>
      ) : null}
      <span className={styles.spacer} />

      <button
        type="button"
        className={styles.segment}
        onClick={() => onNavigate(gitlabConnected ? 'gitlab' : 'github')}
        title={gitlabConnected ? t('shell.statusBar.openGitlab') : t('shell.statusBar.openGithub')}
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
              ? t('shell.statusBar.gitlabConnected')
              : githubConnected
                ? t('shell.statusBar.githubConnected')
                : t('shell.statusBar.localFirst')}
        </span>
      </button>
      <ActionMenu
        label={t('shell.statusBar.journal')}
        triggerClassName={`${styles.segment} ${styles.journal}`}
        disabled={!repoId}
        onOpen={() => void loadJournal()}
        triggerContent={t('shell.statusBar.operations')}
      >
        <span className={styles.menuHeading}>{t('shell.statusBar.recentOperations')}</span>
        {activeOperation ? (
          <button type="button" onClick={() => onNavigate(repo?.state.operation?.kind === 'rebase' ? 'rebase' : 'conflicts')}>
            {t('shell.statusBar.manageOperation')}
          </button>
        ) : null}
        {canUndo && lastOperation ? (
          <button type="button" onClick={onUndo}>{t('shell.undo.action', { action: lastOperation })}</button>
        ) : null}
        {journalLoading ? <span className={styles.menuState}>{t('common.loading')}</span> : null}
        {!journalLoading && journal.length === 0 ? <span className={styles.menuState}>{t('shell.statusBar.noRecentOperation')}</span> : null}
        {journal.map((record) => (
          <span key={record.id} className={styles.journalRow}>
            <span>{record.kind}</span>
            <em data-state={record.state}>{t(OPERATION_STATE_KEYS[record.state])}</em>
          </span>
        ))}
        <button type="button" onClick={() => onNavigate('recovery')}>{t('shell.action.journalAndRecovery')}</button>
      </ActionMenu>
      <span className={styles.srOnly} role="status">
        {activeOperation ? t('shell.operation.inProgressValue', { operation: activeOperation }) : ''}
      </span>
    </footer>
  )
}
