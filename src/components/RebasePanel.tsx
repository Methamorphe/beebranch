import { useEffect, useState } from 'react'
import { rebaseCandidates, rebaseInteractive, refsGet } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import type {
  CommitSummary,
  RebaseAction,
  RebaseStep,
  RefEntry,
  RepoState,
} from '../types/git'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  state: RepoState
  onMutated: () => void
  onNavigateConflicts: () => void
}

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'edit', label: 'Edit' },
  { value: 'drop', label: 'Drop' },
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
  const [branches, setBranches] = useState<RefEntry[]>([])
  const [upstream, setUpstream] = useState('')
  const [plan, setPlan] = useState<RebaseStep[]>([])
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

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
      setError('Choisissez une base de rebase.')
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
        setNotice('Aucun commit à rebaser sur cette base.')
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
        setNotice('Rebase en pause sur un conflit.')
        onNavigateConflicts()
      } else {
        setNotice('Rebase terminé. Vérifiez l’historique.')
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const active = state.operation?.kind === 'rebase'

  return (
    <div className={p2.page}>
      <div className={p2.stack} style={{ flex: 1, maxWidth: 980 }}>
        <div className={p2.between}>
          <div>
            <h2 className={p2.cardTitle}>Réorganiser les commits</h2>
            <p className={p2.notice}>
              Glissez un commit pour changer son ordre (les flèches restent
              disponibles). Rien n'est exécuté avant « Démarrer le rebase ».
            </p>
          </div>
          <span className={p2.pill}>
            {state.head?.kind === 'branch' ? state.head.name : 'detached'} →{' '}
            {upstream || 'base'}
          </span>
        </div>

        <div className={p2.banner}>
          ⚠ Rebase réécrit l’historique local. Évitez de réécrire des commits
          déjà partagés.
        </div>
        {active ? (
          <div className={p2.banner}>
            Un rebase est en cours. Terminez-le depuis la vue Conflits.
          </div>
        ) : null}
        {error ? <p className={p2.errorText} role="alert">{error}</p> : null}
        {notice ? <p className={p2.notice}>{notice}</p> : null}

        <div className={p2.row}>
          <label className={p2.field} style={{ flex: 1 }}>
            Base du rebase
            <span className={p2.inlineField}>
              <select value={upstream} onChange={(event) => setUpstream(event.target.value)}>
                <option value={upstream}>{upstream || 'choisir une branche…'}</option>
                {branches.map((branch) => (
                  <option key={branch.fullName} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
              <input
                value={upstream}
                onChange={(event) => setUpstream(event.target.value)}
                placeholder="origin/main ou HEAD~5"
                aria-label="Révision de base"
                spellCheck={false}
              />
            </span>
          </label>
          <button type="button" className={p2.secondary} disabled={busy} onClick={() => void loadPlan()}>
            Charger le plan
          </button>
        </div>

        {plan.length > 0 ? (
          <div className={p2.planList}>
            {plan.map((step, index) => (
              <div
                key={step.sha}
                className={`${p2.planRow}${dragIndex === index ? ` ${p2.dragging}` : ''}${overIndex === index && dragIndex !== index ? ` ${p2.dropTarget}` : ''}`}
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
                aria-label={`${step.action} ${step.sha.slice(0, 8)}`}
              >
                <span className={p2.muted} aria-hidden="true">⠿</span>
                <select
                  value={step.action}
                  aria-label={`Action du commit ${step.sha.slice(0, 8)}`}
                  onChange={(event) => update(index, { action: event.target.value as RebaseAction })}
                >
                  {ACTIONS.map((action) => (
                    <option key={action.value} value={action.value}>
                      {action.label}
                    </option>
                  ))}
                </select>
                <span className={`${p2.mono} ${p2.muted}`}>{step.sha.slice(0, 8)}</span>
                {step.action === 'reword' ? (
                  <input
                    value={step.message ?? ''}
                    placeholder="Nouveau message"
                    aria-label={`Message de reword ${step.sha.slice(0, 8)}`}
                    onChange={(event) => update(index, { message: event.target.value })}
                  />
                ) : step.action === 'squash' ? (
                  <input
                    value={step.message ?? ''}
                    placeholder="Message ajouté au commit fusionné"
                    aria-label={`Message de squash ${step.sha.slice(0, 8)}`}
                    onChange={(event) => update(index, { message: event.target.value })}
                  />
                ) : (
                  <span className={p2.planMessage}>
                    {commits.find((commit) => commit.sha === step.sha)?.subject ?? ''}
                  </span>
                )}
                <span className={p2.row}>
                  <button
                    type="button"
                    className={p2.ghost}
                    aria-label="Monter"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={p2.ghost}
                    aria-label="Descendre"
                    disabled={index === plan.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className={p2.notice}>
            Chargez le plan pour afficher les commits de la plage.
          </p>
        )}

        <div className={p2.row}>
          <button
            type="button"
            className={p2.primary}
            disabled={busy || plan.length === 0 || active}
            onClick={() => void start()}
          >
            Démarrer le rebase
          </button>
          <button type="button" className={p2.ghost} onClick={() => setPlan([])}>
            Réinitialiser le plan
          </button>
        </div>
      </div>
    </div>
  )
}
