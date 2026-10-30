import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { filterBranches } from '../lib/branchList'
import type { RefEntry } from '../types/git'
import styles from './BranchListPanel.module.css'

type Props = {
  entries: RefEntry[]
  current: string | null
  busy: boolean
  onCheckout: (entry: RefEntry) => void
  onClose: () => void
}

/**
 * Branch navigation beside the graph: every local and remote branch is one
 * click away, without scrolling history to find its tip.
 */
export function BranchListPanel({ entries, current, busy, onCheckout, onClose }: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const groups = useMemo(
    () => filterBranches(entries, query, current),
    [entries, query, current],
  )
  const total = groups.local.length + groups.remote.length

  const row = (entry: RefEntry) => {
    const active = entry.kind === 'branch' && entry.name === current
    return (
      <li key={entry.fullName}>
        <button
          type="button"
          className={active ? styles.rowActive : styles.row}
          disabled={busy || active}
          aria-current={active ? 'true' : undefined}
          title={
            active
              ? undefined
              : entry.kind === 'remoteBranch'
                ? t('workbench.branches.remoteHint', { name: entry.name })
                : t('workbench.branches.checkoutHint', { name: entry.name })
          }
          onClick={() => onCheckout(entry)}
        >
          <span className={styles.name}>{entry.name}</span>
          {active ? (
            <span className={styles.current}>
              {t('workbench.branches.current')}
            </span>
          ) : null}
        </button>
      </li>
    )
  }

  const group = (key: 'local' | 'remote', list: RefEntry[]) =>
    list.length > 0 ? (
      <section className={styles.group} aria-label={t(`workbench.branches.${key}`)}>
        <h3 className={styles.groupTitle}>
          {t(`workbench.branches.${key}`)}
          <span className={styles.count}>{list.length}</span>
        </h3>
        <ul className={styles.list}>{list.map(row)}</ul>
      </section>
    ) : null

  return (
    <aside id="branch-list-panel" className={styles.panel} aria-label={t('workbench.branches.aria')}>
      <div className={styles.head}>
        <strong>{t('workbench.branches.title')}</strong>
        <span className={styles.count}>{total}</span>
        <button
          type="button"
          className={styles.close}
          aria-label={t('workbench.branches.close')}
          title={t('workbench.branches.close')}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <input
        className={styles.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('workbench.branches.searchPlaceholder')}
        aria-label={t('workbench.branches.searchAria')}
        spellCheck={false}
      />
      <div className={styles.scroll}>
        {total === 0 ? (
          <p className={styles.empty}>
            {entries.length === 0
              ? t('workbench.branches.empty')
              : t('workbench.branches.noMatch')}
          </p>
        ) : (
          <>
            {group('local', groups.local)}
            {group('remote', groups.remote)}
          </>
        )}
      </div>
    </aside>
  )
}
