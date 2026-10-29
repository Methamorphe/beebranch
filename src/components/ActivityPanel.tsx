import { useEffect, useMemo, useState } from 'react'
import {
  ACTIVITY_LIMIT,
  activityScope,
  activitySnapshot,
  clearActivity,
  subscribeActivity,
} from '../lib/activity'
import { useI18n } from '../i18n'
import p2 from './p2.module.css'

type Props = {
  repoId: string
}

type Tab = 'application' | 'repository'

const EXTENDED_KEY = 'ui.activityExtended'

/**
 * Activity log: application-wide actions and the actions of this repository.
 *
 * Entries come from the IPC boundary, so commands issued before this panel is
 * mounted are already listed. The log is in-memory and bounded.
 */
export function ActivityPanel({ repoId }: Props) {
  const { t, plural } = useI18n()
  const [revision, setRevision] = useState(0)
  const [tab, setTab] = useState<Tab>('repository')
  const [extended, setExtended] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => subscribeActivity(() => setRevision((current) => current + 1)), [])

  const entries = useMemo(() => {
    void revision
    const source = activitySnapshot(tab === 'repository' ? repoId : undefined)
    const needle = filter.trim().toLowerCase()
    if (!needle) {
      return source
    }
    return source.filter(
      (entry) =>
        entry.command.toLowerCase().includes(needle) ||
        (entry.code ?? '').toLowerCase().includes(needle),
    )
  }, [filter, repoId, revision, tab])

  return (
    <div className={p2.screen}>
      <div className={p2.toolbar}>
        <div className={p2.segmented} role="group" aria-label={t('ops.activity.scopeAria')}>
          <button
            type="button"
            className={tab === 'repository' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'repository'}
            onClick={() => setTab('repository')}
          >
            {t('ops.activity.tab.repository')}
          </button>
          <button
            type="button"
            className={tab === 'application' ? p2.segmentOn : p2.segment}
            aria-pressed={tab === 'application'}
            onClick={() => setTab('application')}
          >
            {t('ops.activity.tab.application')}
          </button>
        </div>
        <label className={p2.fieldInline}>
          <span className={p2.toolbarLabel}>{t('ops.activity.filterLabel')}</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('ops.activity.filterPlaceholder')}
            aria-label={t('ops.activity.filterAria')}
            spellCheck={false}
          />
        </label>
        <label className={p2.checkbox} title={t('ops.activity.extendedHint')}>
          <input
            type="checkbox"
            checked={extended}
            onChange={(event) => {
              setExtended(event.target.checked)
              try {
                window.localStorage.setItem(EXTENDED_KEY, event.target.checked ? 'true' : 'false')
              } catch {
                // Storage unavailable: the toggle stays session-only.
              }
            }}
          />
          {t('ops.activity.extended')}
        </label>
        <span className={p2.spacer} />
        <span className={`${p2.count} ${p2.tabnum}`}>
          {plural('ops.activity.count.one', 'ops.activity.count.other', entries.length, {
            count: String(entries.length),
          })}
        </span>
        <button type="button" className={p2.ghost} onClick={() => clearActivity()}>
          {t('ops.activity.clear')}
        </button>
      </div>

      <p className={p2.hintBar}>
        {t('ops.activity.hint', { limit: String(ACTIVITY_LIMIT) })}
      </p>

      <div className={p2.screenBody}>
        <div className={p2.screenMain}>
          {entries.length === 0 ? (
            <div className={p2.empty} role="status">
              <h2>{t('ops.activity.emptyTitle')}</h2>
              <p>{t('ops.activity.emptyBody')}</p>
            </div>
          ) : (
            <div className={p2.rows}>
              {entries.map((entry) => (
                <div key={entry.id} className={p2.entry}>
                  <span
                    className={p2.dot}
                    data-tone={entry.outcome === 'failed' ? 'bad' : 'good'}
                  />
                  <span className={`${p2.count} ${p2.tabnum}`}>
                    {new Date(entry.timestamp).toLocaleTimeString(undefined, {
                      hour12: false,
                    })}
                  </span>
                  <span className={`${p2.mono} ${p2.entryTitle}`}>{entry.command}</span>
                  <span className={p2.spacer} />
                  {extended && activityScope(entry) === 'repository' ? (
                    <span className={`${p2.meta} ${p2.mono}`}>{entry.repoId?.slice(0, 12)}</span>
                  ) : null}
                  <span className={`${p2.count} ${p2.tabnum}`}>
                    {t('ops.activity.duration', { ms: String(entry.durationMs) })}
                  </span>
                  {entry.outcome === 'failed' ? (
                    <span className={`${p2.chip} ${p2.chipBad}`}>{entry.code ?? 'error'}</span>
                  ) : (
                    <span className={`${p2.chip} ${p2.chipGood}`}>{t('ops.activity.ok')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
