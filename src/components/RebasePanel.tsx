import { useEffect, useState } from 'react'
import { formatNumber, useI18n, type MessageKey } from '../i18n'
import { rebaseCandidates, rebaseInteractive, refsGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type {
  CommitSummary,
  RebaseAction,
  RebaseStep,
  RefEntry,
  RepoState,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  state: RepoState
  onMutated: () => void
  onNavigateConflicts: () => void
}

const ACTIONS: { value: RebaseAction; labelKey: MessageKey }[] = [
  { value: 'pick', labelKey: 'ops.rebase.action.pick' },
  { value: 'reword', labelKey: 'ops.rebase.action.reword' },
  { value: 'squash', labelKey: 'ops.rebase.action.squash' },
  { value: 'fixup', labelKey: 'ops.rebase.action.fixup' },
  { value: 'edit', labelKey: 'ops.rebase.action.edit' },
  { value: 'drop', labelKey: 'ops.rebase.action.drop' },
]

function defaultUpstream(branches: RefEntry[], state: RepoState): string {
  const head = state.head
  if (head?.kind === 'branch' && head.upstream) {
    return head.upstream
  }
  const candidate = branches.find(
    (branch) => branch.kind === 'branch' && !branch.isHead && branch.name !== 'main',
  )
  return candidate?.name ?? branches.find((branch) => !branch.isHead)?.name ?? ''
}

export function RebasePanel({
  repoId,
  generation,
  state,
  onMutated,
  onNavigateConflicts,
}: Props) {
  const { t } = useI18n()
  const [branches, setBranches] = useState<RefEntry[]>([])
  const [upstream, setUpstream] = useState('')
  const [plan, setPlan] = useState<RebaseStep[]>([])
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void refsGet(repoId)
      .then((result) => {
        if (cancelled) {
          return
        }
        const items = result.data.entries.filter((entry) => entry.kind === 'branch')
        setBranches(items)
        setUpstream((current) => current || defaultUpstream(items, state))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [repoId, generation, state])

  const loadPlan = async () => {
    if (!upstream.trim()) {
      setError(t('ops.rebase.error.noBase'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await rebaseCandidates(repoId, upstream.trim())
      setCommits(result.candidates)
      setPlan(
        result.candidates.map((commit) => ({
          sha: commit.sha,
          action: 'pick',
        })),
      )
      if (result.candidates.length === 0) {
        setNotice(t('ops.rebase.notice.noCommits'))
      }
    } catch (cause) {
      setError(errorMessage(cause))
      setPlan([])
    } finally {
      setBusy(false)
    }
  }

  const update = (index: number, patch: Partial<RebaseStep>) => {
    setPlan((current) =>
      current.map((step, position) =>
        position === index ? { ...step, ...patch } : step,
      ),
    )
  }

  const move = (index: number, delta: number) => {
    setPlan((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) {
        return current
      }
      const next = [...current]
      const [item] = next.splice(index, 1)
      if (item) {
        next.splice(target, 0, item)
      }
      return next
    })
  }

  const reorder = (from: number, to: number) => {
    if (from === to) return
    setPlan((current) => {
      const next = [...current]
      const [item] = next.splice(from, 1)
      if (item) next.splice(to, 0, item)
      return next
    })
  }

  const start = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await rebaseInteractive({
        repoId,
        upstream: upstream.trim(),
        steps: plan,
      })
      onMutated()
      if (result.data.conflicted) {
        setNotice(t('ops.rebase.notice.paused'))
        onNavigateConflicts()
      } else {
        setNotice(t('ops.rebase.notice.done'))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const active = state.operation?.kind === 'rebase'
  const head =
    state.head?.kind === 'branch' ? state.head.name : t('ops.rebase.detachedHead')
  const summary = ACTIONS.map((action) => ({
    label: t(action.labelKey).toLowerCase(),
    count: plan.filter((step) => step.action === action.value).length,
  })).filter((entry) => entry.count > 0)

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <label className={`${p2.fieldInline} ${p2.grow}`}>
          <span className={p2.toolbarLabel}>{t('ops.rebase.baseLabel')}</span>
          <input
            value={upstream}
            onChange={(event) => setUpstream(event.target.value)}
            placeholder={t('ops.rebase.basePlaceholder')}
            aria-label={t('ops.rebase.baseLabel')}
            list="rebase-bases"
            spellCheck={false}
          />
        </label>
        <datalist id="rebase-bases">
          {branches.map((branch) => (
            <option key={branch.fullName} value={branch.name} />
          ))}
        </datalist>
        <button
          type="button"
          className={p2.secondary}
          disabled={busy}
          onClick={() => void loadPlan()}
        >
          {t('ops.rebase.loadPlan')}
        </button>
        <span className={p2.spacer} />
        <span className={p2.chip}>
          {head} → {upstream || t('ops.rebase.baseFallback')}
        </span>
      </div>

      <div className={p2.banner}>{t('ops.rebase.historyWarning')}</div>
      {active ? (
        <div className={`${p2.banner} ${p2.bannerInfo}`}>
          <span>{t('ops.rebase.inProgress')}</span>
          <button type="button" className={p2.ghost} onClick={onNavigateConflicts}>
            {t('ops.rebase.openConflicts')}
          </button>
        </div>
      ) : null}
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

      <div className={p2.screenBody}>
        <div className={p2.screenMain} data-fill={plan.length > 0 ? 'true' : undefined}>
          {plan.length > 0 ? (
            <>
              <div className={p2.listHeader}>
                <span className={p2.label}>{t('ops.rebase.reorderTitle')}</span>
                <span className={`${p2.count} ${p2.tabnum}`}>
                  {formatNumber(plan.length)}
                </span>
                <span className={p2.spacer} />
                <span className={p2.count}>{t('ops.rebase.dragHint')}</span>
              </div>
              <div className={p2.scroller}>
                <ol className={p2.planList}>
                  {plan.map((step, index) => {
                    const commit = commits.find((entry) => entry.sha === step.sha)
                    const rowState = dragIndex === index
                      ? p2.dragging
                      : overIndex === index && dragIndex !== index
                        ? p2.dropTarget
                        : ''
                    return (
                      <li
                        key={step.sha}
                        className={[p2.planRow, rowState].filter(Boolean).join(' ')}
                        draggable={!busy}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', String(index))
                          setDragIndex(index)
                        }}
                        onDragEnd={() => {
                          setDragIndex(null)
                          setOverIndex(null)
                        }}
                        onDragOver={(event) => {
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                          if (dragIndex !== null) setOverIndex(index)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          if (dragIndex !== null) reorder(dragIndex, index)
                          setDragIndex(null)
                          setOverIndex(null)
                        }}
                      >
                        <span className={p2.mono} aria-hidden="true" title={t('ops.rebase.dragHandle')}>
                          ⠿
                        </span>
                        <select
                          value={step.action}
                          aria-label={t('ops.rebase.commitActionAria', {
                            sha: step.sha.slice(0, 8),
                          })}
                          onChange={(event) =>
                            update(index, { action: event.target.value as RebaseAction })
                          }
                        >
                          {ACTIONS.map((action) => (
                            <option key={action.value} value={action.value}>
                              {t(action.labelKey)}
                            </option>
                          ))}
                        </select>
                        <span className={`${p2.mono} ${p2.count}`}>
                          {step.sha.slice(0, 8)}
                        </span>
                        {step.action === 'reword' ? (
                          <input
                            value={step.message ?? ''}
                            placeholder={t('ops.rebase.newMessagePlaceholder')}
                            aria-label={t('ops.rebase.rewordAria', {
                              sha: step.sha.slice(0, 8),
                            })}
                            onChange={(event) =>
                              update(index, { message: event.target.value })
                            }
                          />
                        ) : step.action === 'squash' ? (
                          <input
                            value={step.message ?? ''}
                            placeholder={t('ops.rebase.squashPlaceholder')}
                            aria-label={t('ops.rebase.squashAria', {
                              sha: step.sha.slice(0, 8),
                            })}
                            onChange={(event) =>
                              update(index, { message: event.target.value })
                            }
                          />
                        ) : (
                          <span className={p2.planMessage} title={commit?.subject}>
                            {commit?.subject ?? ''}
                          </span>
                        )}
                        <span className={p2.entryActions}>
                          <button
                            type="button"
                            className={p2.ghost}
                            aria-label={t('ops.rebase.moveUp')}
                            disabled={index === 0 || busy}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={p2.ghost}
                            aria-label={t('ops.rebase.moveDown')}
                            disabled={index === plan.length - 1 || busy}
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ol>
              </div>
              <div className={p2.footerBar}>
                <span className={p2.count}>
                  {summary
                    .map(
                      (entry) => `${formatNumber(entry.count)} ${entry.label}`,
                    )
                    .join(' · ')}
                </span>
                <span className={p2.spacer} />
                <button
                  type="button"
                  className={p2.ghost}
                  disabled={busy}
                  onClick={() => setPlan([])}
                >
                  {t('ops.rebase.resetPlan')}
                </button>
                <button
                  type="button"
                  className={p2.primary}
                  disabled={busy || plan.length === 0 || active}
                  onClick={() => setConfirmOpen(true)}
                >
                  {t('ops.rebase.start')}
                </button>
              </div>
            </>
          ) : (
            <div className={p2.empty}>
              <h2>{t('ops.rebase.reorderTitle')}</h2>
              <p>{t('ops.rebase.emptyBody')}</p>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('ops.rebase.confirmTitle')}
        consequence={t('ops.rebase.consequence', {
          count: formatNumber(plan.length),
          head,
          upstream,
        })}
        irreversible
        confirmLabel={t('ops.rebase.start')}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          void start()
        }}
      />
    </div>
  )
}
