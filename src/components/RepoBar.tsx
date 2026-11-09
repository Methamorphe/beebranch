import { useEffect, useState } from 'react'
import type { RepoView, StashEntry, UndoEntry } from '../types/git'
import { errorMessage } from '../ipc/client'
import { branchCheckout, refsGet, stashCreate, stashList, stashPop, syncFetch, syncPull, syncPush, toolOpen } from '../ipc/commands'
import { pullNotice } from '../lib/syncNotice'
import { undoButtonLabel } from '../lib/undoLabel'
import { isPushRejection, type PushRejection } from '../lib/pushRejection'
import { useI18n, type I18n } from '../i18n'
import type { ViewId } from '../data/navigation'
import { ActionMenu } from './ActionMenu'
import { PipelineStatus } from './PipelineStatus'
import { useCheckoutConfirm, useOperationConfirm, usePushConfirm } from './OperationConfirm'
import { PublishBranchBar, type PublishTarget } from './PublishBranchBar'
import { ToolbarIcon } from './ToolbarIcon'
import { useToastChannel } from './ui/Toasts'
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
  /** A push Git refused: the dialog decides between pull and force. */
  onPushRejected: (rejection: PushRejection) => void
  undo: UndoEntry | null
  redo: UndoEntry | null
  onUndo: () => Promise<unknown>
  onRedo: () => Promise<unknown>
}

function branchLabel(repo: RepoView | null, t: I18n['t']) {
  const head = repo?.state.head
  if (head?.kind === 'branch') return head.name
  if (head?.kind === 'detached') return `HEAD · ${head.sha.slice(0, 8)}`
  return head?.kind === 'unborn' ? head.branch ?? t('shell.repoBar.newBranch') : t('shell.repoBar.noBranch')
}

export function RepoBar({ repo, repos, busy, onActivate, onOpenDialog, onOpenPalette, onRefresh, onNavigate, onNewBranch, onError, onPushRejected, undo, redo, onUndo, onRedo }: Props) {
  const { t } = useI18n()
  const confirmOperation = useOperationConfirm()
  const confirmPush = usePushConfirm()
  const confirmCheckout = useCheckoutConfirm()
  const [pending, setPending] = useState<string | null>(null)
  const setNotice = useToastChannel('repobar-notice', 'success')
  const [branches, setBranches] = useState<string[]>([])
  const [remotes, setRemotes] = useState<string[]>([])
  const [publish, setPublish] = useState<PublishTarget | null>(null)
  const [latestStash, setLatestStash] = useState<StashEntry | null>(null)
  const repoId = repo?.repo.repoId ?? null
  useEffect(() => {
    let cancelled = false
    setLatestStash(null)
    setBranches([])
    setRemotes([])
    if (repoId) void Promise.allSettled([stashList(repoId), refsGet(repoId)]).then(([stashes, refs]) => {
      if (cancelled) return
      if (stashes.status === 'fulfilled') setLatestStash(stashes.value[0] ?? null)
      if (refs.status === 'fulfilled') {
        setBranches(refs.value.data.entries.filter((entry) => entry.kind === 'branch').map((entry) => entry.name))
        setRemotes(refs.value.data.remotes)
      }
    })
    return () => { cancelled = true }
  }, [repoId, repo?.generation])
  const head = repo?.state.head
  const upstream = head?.kind === 'branch' ? head.upstream : undefined
  const [remote, ...parts] = upstream?.split('/') ?? ['origin']
  const remoteBranch = parts.join('/')
  const changes = repo?.state.worktree
  const stashBlocked = !changes || !(changes.staged || changes.unstaged || changes.untracked) || head?.kind === 'unborn' || Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)
  const disabled = !repoId || busy || pending !== null
  // A blocked undo/redo stays visible but disabled, with the reason as tooltip.
  const undoBlocked = undo?.blocked ? errorMessage(undo.blocked) : null
  const redoBlocked = redo?.blocked ? errorMessage(redo.blocked) : null
  const run = async <T,>(label: string, action: () => Promise<T>, describe?: (result: T) => string | null, pushTarget?: PushRejection) => {
    if (!repoId) return
    setPending(label); setNotice(null)
    try {
      const result = await action()
      // `null` means the caller reports the outcome itself (undo, redo).
      const text = describe ? describe(result) : t('shell.repoBar.actionDone', { action: label })
      if (text) setNotice(text)
      onRefresh()
    }
    catch (cause) {
      // A refused push is a decision, not an error: the recovery bar owns
      // the fetch, the pull and the confirmed force push.
      if (pushTarget && isPushRejection(cause)) onPushRejected(pushTarget)
      else onError(errorMessage(cause))
    }
    finally { setPending(null) }
  }
  const publishBranch = () => {
    const target = publish
    setPublish(null)
    if (!repoId || !target) return
    void run(
      'Publish',
      () => syncPush({ repoId, remote: target.remote, branch: target.branch, setUpstream: true }),
      () => t('workbench.notice.branchPushed', { branch: target.branch, remote: target.remote }),
      { repoId, remote: target.remote, branch: target.branch },
    )
  }
  const sync = (kind: 'pull' | 'push') => {
    if (!repoId) return
    if (!upstream || !remoteBranch) {
      // A local branch without upstream cannot be pushed yet. Publishing is
      // one decision (push + upstream), so ask it here instead of leaving the
      // user in the sync panel with fields to fill.
      const current = head?.kind === 'branch' ? head.name : null
      const target = remotes.includes('origin') ? 'origin' : remotes[0]
      if (kind === 'push' && current && target) {
        setNotice(null)
        setPublish({ branch: current, remote: target })
        return
      }
      onNavigate('sync')
      return
    }
    if (kind === 'push') {
      void confirmPush({ repoId, remote, branch: remoteBranch }).then((confirmed) => {
        if (!confirmed) return
        void run('Push', () => syncPush({ repoId, remote, branch: remoteBranch }), undefined, { repoId, remote, branch: remoteBranch })
      })
      return
    }
    void confirmOperation({
      title: t('workbench.operationPreview.title.pull', { branch: remoteBranch, remote }),
      confirmLabel: t('workbench.operationPreview.action.pull'),
      operation: { kind: 'pull', remote, branch: remoteBranch },
    }).then((confirmed) => {
      if (!confirmed) return
      void run(
        'Pull',
        () => syncPull({ repoId, remote, branch: remoteBranch }),
        (result) => pullNotice(result.data),
      )
    })
  }
  return <div className={styles.root} role="region" aria-label={t('shell.repoBar.aria')} onFocusCapture={(event) => { if (event.target instanceof HTMLElement && !event.target.closest('[popover]')) event.target.scrollIntoView({ block:'nearest', inline:'nearest' }) }}>
    <div className={styles.identity}>
      <ActionMenu label={t('shell.repoBar.chooseRepo')} triggerClassName={styles.selector} triggerContent={<><span className={styles.caption}>{t('shell.repoBar.repoCaption')}</span><span className={styles.value}><span className={styles.contextName}>{repo?.repo.name ?? t('shell.topbar.openRepo')}</span><ToolbarIcon name="chevron" /></span></>}>
        {repos.map((entry) => <button key={entry.repo.repoId} type="button" onClick={() => onActivate(entry.repo.repoId)} aria-current={entry.repo.repoId === repoId ? 'true' : undefined}>{entry.repo.repoId === repoId ? '✓ ' : ''}{entry.repo.name}</button>)}
        <button type="button" onClick={onOpenDialog}>{t('shell.repoBar.openAnotherRepo')}</button>
      </ActionMenu>
      <span className={styles.contextSeparator} aria-hidden="true"><ToolbarIcon name="chevronRight" size={12} /></span>
      <ActionMenu label={t('shell.repoBar.chooseBranch')} triggerClassName={styles.selector} disabled={!repoId || busy || pending !== null} triggerContent={<><span className={styles.caption}>{t('shell.repoBar.branchCaption')}</span><span className={styles.value}><span className={styles.contextName}>{branchLabel(repo, t)}</span><ToolbarIcon name="chevron" /></span></>}>
        {branches.map((name) => <button key={name} type="button" disabled={name === branchLabel(repo, t) || Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)} aria-current={name === branchLabel(repo, t) ? 'true' : undefined} onClick={() => repoId && void confirmCheckout(repoId, {
          title: t('workbench.operationPreview.title.checkout', { target: name }),
          confirmLabel: t('workbench.operationPreview.action.checkout'),
          operation: { kind: 'checkout', name },
        }).then((confirmed) => { if (confirmed) void run('Checkout', () => branchCheckout({ repoId, name })) })}>{name === branchLabel(repo, t) ? '✓ ' : ''}{name}</button>)}
        <button type="button" onClick={onNewBranch}>{t('shell.action.createBranchInGraph')}</button>
      </ActionMenu>
    </div>
    <div className={styles.gitActions} role="group" aria-label={t('shell.repoBar.gitActions')}>
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title={t('shell.repoBar.fetchTitle')} onClick={() => repoId && void run('Fetch', () => syncFetch(repoId, remote))}><ToolbarIcon name="fetch" /><span>Fetch</span></button>
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title={t('shell.repoBar.pullTitle')} onClick={() => sync('pull')}><ToolbarIcon name="pull" /><span>Pull</span></button>
      <button type="button" className={`${styles.action} ${styles.gitPrimary}`} disabled={disabled} title={upstream ? t('shell.repoBar.pushTitle') : t('shell.repoBar.publishTitle')} onClick={() => sync('push')}><ToolbarIcon name="push" /><span>Push</span></button>
      <button type="button" className={styles.action} disabled={!repoId || busy} onClick={onNewBranch} title={t('shell.repoBar.branchTitle')}><ToolbarIcon name="branch" /><span>{t('common.branch')}</span></button>
      <button type="button" className={styles.action} disabled={disabled || stashBlocked} onClick={() => repoId && void run('Stash', () => stashCreate({ repoId, includeUntracked: true }), () => t('commit.stash.createdNotice'))} title={t('shell.repoBar.stashTitle')}><ToolbarIcon name="stash" /><span>Stash</span></button>
      <button type="button" className={styles.action} disabled={disabled || !latestStash || Boolean(repo?.state.operation) || Boolean(repo?.state.conflicts.files.length)} title={latestStash ? t('shell.repoBar.popTitle', { message: latestStash.message }) : t('shell.repoBar.noStash')} onClick={() => repoId && latestStash && void confirmOperation({
        title: t('workbench.operationPreview.title.stashPop', { selector: latestStash.selector }),
        confirmLabel: t('workbench.operationPreview.action.stashPop'),
        operation: { kind: 'stashPop', selector: latestStash.selector },
      }).then((confirmed) => { if (confirmed) void run('Pop', () => stashPop(repoId, latestStash.selector)) })}><ToolbarIcon name="pop" /><span>Pop</span></button>
      <span className={styles.divider} aria-hidden="true" />
      <button
        type="button"
        className={`${styles.action} ${styles.wideOnly}`}
        disabled={!repoId || busy || pending !== null || !undo || Boolean(undoBlocked)}
        title={undo ? [undoButtonLabel(undo, 'undo'), undoBlocked].filter(Boolean).join(' — ') : t('shell.undo.nothingToUndo')}
        aria-keyshortcuts="Meta+Z Control+Z"
        onClick={() => void run(t('shell.undo.pending'), onUndo, () => null)}
      >
        <ToolbarIcon name="undo" /><span>Undo</span>
      </button>
      <button
        type="button"
        className={`${styles.action} ${styles.wideOnly}`}
        disabled={!repoId || busy || pending !== null || !redo || Boolean(redoBlocked)}
        title={redo ? [undoButtonLabel(redo, 'redo'), redoBlocked].filter(Boolean).join(' — ') : t('shell.undo.nothingToRedo')}
        aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z"
        onClick={() => void run(t('shell.redo.pending'), onRedo, () => null)}
      >
        <ToolbarIcon name="redo" /><span>Redo</span>
      </button>
      <button type="button" className={`${styles.action} ${styles.wideOnly}`} disabled={disabled} title={t('shell.repoBar.terminalTitle')} onClick={() => repoId && void run('Terminal', () => toolOpen({ repoId, kind:'terminal' }), () => null)}><ToolbarIcon name="terminal" /><span>Terminal</span></button>
    </div>
    <div className={styles.utilities}>
      <PipelineStatus repoId={repoId} generation={repo?.generation ?? 0} />
      <span className={styles.notice} role="status">{pending ? `${pending}…` : null}</span>
      <ActionMenu label={t('shell.repoBar.otherActions')} triggerClassName={styles.action} triggerContent={<><ToolbarIcon name="actions" /><span>{t('common.actions')}</span></>}>
        <button type="button" disabled={!repoId || busy || pending !== null || !undo || Boolean(undoBlocked)} title={undoBlocked ?? undefined} onClick={() => void run(t('shell.undo.pending'), onUndo, () => null)}>
          {undo ? undoButtonLabel(undo, 'undo') : t('shell.undo.action', { action: t('shell.undo.none') })}
        </button>
        <button type="button" disabled={!repoId || busy || pending !== null || !redo || Boolean(redoBlocked)} title={redoBlocked ?? undefined} onClick={() => void run(t('shell.redo.pending'), onRedo, () => null)}>
          {redo ? undoButtonLabel(redo, 'redo') : t('shell.undo.redoAction', { action: t('shell.undo.none') })}
        </button>
        <button type="button" disabled={disabled} onClick={() => repoId && void run('Terminal', () => toolOpen({ repoId, kind:'terminal' }), () => null)}>
          {t('shell.action.openTerminal')}
        </button>
        <button type="button" onClick={onRefresh} disabled={!repoId || busy} aria-label={t('shell.repoBar.refreshState')}>{t('shell.repoBar.refreshState')}</button>
        <button type="button" onClick={() => onNavigate('sync')} disabled={!repoId}>{t('shell.repoBar.syncOptions')}</button>
        <button type="button" onClick={() => onNavigate('tools')} disabled={!repoId}>{t('shell.action.externalTools')}</button>
        <button type="button" onClick={() => onNavigate('recovery')}>{t('shell.action.journalAndRecovery')}</button>
      </ActionMenu>
      <button type="button" className={styles.action} onClick={onOpenPalette} aria-label={t('shell.repoBar.searchCommand')} title={t('shell.repoBar.paletteTitle')}><ToolbarIcon name="search" /><span>{t('shell.repoBar.commands')}</span></button>
    </div>
    <PublishBranchBar
      target={publish}
      onCancel={() => setPublish(null)}
      onConfirm={publishBranch}
    />
  </div>
}
