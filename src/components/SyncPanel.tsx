import { useEffect, useRef, useState } from 'react'
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
import { useI18n, type MessageKey } from '../i18n'
import type {
  OperationProgress,
  OperationStarted,
  PullStrategy,
  RefsSnapshot,
  StatusReport,
  SyncOutcome,
} from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import p2 from './p2.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

const STRATEGIES: { value: PullStrategy; labelKey: MessageKey }[] = [
  { value: 'auto', labelKey: 'ops.sync.strategy.auto' },
  { value: 'ffOnly', labelKey: 'ops.sync.strategy.ffOnly' },
  { value: 'rebase', labelKey: 'ops.sync.strategy.rebase' },
  { value: 'merge', labelKey: 'ops.sync.strategy.merge' },
]

export function SyncPanel({ repoId, generation, onMutated }: Props) {
  const { t } = useI18n()
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
  const consoleRef = useRef<HTMLPreElement>(null)

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
      if (!disposed && event.payload.repoId === repoId) {
        setOperationId(event.payload.operationId)
      }
    }).then((stop) => (disposed ? stop() : stops.push(stop)))

    void listen<OperationProgress>('op://progress', (event) => {
      if (disposed || event.payload.repoId !== repoId) {
        return
      }
      const line = `[${event.payload.stream}] ${event.payload.line}`
      setLog((current) => [...current.slice(-299), line])
    }).then((stop) => (disposed ? stop() : stops.push(stop)))

    return () => {
      disposed = true
      stops.forEach((stop) => stop())
    }
  }, [repoId])

  useEffect(() => {
    const node = consoleRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [log])

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

  const ahead = status?.branch.ahead ?? 0
  const behind = status?.branch.behind ?? 0

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <span className={p2.toolbarLabel}>{t('ops.sync.remoteAndBranch')}</span>
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
        <input
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value)
            setBranchDirty(true)
          }}
          placeholder={t('ops.sync.branchPlaceholder')}
          aria-label={t('ops.sync.branchAria')}
          spellCheck={false}
        />
        <span className={p2.spacer} />
        <span className={`${p2.chip} ${status?.branch.upstream ? '' : p2.chipWarn}`}>
          {status?.branch.upstream ?? 'sans upstream'}
        </span>
        <span className={`${p2.chip} ${ahead > 0 ? p2.chipInfo : ''}`}>↑{ahead}</span>
        <span className={`${p2.chip} ${behind > 0 ? p2.chipInfo : ''}`}>↓{behind}</span>
      </div>

      {error ? (
        <>
          <p className={p2.alert} role="alert">
            {error}
          </p>
          {errorOutput ? <pre className={p2.code}>{errorOutput}</pre> : null}
        </>
      ) : null}
      {outcome ? (
        <div className={p2.listHeader} role="status">
          <span className={`${p2.chip} ${p2.chipGood}`}>{t('ops.sync.outcomeDone', { kind: outcome.kind })}</span>
          {outcome.remoteSha ? (
            <span className={`${p2.mono} ${p2.count}`}>
              {t('ops.sync.remoteSha', { sha: outcome.remoteSha.slice(0, 10) })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          <div className={p2.listHeader}>
            <span className={p2.label}>{t('ops.sync.title')}</span>
            <span className={p2.spacer} />
            <span className={p2.count}>{t('ops.sync.noImplicitForce')}</span>
          </div>

          <div className={p2.actionRow}>
            <div>
              <h3 className={p2.actionRowTitle}>Fetch</h3>
              <p className={p2.actionRowHint}>
                {t('ops.sync.fetchHint')}
              </p>
            </div>
            <div className={p2.actionRowControls}>
              <button
                type="button"
                className={p2.secondary}
                disabled={busy || !remote}
                onClick={() => void run('fetch')}
              >
                Fetch
              </button>
            </div>
          </div>

          <div className={p2.actionRow}>
            <div>
              <h3 className={p2.actionRowTitle}>Pull</h3>
              <p className={p2.actionRowHint}>
                {t('ops.sync.pullHint', { remote, branch: branch || '…' })}
              </p>
            </div>
            <div className={p2.actionRowControls}>
              <select
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as PullStrategy)}
                aria-label={t('ops.sync.strategyAria')}
              >
                {STRATEGIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={p2.primary}
                disabled={busy || !branch}
                onClick={() => void run('pull')}
              >
                Pull
              </button>
            </div>
          </div>

          <div className={p2.actionRow}>
            <div>
              <h3 className={p2.actionRowTitle}>Push</h3>
              <p className={p2.actionRowHint}>
                {t('ops.sync.pushHint', { branch: branch || t('ops.sync.currentBranch'), remote })}
              </p>
            </div>
            <div className={p2.actionRowControls}>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={setUpstream}
                  onChange={(event) => setSetUpstream(event.target.checked)}
                />
                {t('ops.sync.setUpstream')}
              </label>
              <label className={p2.checkbox}>
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                force-with-lease
              </label>
              <button
                type="button"
                className={p2.primary}
                disabled={busy || !branch}
                onClick={() => (force ? setPendingForce(true) : void run('push'))}
              >
                Push
              </button>
            </div>
          </div>

          <p className={p2.noteBlock}>
            Annulation : arrêt gracieux puis forcé. Un push annulé peut avoir
            abouti ; l’état distant est revérifié et affiché.
          </p>
        </div>

        <aside className={`${p2.screenAside} ${p2.screenAsideFlush}`} aria-label="Progression">
          <div className={p2.consoleHeader}>
            <span className={p2.label}>Progression</span>
            <span className={p2.dot} data-tone={busy ? 'info' : 'good'} />
            <span className={p2.meta}>{busy ? t('ops.sync.running') : t('ops.sync.idle')}</span>
            <span className={p2.spacer} />
            {operationId ? <span className={`${p2.count} ${p2.mono}`}>{operationId}</span> : null}
          </div>

          <pre className={p2.console} ref={consoleRef} aria-live="polite">
            {log.join('\n') || t('ops.sync.noOutput')}
          </pre>

          <div className={p2.footerBar}>
            <button
              type="button"
              className={p2.ghostDanger}
              disabled={!busy || !operationId}
              onClick={() => {
                if (!operationId) {
                  return
                }
                void operationCancel(operationId)
                  .then((sent) =>
                    setLog((current) => [
                      ...current,
                      sent ? t('ops.sync.cancelRequested') : t('ops.sync.alreadyFinished'),
                    ]),
                  )
                  .catch((cause: unknown) => setError(errorMessage(cause)))
              }}
            >
              {t('ops.sync.cancelOperation')}
            </button>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={pendingForce}
        title="Force push"
        consequence={t('ops.sync.forcePushConsequence', { remote, branch })}
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
