import { useEffect, useState } from 'react'
import { branchCompare, syncFetch, syncPull, syncPush } from '../ipc/commands'
import { errorDetail, errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import type { PushRejection } from '../lib/pushRejection'
import type { PullStrategy } from '../types/git'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import styles from './p1.module.css'

type Props = {
  rejection: PushRejection | null
  onClose: () => void
  /** Called once a recovery succeeded, so the caller refreshes the graph. */
  onDone: () => void
}

type Divergence = { ahead: number; behind: number }

/** `undefined` while the comparison loads, `null` when it is unavailable. */
type Comparison = Divergence | null | undefined

type Recovery = { label: string; strategy: PullStrategy }

/**
 * Turns a refused push into a decision.
 *
 * Git only says "non-fast-forward"; the recovery fetches the remote first so
 * the counts below describe the real remote, then offers exactly the two
 * outcomes Git cannot choose: integrate the remote commits (pull then push) or
 * replace them (`--force-with-lease`, typed confirmation). The expected remote
 * SHA is read by the backend right before the push, never from the UI.
 */
export function PushRejectedDialog({ rejection, onClose, onDone }: Props) {
  const { t } = useI18n()
  const [comparison, setComparison] = useState<Comparison>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [forcing, setForcing] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!rejection) {
      return
    }
    let cancelled = false
    const { repoId, remote, branch } = rejection
    void (async () => {
      // A new rejection starts a new decision: drop the previous counts, the
      // typed force confirmation and any error left from that attempt.
      setComparison(undefined)
      setBusy(false)
      setFailure(null)
      setNote(null)
      setForcing(false)
      setTyped('')
      try {
        await syncFetch(repoId, remote)
      } catch (cause) {
        if (!cancelled) {
          setNote(t('ops.sync.recovery.fetchFailed', { message: errorMessage(cause) }))
        }
      }
      try {
        const result = await branchCompare(repoId, `${remote}/${branch}`, branch)
        if (!cancelled) {
          setComparison(result)
        }
      } catch {
        // No remote-tracking ref yet (never fetched under that name): the
        // counts are unknown, the actions stay available.
        if (!cancelled) {
          setComparison(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rejection, t])

  if (!rejection) {
    return null
  }

  const { repoId, remote, branch } = rejection

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setFailure(null)
    try {
      await action()
      onDone()
      onClose()
    } catch (cause) {
      const detail = errorDetail(cause)
      setFailure(detail ? `${errorMessage(cause)}\n${detail}` : errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const pullThenPush = (strategy: PullStrategy) => async () => {
    await syncPull({ repoId, remote, branch, strategy })
    await syncPush({ repoId, remote, branch })
  }

  const recoveries: Recovery[] = []
  if (comparison === null) {
    recoveries.push({ label: t('ops.sync.recovery.pullAuto'), strategy: 'auto' })
  } else if (comparison && comparison.behind > 0 && comparison.ahead === 0) {
    recoveries.push({ label: t('ops.sync.recovery.pullFastForward'), strategy: 'ffOnly' })
  } else if (comparison && comparison.behind > 0) {
    recoveries.push({ label: t('ops.sync.recovery.pullRebase'), strategy: 'rebase' })
    recoveries.push({ label: t('ops.sync.recovery.pullMerge'), strategy: 'merge' })
  }
  // After the fresh fetch nothing is missing remotely: a plain retry works.
  const retry = comparison != null && comparison.behind === 0

  const describe = () => {
    if (comparison === undefined) {
      return <p className={styles.notice}>{t('ops.sync.recovery.loading')}</p>
    }
    if (comparison === null) {
      return <p className={styles.notice}>{t('ops.sync.recovery.unavailable')}</p>
    }
    if (comparison.behind === 0) {
      return <p className={styles.notice}>{t('ops.sync.recovery.aheadOnly', { ahead: comparison.ahead })}</p>
    }
    if (comparison.ahead === 0) {
      return (
        <p className={styles.warning}>
          {t('ops.sync.recovery.behindOnly', { behind: comparison.behind, remote, branch })}
        </p>
      )
    }
    return (
      <p className={styles.warning}>
        {t('ops.sync.recovery.diverged', {
          ahead: comparison.ahead,
          behind: comparison.behind,
        })}
      </p>
    )
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="push-rejected-title" kind="alertdialog">
      <h2 id="push-rejected-title">{t('ops.sync.recovery.title')}</h2>
      <p>{t('ops.sync.recovery.lead', { branch, remote })}</p>
      {describe()}
      {note ? <p className={styles.notice}>{note}</p> : null}
      {forcing ? (
        <>
          <p className={styles.danger}>
            {t('ops.sync.recovery.forceWarning', { remote, branch })}
          </p>
          <label className={styles.field}>
            {t('shell.confirm.typeBefore')} <code>{branch}</code>{' '}
            {t('shell.confirm.typeAfter')}
            <input
              value={typed}
              data-autofocus
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={t('shell.confirm.typeAria', { value: branch })}
            />
          </label>
        </>
      ) : null}
      {failure ? <pre className={styles.output}>{failure}</pre> : null}
      <div className={styles.dialogActions}>
        {forcing ? (
          <>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setForcing(false)
                setTyped('')
              }}
            >
              {t('ops.sync.recovery.back')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy || typed !== branch}
              onClick={() =>
                void run(() =>
                  syncPush({
                    repoId,
                    remote,
                    branch,
                    force: true,
                    confirmation: { acknowledged: true, typed },
                  }),
                )
              }
            >
              {t('ops.sync.recovery.confirmForce')}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => setForcing(true)}
            >
              {t('ops.sync.recovery.forcePush')}
            </Button>
            {recoveries.map((entry, index) => (
              <Button
                key={entry.strategy}
                type="button"
                variant={index === 0 && !retry ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => void run(pullThenPush(entry.strategy))}
              >
                {entry.label}
              </Button>
            ))}
            {retry ? (
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                onClick={() => void run(() => syncPush({ repoId, remote, branch }))}
              >
                {t('ops.sync.recovery.retry')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
