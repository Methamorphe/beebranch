import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  operationCancel,
  refsGet,
  statusGet,
  syncFetch,
  syncPull,
  syncPush,
} from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import type {
  OperationProgress,
  OperationStarted,
  PullStrategy,
  RefsSnapshot,
  StatusReport,
  SyncOutcome,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

export function SyncPanel({ repoId, generation, onMutated }: Props) {
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [refs, setRefs] = useState<RefsSnapshot | null>(null)
  const [remote, setRemote] = useState('origin')
  const [branch, setBranch] = useState('')
  const [branchDirty, setBranchDirty] = useState(false)
  const [remoteDirty, setRemoteDirty] = useState(false)
  const [strategy, setStrategy] = useState<PullStrategy>('auto')
  const [setUpstream, setSetUpstream] = useState(false)
  const [force, setForce] = useState(false)
  const [pendingForce, setPendingForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorOutput, setErrorOutput] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([statusGet(repoId), refsGet(repoId)])
      .then(([statusResult, refsResult]) => {
        if (cancelled) {
          return
        }
        setStatus(statusResult.data)
        setRefs(refsResult.data)
        const current = statusResult.data.branch.head
        if (current && !branchDirty) {
          setBranch(current)
        }
        const upstream = statusResult.data.branch.upstream
        if (upstream && !remoteDirty) {
          setRemote(upstream.split('/')[0] ?? 'origin')
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, generation, branchDirty, remoteDirty])

  useEffect(() => {
    let disposed = false
    const stops: Array<() => void> = []

    void listen<OperationStarted>('op://started', (event) => {
      if (!disposed) {
        setOperationId(event.payload.operationId)
      }
    }).then((stop) => (disposed ? stop() : stops.push(stop)))

    void listen<OperationProgress>('op://progress', (event) => {
      if (disposed) {
        return
      }
      const line = `[${event.payload.stream}] ${event.payload.line}`
      setLog((current) => [...current.slice(-299), line])
    }).then((stop) => (disposed ? stop() : stops.push(stop)))

    return () => {
      disposed = true
      stops.forEach((stop) => stop())
    }
  }, [])

  const run = async (kind: 'fetch' | 'pull' | 'push') => {
    setBusy(true)
    setError(null)
    setErrorOutput(null)
    setOutcome(null)
    setOperationId(null)
    setLog([])
    try {
      const result =
        kind === 'fetch'
          ? await syncFetch(repoId, remote)
          : kind === 'pull'
            ? await syncPull({ repoId, remote, branch, strategy })
            : await syncPush({
                repoId,
                remote,
                branch,
                setUpstream,
                force,
                confirmation: force
                  ? { acknowledged: true, typed: branch }
                  : undefined,
              })
      setOutcome(result.data)
      if (result.data.output) {
        setLog((current) => [...current, result.data.output])
      }
      setForce(false)
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
      setErrorOutput(errorDetail(cause))
    } finally {
      setBusy(false)
      setOperationId(null)
    }
  }

  return (
    <div className={shared.root}>
      <div className={shared.columns}>
        <section className={shared.card}>
          <h2>Remote et branche</h2>
          <div className={shared.row}>
            <label className={shared.field}>
              Remote
              <select
                value={remote}
                onChange={(event) => {
                  setRemote(event.target.value)
                  setRemoteDirty(true)
                }}
                aria-label="Remote"
              >
                {(refs?.remotes.length ? refs.remotes : ['origin']).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              Branche distante
              <input
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value)
                  setBranchDirty(true)
                }}
                placeholder="branche"
                aria-label="Branche"
              />
            </label>
          </div>
          <div className={shared.row}>
            <span className={shared.badge}>
              {status?.branch.upstream ?? 'sans upstream'}
            </span>
            <span className={shared.badge}>↑{status?.branch.ahead ?? 0}</span>
            <span className={shared.badge}>↓{status?.branch.behind ?? 0}</span>
          </div>

          <div className={shared.row}>
            <button
              type="button"
              className={shared.primary}
              disabled={busy || !remote}
              onClick={() => void run('fetch')}
            >
              Fetch
            </button>
            <select
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as PullStrategy)}
              aria-label="Stratégie de pull"
            >
              <option value="auto">pull.rebase (auto)</option>
              <option value="ffOnly">ff-only</option>
              <option value="rebase">rebase</option>
              <option value="merge">merge</option>
            </select>
            <button
              type="button"
              className={shared.primary}
              disabled={busy || !branch}
              onClick={() => void run('pull')}
            >
              Pull
            </button>
          </div>
          <div className={shared.row}>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={setUpstream}
                onChange={(event) => setSetUpstream(event.target.checked)}
              />
              Définir l'upstream
            </label>
            <label className={shared.checkbox}>
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => setForce(event.target.checked)}
              />
              Force-with-lease explicite
            </label>
            <button
              type="button"
              className={shared.primary}
              disabled={busy || !branch}
              onClick={() => (force ? setPendingForce(true) : void run('push'))}
            >
              Push
            </button>
          </div>
          <p className={shared.notice}>
            Annulation : arrêt gracieux puis forcé. Un push annulé peut avoir abouti ;
            l'état distant est revérifié et affiché. Aucun force push implicite.
          </p>
          {error ? (
            <div className={shared.danger} role="alert">
              <p>{error}</p>
              {errorOutput ? <pre className={shared.output}>{errorOutput}</pre> : null}
            </div>
          ) : null}
          {outcome ? (
            <p className={shared.success}>
              {outcome.kind} terminé{outcome.remoteSha ? ` · remote ${outcome.remoteSha.slice(0, 10)}` : ''}.
            </p>
          ) : null}
        </section>

        <section className={shared.card}>
          <h2>Progression</h2>
          <div className={shared.row}>
            <button
              type="button"
              className={shared.dangerButton}
              disabled={!busy || !operationId}
              onClick={() => {
                if (!operationId) {
                  return
                }
                void operationCancel(operationId)
                  .then((sent) =>
                    setLog((current) => [
                      ...current,
                      sent ? 'Annulation demandée.' : 'Opération déjà terminée.',
                    ]),
                  )
                  .catch((cause: unknown) => setError(errorMessage(cause)))
              }}
            >
              Annuler l'opération
            </button>
            {operationId ? <span className={shared.mono}>{operationId}</span> : null}
          </div>
          <pre className={shared.output}>{log.join('\n') || 'Aucune sortie.'}</pre>
        </section>
      </div>

      <ConfirmDialog
        open={pendingForce}
        title="Force push"
        consequence={`L'historique de ${remote}/${branch} sera réécrit. Les commits distants absents localement ne seront plus accessibles facilement. L'ancien SHA est enregistré dans le journal.`}
        irreversible
        typed={branch}
        confirmLabel="Force push"
        busy={busy}
        onCancel={() => setPendingForce(false)}
        onConfirm={(typed) => {
          if (typed !== branch) {
            return
          }
          setPendingForce(false)
          void run('push')
        }}
      />
    </div>
  )
}
