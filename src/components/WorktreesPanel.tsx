import { useCallback, useEffect, useState } from 'react'
import {
  worktreeList,
  worktreeLock,
  worktreePrune,
  worktreeRemove,
  worktreeRepair,
  worktreeUnlock,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { t, useI18n } from '../i18n'
import type { WorktreeEntry, WorktreePruneEntry, WorktreeReport } from '../types/git'
import { ConfirmBar } from './ConfirmBar'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { useToastChannel } from './ui/Toasts'
import p2 from './p2.module.css'
import shared from './p1.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
  onOpenRepo: (path: string) => void
  onCreate: () => void
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function lockState(entry: WorktreeEntry): {
  tone: string
  label: string
} {
  if (entry.locked !== undefined) {
    return { tone: 'warn', label: t('ops.worktree.locked') }
  }
  if (entry.dirty === undefined) {
    return { tone: '', label: t('ops.worktree.unknownStatus') }
  }
  if (entry.dirty) {
    return { tone: 'warn', label: t('ops.worktree.changedFiles', { count: entry.changedFiles ?? 0 }) }
  }
  return { tone: 'good', label: t('ops.worktree.clean') }
}

export function WorktreesPanel({ repoId, generation, onMutated, onOpenRepo, onCreate }: Props) {
  const { t } = useI18n()
  const pushNotice = useToastChannel('worktrees', 'success')
  const [report, setReport] = useState<WorktreeReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<WorktreeEntry | null>(null)
  const [lockTarget, setLockTarget] = useState<WorktreeEntry | null>(null)
  const [lockReason, setLockReason] = useState('')
  const [pruneOpen, setPruneOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [expire, setExpire] = useState('')
  const [removeBranch, setRemoveBranch] = useState(false)
  const [pruned, setPruned] = useState<WorktreePruneEntry[] | null>(null)

  const load = useCallback(async () => {
    try {
      setReport(await worktreeList(repoId, true))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, generation])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      pushNotice(label)
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const entries = (report?.entries ?? []).filter((entry) => {
    const needle = filter.trim().toLowerCase()
    if (!needle) {
      return true
    }
    return (
      entry.path.toLowerCase().includes(needle) ||
      (entry.branch ?? '').toLowerCase().includes(needle)
    )
  })

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <span className={`${p2.count} ${p2.tabnum}`}>
          {t('ops.worktree.count', { count: entries.length })}
        </span>
        <label className={p2.grow}>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('ops.worktree.filterPlaceholder')}
            aria-label={t('ops.worktree.filterAria')}
            spellCheck={false}
          />
        </label>
        <span className={p2.spacer} />
        <button
          type="button"
          className={p2.ghost}
          disabled={busy}
          title={t('ops.worktree.repairHint')}
          onClick={() =>
            void run(t('ops.worktree.notice.repaired'), () => worktreeRepair({ repoId }))
          }
        >
          {t('ops.worktree.repair')}
        </button>
        <button type="button" className={p2.secondary} disabled={busy} onClick={() => setPruneOpen(true)}>
          {t('ops.worktree.prune')}
        </button>
        <button type="button" className={p2.primary} onClick={onCreate}>
          {t('common.create')}
        </button>
      </div>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}

      {pruned && pruned.length > 0 ? (
        <div className={p2.rows} aria-label={t('ops.worktree.prunedListAria')}>
          {pruned.map((entry) => (
            <div key={entry.path} className={p2.entry}>
              <span className={p2.dot} data-tone="warn" />
              <span className={p2.entryTitle} title={entry.path}>
                {folderName(entry.path)}
              </span>
              <span className={p2.entryMeta}>{entry.reason || t('ops.worktree.pruneNoReason')}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          <div className={p2.rows}>
            {entries.map((entry) => {
              const state = lockState(entry)
              return (
                <div key={entry.path} className={p2.entry}>
                  <span className={p2.dot} data-tone={state.tone || undefined} />
                  <div className={p2.entryStack}>
                    <button
                      type="button"
                      className={p2.linkButton}
                      onClick={() => onOpenRepo(entry.path)}
                      title={t('ops.worktree.openTitle', { path: entry.path })}
                    >
                      {folderName(entry.path)}
                    </button>
                    <span className={p2.entryMeta}>
                      <span className={p2.path} title={entry.path}>
                        {entry.path}
                      </span>
                    </span>
                    <span className={p2.entryMeta}>
                      <span className={`${p2.chip} ${entry.branch ? '' : p2.chipWarn}`}>
                        {entry.branch ?? (entry.detached ? t('ops.worktree.detached') : '—')}
                      </span>
                      {entry.main ? <span className={`${p2.chip} ${p2.chipAccent}`}>{t('ops.worktree.main')}</span> : null}
                      <span className={p2.meta}>{state.label}</span>
                    </span>
                  </div>
                  <span className={p2.entryActions}>
                    <button
                      type="button"
                      className={p2.secondary}
                      disabled={busy}
                      onClick={() => onOpenRepo(entry.path)}
                    >
                      {t('ops.worktree.open')}
                    </button>
                    {entry.main ? null : (
                      <>
                        {entry.locked !== undefined ? (
                          <button
                            type="button"
                            className={p2.ghost}
                            disabled={busy}
                            onClick={() =>
                              void run(t('ops.worktree.notice.unlocked'), () =>
                                worktreeUnlock({ repoId, path: entry.path }),
                              )
                            }
                          >
                            {t('ops.worktree.unlock')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={p2.ghost}
                            disabled={busy}
                            onClick={() => {
                              setLockReason('')
                              setLockTarget(entry)
                            }}
                          >
                            {t('ops.worktree.lock')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={p2.ghostDanger}
                          disabled={busy}
                          onClick={() => setPendingRemove(entry)}
                        >
                          {t('ops.worktree.remove')}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              )
            })}
          </div>

          {!report ? (
            <div className={p2.empty} role="status">
              <h2>{t('common.loading')}</h2>
              <p>{t('ops.worktree.loadingBody')}</p>
            </div>
          ) : null}
          {report && entries.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('ops.worktree.emptyTitle')}</h2>
              <p>{t('ops.worktree.emptyBody')}</p>
              <button type="button" className={p2.primary} onClick={onCreate}>
                {t('common.create')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <Dialog open={lockTarget !== null} onClose={() => setLockTarget(null)} busy={busy} titleId="worktree-lock-title">
        <h2 id="worktree-lock-title">{t('ops.worktree.lockTitle')}</h2>
        <p>
          <code>{lockTarget?.path}</code>
        </p>
        <label className={shared.field}>
          {t('ops.worktree.lockReasonLabel')}
          <input
            data-autofocus
            value={lockReason}
            onChange={(event) => setLockReason(event.target.value)}
            placeholder={t('ops.worktree.lockReasonPlaceholder')}
          />
        </label>
        <div className={shared.dialogActions}>
          <Button type="button" onClick={() => setLockTarget(null)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !lockTarget}
            onClick={() => {
              const target = lockTarget
              setLockTarget(null)
              if (!target) return
              void run(t('ops.worktree.notice.locked'), () =>
                worktreeLock({
                  repoId,
                  path: target.path,
                  reason: lockReason.trim() || undefined,
                }),
              )
            }}
          >
            {t('ops.worktree.lock')}
          </Button>
        </div>
      </Dialog>

      <ConfirmBar
        open={pendingRemove !== null}
        title={t('ops.worktree.removeTitle')}
        consequence={t('ops.worktree.removeConsequence', { path: pendingRemove?.path ?? '' })}
        irreversible
        confirmLabel={t('ops.worktree.remove')}
        busy={busy}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const target = pendingRemove
          const deleteBranch = removeBranch
          setPendingRemove(null)
          setRemoveBranch(false)
          if (!target) return
          void run(
            deleteBranch ? t('ops.worktree.notice.removedWithBranch') : t('ops.worktree.notice.removed'),
            () =>
              worktreeRemove({
                repoId,
                path: target.path,
                force: Boolean(target.dirty),
                deleteBranch,
                confirmation: { acknowledged: true },
              }),
          )
        }}
      >
        {pendingRemove?.branch ? (
          <label className={p2.checkbox}>
            <input
              type="checkbox"
              checked={removeBranch}
              onChange={(event) => setRemoveBranch(event.target.checked)}
            />
            {t('ops.worktree.removeBranch', { branch: pendingRemove.branch })}
          </label>
        ) : null}
      </ConfirmBar>

      <ConfirmBar
        open={pruneOpen}
        title={t('ops.worktree.pruneTitle')}
        consequence={t('ops.worktree.pruneConsequence')}
        confirmLabel={t('ops.worktree.pruneConfirm')}
        busy={busy}
        onCancel={() => setPruneOpen(false)}
        onConfirm={() => {
          setPruneOpen(false)
          setPruned(null)
          void run(t('ops.worktree.notice.pruneDone'), async () => {
            const result = await worktreePrune({
              repoId,
              dryRun: false,
              expire: expire.trim() || undefined,
            })
            setPruned(result.data.removed)
          })
        }}
      >
        <label className={p2.field}>
          {t('ops.worktree.expireLabel')}
          <input
            value={expire}
            onChange={(event) => setExpire(event.target.value)}
            placeholder="3.days.ago"
            aria-label={t('ops.worktree.expireAria')}
            spellCheck={false}
          />
        </label>
      </ConfirmBar>
    </div>
  )
}
