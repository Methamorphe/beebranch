import type { RepoView } from '../types/git'
import styles from './StatusBar.module.css'

type Props = {
  repo: RepoView | null
  generation: number
  connected: boolean
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

export function StatusBar({ repo, connected }: Props) {
  const worktree = repo?.state.worktree
  const conflicts = repo?.state.conflicts.files.length ?? 0
  return (
    <footer className={styles.status} role="status">
      <span className={styles.branch}>⑂ {branchName(repo)}</span>
      {worktree ? (
        <span>
          {worktree.staged} préparé(s) · {worktree.unstaged} modifié(s) ·{' '}
          {worktree.untracked} nouveau(x)
        </span>
      ) : null}
      {conflicts > 0 ? (
        <span className={styles.conflicts}>{conflicts} conflit(s)</span>
      ) : null}
      {operation(repo) ? (
        <span className={styles.operation}>opération : {operation(repo)}</span>
      ) : null}
      <span className={styles.spacer} />

      <span className={styles.dot} data-connected={connected} aria-hidden="true" />
      <span className={styles.muted}>
        {connected ? 'GitLab connecté' : 'Local-first'}
      </span>
    </footer>
  )
}
