import { useEffect, useState } from 'react'
import {
  stashApply,
  stashCreate,
  stashDrop,
  stashList,
  stashPop,
} from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { formatDateTime, dateFromSeconds, useI18n } from '../i18n'
import type { StashEntry } from '../types/git'
import { ConfirmDialog } from './ConfirmDialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  generation: number
  onMutated: () => void
}

/** Conflict paths reported by a stash apply/pop, narrowed without casting. */
function stashConflicts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('conflicts' in value)) {
    return []
  }
  const raw = value.conflicts
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : []
}

export function StashPanel({ repoId, generation, onMutated }: Props) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<StashEntry[]>([])
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingDrop, setPendingDrop] = useState<StashEntry | null>(null)

  const load = async () => {
    try {
      setEntries(await stashList(repoId))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, generation])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      const data =
        result && typeof result === 'object' && 'data' in result ? result.data : undefined
      const conflicts = stashConflicts(data)
      if (conflicts.length > 0) {
        // Git keeps the stash when `pop` cannot apply it cleanly: say so
        // instead of reporting a plain success.
        setNotice(
          t('commit.stash.conflictsNotice', {
            count: conflicts.length,
            files: conflicts.join(', '),
          }),
        )
      } else {
        setNotice(label)
        if (typeof data === 'string' && data.length > 0) {
          setNotice(`${label} ${data}`)
        }
      }
      await load()
      onMutated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={shared.root}>
      <section className={shared.card}>
        <h2>{t('commit.stash.title')}</h2>
        <div className={shared.row}>
          <label className={shared.field}>
            {t('commit.stash.messageLabel')}
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('commit.stash.messagePlaceholder')}
              aria-label={t('commit.stash.messageAria')}
            />
          </label>
          <label className={shared.checkbox}>
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            {t('commit.stash.includeUntracked')}
          </label>
          <button
            type="button"
            className={shared.primary}
            disabled={busy}
            onClick={() =>
              void run(t('commit.stash.createdNotice'), () =>
                stashCreate({
                  repoId,
                  message: message.trim() || undefined,
                  includeUntracked,
                }),
              )
            }
          >
            {t('commit.stash.create')}
          </button>
        </div>
        <p className={shared.notice}>
          {t('commit.stash.notice')}
        </p>
        {error ? (
          <p className={shared.danger} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className={shared.notice}>{notice}</p> : null}
      </section>

      <section className={shared.card}>
        <h2>{t('commit.stash.listTitle', { count: entries.length })}</h2>
        <div className={shared.list}>
          {entries.length === 0 ? (
            <div className={shared.empty}><strong>{t('commit.stash.emptyTitle')}</strong><p>{t('commit.stash.emptyHint')}</p></div>
          ) : null}
          {entries.map((entry) => (
            <div key={entry.selector} className={shared.item}>
              <div>
                <span>{entry.selector} · {entry.message}</span>
                <span className={shared.mono}>
                  {entry.sha.slice(0, 12)} ·{' '}
                  {formatDateTime(dateFromSeconds(entry.timestamp))}
                </span>
              </div>
              <div className={shared.row} style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() =>
                    void run(t('commit.stash.appliedNotice', { selector: entry.selector }), () =>
                      stashApply(repoId, entry.selector),
                    )
                  }
                >
                  {t('common.apply')}
                </button>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() =>
                    void run(t('commit.stash.poppedNotice', { selector: entry.selector }), () =>
                      stashPop(repoId, entry.selector),
                    )
                  }
                >
                  {t('commit.stash.applyAndDrop')}
                </button>
                <button
                  type="button"
                  className={shared.small}
                  disabled={busy}
                  onClick={() => setPendingDrop(entry)}
                >
                  {t('commit.stash.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={pendingDrop !== null}
        title={t('commit.stash.deleteTitle', { selector: pendingDrop?.selector ?? '' })}
        consequence={t('commit.stash.deleteConsequence', {
          selector: pendingDrop?.selector ?? '',
          sha: pendingDrop?.sha.slice(0, 12) ?? '',
        })}
        irreversible
        confirmLabel={t('common.delete')}
        busy={busy}
        onCancel={() => setPendingDrop(null)}
        onConfirm={() => {
          const target = pendingDrop
          setPendingDrop(null)
          if (target) {
            void run(t('commit.stash.droppedNotice', { sha: target.sha.slice(0, 12) }), () =>
              stashDrop(repoId, target.selector, { acknowledged: true }),
            )
          }
        }}
      />
    </div>
  )
}
