import { useCallback, useEffect, useState } from 'react'
import {
  worktreeAdd,
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
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './ui/Dialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
  onOpenRepo: (path: string) => void
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

export function WorktreesPanel({ repoId, generation, onMutated, onOpenRepo }: Props) {
  const { t } = useI18n()
  const [report, setReport] = useState<WorktreeReport | null>(null)
  const [path, setPath] = useState('')
  const [reference, setReference] = useState('HEAD')
  const [newBranch, setNewBranch] = useState('')
  const [detach, setDetach] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
    setNotice(null)
    try {
      await action()
      setNotice(label)
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
        <span className={p2.spacer} />
        <label className={p2.fieldInline}>
          <span className={p2.toolbarLabel}>{t('ops.worktree.filterLabel')}</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('ops.worktree.filterPlaceholder')}
            aria-label={t('ops.worktree.filterAria')}
            spellCheck={false}
          />
        </label>
        <label className={p2.fieldInline}>
          <span className={p2.toolbarLabel}>{t('ops.worktree.expireLabel')}</span>
          <input
            value={expire}
            onChange={(event) => setExpire(event.target.value)}
            placeholder="3.days.ago"
            aria-label={t('ops.worktree.expireAria')}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className={p2.ghost}
          disabled={busy}
          title={t('ops.worktree.repairHint')}
          onClick={() =>
            void run(t('ops.worktree.notice.repaired'), () =>
              worktreeRepair({ repoId }),
            )
          }
        >
          {t('ops.worktree.repair')}
        </button>
        <button
          type="button"
          className={p2.ghost}
          disabled={busy}
          onClick={() => {
            setPruned(null)
            void run(t('ops.worktree.notice.pruneDryRunDone'), async () => {
              const result = await worktreePrune({
                repoId,
                dryRun: true,
                expire: expire.trim() || undefined,
              })
              setPruned(result.data.removed)
            })
          }}
        >
          {t('ops.worktree.pruneDryRun')}
        </button>
        <button
          type="button"
          className={p2.secondary}
          disabled={busy}
          onClick={() => setPruneOpen(true)}
        >
          {t('ops.worktree.prune')}
        </button>
      </div>

      <p className={p2.hintBar}>{t('ops.worktree.hint')}</p>

      {error ? (
        <p className={p2.alert} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <div className={p2.listHeader} role="status">
          <span className={p2.meta}>{notice}</span>
        </div>
      ) : null}

      {pruned && pruned.length > 0 ? (
        <div className={p2.rows} aria-label={t('ops.worktree.prunedListAria')}>
          {pruned.map((entry) => (
            <div key={entry.path} className={p2.entry}>
              <span className={p2.dot} data-tone="warn" />
              <span className={`${p2.mono} ${p2.entryTitle}`}>{entry.path}</span>
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
                      <span className={p2.mono}>{entry.path}</span>
                    </span>
                    <span className={p2.entryMeta}>
                      <span className={`${p2.chip} ${entry.branch ? '' : p2.chipWarn}`}>
                        {entry.branch ?? (entry.detached ? 'detached' : '—')}
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
            </div>
          ) : null}
        </div>

        <aside className={p2.screenAside} aria-label={t('ops.worktree.createAria')}>
          <section className={p2.asideSection}>
            <h2 className={p2.asideTitle}>{t('ops.worktree.createTitle')}</h2>
            <label className={p2.field}>
              {t('ops.worktree.pathLabel')}
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/you/src/project-feature"
                spellCheck={false}
              />
            </label>
            <label className={p2.field}>
              {t('ops.worktree.referenceLabel')}
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder={t('ops.worktree.referencePlaceholder')}
                spellCheck={false}
              />
            </label>
            <label className={p2.field}>
              {t('ops.worktree.newBranchLabel')}
              <input
                value={newBranch}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder={t('ops.worktree.newBranchPlaceholder')}
                spellCheck={false}
                disabled={detach}
              />
            </label>
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={detach}
                onChange={(event) => {
                  setDetach(event.target.checked)
                  // `git worktree add` refuses `--detach` together with `-b`.
                  if (event.target.checked) {
                    setNewBranch('')
                  }
                }}
              />
              {t('ops.worktree.detachedHead')}
            </label>
            <button
              type="button"
              className={p2.primary}
              disabled={busy || !path.trim() || !reference.trim()}
              onClick={() =>
                void run(t('ops.worktree.notice.created'), async () => {
                  await worktreeAdd({
                    repoId,
                    path: path.trim(),
                    reference: reference.trim(),
                    newBranch: detach ? undefined : newBranch.trim() || undefined,
                    detach,
                  })
                  setPath('')
                  setNewBranch('')
                })
              }
            >
              {t('common.create')}
            </button>
            <p className={p2.asideHint}>
              {t('ops.worktree.createHint')}
            </p>
          </section>
        </aside>
      </div>

      <Dialog
        open={lockTarget !== null}
        onClose={() => setLockTarget(null)}
        busy={busy}
        titleId="worktree-lock-title"
      >
        <h2 id="worktree-lock-title">{t('ops.worktree.lockTitle')}</h2>
        <p className={p2.mono}>{lockTarget?.path}</p>
        <label className={p2.field}>
          {t('ops.worktree.lockReasonLabel')}
          <input
            value={lockReason}
            onChange={(event) => setLockReason(event.target.value)}
            placeholder={t('ops.worktree.lockReasonPlaceholder')}
            autoFocus
          />
        </label>
        <div className={p2.dialogActions}>
          <span className={p2.spacer} />
          <button type="button" className={p2.ghost} onClick={() => setLockTarget(null)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || !lockTarget}
            onClick={() => {
              const target = lockTarget
              setLockTarget(null)
              if (!target) {
                return
              }
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
          </button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('ops.worktree.removeTitle')}
        consequence={t('ops.worktree.removeConsequence', { path: pendingRemove?.path ?? '' })}
        irreversible
        typed={pendingRemove?.dirty ? pendingRemove.path : undefined}
        confirmLabel={t('ops.worktree.remove')}
        busy={busy}
        children={
          pendingRemove?.branch ? (
            <label className={p2.checkbox}>
              <input
                type="checkbox"
                checked={removeBranch}
                onChange={(event) => setRemoveBranch(event.target.checked)}
              />
              {t('ops.worktree.removeBranch', { branch: pendingRemove.branch })}
            </label>
          ) : null
        }
        onCancel={() => setPendingRemove(null)}
        onConfirm={(typed) => {
          const target = pendingRemove
          const deleteBranch = removeBranch
          setPendingRemove(null)
          setRemoveBranch(false)
          if (!target) {
            return
          }
          void run(
            deleteBranch
              ? t('ops.worktree.notice.removedWithBranch')
              : t('ops.worktree.notice.removed'),
            () =>
              worktreeRemove({
                repoId,
                path: target.path,
                force: Boolean(target.dirty),
                deleteBranch,
                confirmation: {
                  acknowledged: true,
                  typed: target.dirty ? typed : undefined,
                },
              }),
          )
        }}
      />

      <ConfirmDialog
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
      />
    </div>
  )
}
