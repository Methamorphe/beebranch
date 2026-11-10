import { useEffect, useRef, useState } from 'react'
import type { ViewId } from '../data/navigation'
import type { RecentRepo } from '../types/git'
import { formatNumber, useI18n } from '../i18n'
import type { Favourite } from '../lib/favourites'
import { CloneForm } from './CloneForm'
import { ToolbarIcon } from './ToolbarIcon'
import { ViewIcon } from './ViewIcon'
import styles from './Home.module.css'

type Props = {
  onSelect: (view: ViewId) => void
  recent: RecentRepo[]
  /** Changes whenever a new-tab request must refocus the recent search. */
  focusRequest?: number
  onOpen: (path: string) => void
  onOpenDialog: () => void
  onClone: (input: {
    url: string
    destination: string
    branch?: string
    depth?: number
    recurseSubmodules?: boolean
  }) => Promise<void>
  onCreate?: () => void
  onPickDirectory?: (defaultPath?: string) => Promise<string | null>
  favourites: Favourite[]
  onOpenFavourite: (slot: number) => void
  onToggleFavourite: (entry: Favourite) => void
  onMoveFavourite: (path: string, direction: -1 | 1) => void
}

export function Home({
  onSelect,
  recent,
  focusRequest = 0,
  onOpen,
  onOpenDialog,
  onClone,
  onCreate,
  onPickDirectory,
  favourites,
  onOpenFavourite,
  onToggleFavourite,
  onMoveFavourite,
}: Props) {
  const { t, plural } = useI18n()
  const [mode, setMode] = useState<'idle' | 'clone'>('idle')
  const [recentQuery, setRecentQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const lastFocusRequest = useRef(focusRequest)
  // A new tab lands here ready to search: focus the recent-repos field, and
  // start from a clean query when the tab is opened again. The field only
  // exists once recents are loaded, so the effect must also run on that edge.
  const hasRecent = recent.length > 0
  useEffect(() => {
    if (focusRequest !== lastFocusRequest.current) {
      lastFocusRequest.current = focusRequest
      setRecentQuery('')
    }
    if (hasRecent) {
      searchInput.current?.focus()
    }
  }, [focusRequest, hasRecent])

  const recentFilter = recentQuery.trim().toLowerCase()
  const filteredRecent = recentFilter
    ? recent.filter((entry) => {
        const name = (entry.name ?? entry.path.split('/').pop() ?? '').toLowerCase()
        return (
          name.includes(recentFilter) || entry.path.toLowerCase().includes(recentFilter)
        )
      })
    : recent

  return (
    <div className={styles.root}>
      <section className={styles.start} aria-labelledby="start-title">
        <h1 id="start-title">{t('shell.topbar.openRepo')}</h1>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={onOpenDialog}>
            {t('shell.home.openLocalRepo')}
          </button>
          {onCreate ? (
            <button type="button" className={styles.secondary} onClick={onCreate}>
              {t('shell.home.createRepo')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setMode(mode === 'clone' ? 'idle' : 'clone')}
            aria-expanded={mode === 'clone'}
          >
            {t('shell.home.cloneRepo')}
          </button>
        </div>
        {mode === 'clone' ? (
          <div className={styles.cloneForm}>
            <CloneForm
              active
              suggestFrom={recent[0]?.path}
              idPrefix="clone"
              onClone={onClone}
              onPickDirectory={onPickDirectory}
              onOpenProvider={onSelect}
              onCancel={() => setMode('idle')}
            />
          </div>
        ) : null}
      </section>

      {favourites.length > 0 ? (
        <section
          className={styles.recent}
          aria-label={t('shell.favourites.title')}
        >
          <div className={styles.sectionHeading}>
            <h2>{t('shell.favourites.title')}</h2>
            <span>{t('shell.favourites.hint')}</span>
          </div>
          <div className={styles.list}>
            {favourites.map((favourite, slot) => (
              <div key={favourite.path} className={styles.favouriteRow}>
                <button
                  type="button"
                  className={styles.repo}
                  onClick={() => onOpenFavourite(slot)}
                  title={favourite.path}
                >
                  <span className={styles.repoIcon} aria-hidden="true">
                    <ToolbarIcon name="star" size={16} />
                  </span>
                  <span className={styles.repoText}>
                    <strong>{favourite.name}</strong>
                    <span>{favourite.path}</span>
                  </span>
                  <kbd>{`⌘⌥${slot + 1}`}</kbd>
                </button>
                <span className={styles.favouriteActions}>
                  <button
                    type="button"
                    aria-label={t('shell.favourites.moveUp', {
                      name: favourite.name,
                    })}
                    disabled={slot === 0}
                    onClick={() => onMoveFavourite(favourite.path, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t('shell.favourites.moveDown', {
                      name: favourite.name,
                    })}
                    disabled={slot === favourites.length - 1}
                    onClick={() => onMoveFavourite(favourite.path, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={t('shell.favourites.remove', {
                      name: favourite.name,
                    })}
                    onClick={() =>
                      onToggleFavourite({
                        path: favourite.path,
                        name: favourite.name,
                      })
                    }
                  >
                    <ToolbarIcon name="x" size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.recent} aria-label={t('shell.home.recentRepos')}>
        <div className={styles.sectionHeading}>
          <h2>{t('shell.home.resumeWork')}</h2>
          <span>
            {recent.length
              ? recentFilter
                ? plural('shell.home.filteredCount.one', 'shell.home.filteredCount.other', recent.length, {
                    count: formatNumber(filteredRecent.length),
                    total: formatNumber(recent.length),
                  })
                : plural('shell.home.recentCount.one', 'shell.home.recentCount.other', recent.length, {
                    count: formatNumber(recent.length),
                  })
              : t('shell.home.noRecents')}
          </span>
        </div>
        {recent.length ? (
          <input
            ref={searchInput}
            type="search"
            className={styles.recentSearch}
            value={recentQuery}
            onChange={(event) => setRecentQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && filteredRecent[0]) {
                event.preventDefault()
                onOpen(filteredRecent[0].path)
              }
            }}
            placeholder={t('shell.home.searchRecent')}
            aria-label={t('shell.home.searchRecentLabel')}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        {recent.length ? (
          <div className={styles.list}>
            {filteredRecent.map((entry) => {
              const name =
                entry.name ?? entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path
              const isFavourite = favourites.some(
                (favourite) => favourite.path === entry.path,
              )
              return (
                <div key={entry.repoId} className={styles.favouriteRow}>
                  <button
                    type="button"
                    className={styles.repo}
                    onClick={() => onOpen(entry.path)}
                    title={entry.path}
                  >
                    <span className={styles.repoIcon} aria-hidden="true">
                      <ViewIcon view="graph" size={18} />
                    </span>
                    <span className={styles.repoText}>
                      <strong>{name}</strong>
                      <span>{entry.path}</span>
                    </span>
                    <span className={styles.arrow} aria-hidden="true">
                      <ToolbarIcon name="arrowRight" size={14} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.star}
                    aria-pressed={isFavourite}
                    aria-label={t(
                      isFavourite
                        ? 'shell.favourites.removeAria'
                        : 'shell.favourites.addAria',
                      { name },
                    )}
                    onClick={() => onToggleFavourite({ path: entry.path, name })}
                  >
                    <ToolbarIcon name={isFavourite ? 'star' : 'starOff'} size={14} />
                  </button>
                </div>
              )
            })}
            {filteredRecent.length === 0 ? (
              <p className={styles.searchEmpty} role="status">
                {t('shell.home.noRecentMatch', { query: recentQuery.trim() })}
              </p>
            ) : null}
          </div>
        ) : (
          <div className={styles.empty}>
            {t('shell.home.emptyHint')}
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <span>
          <span className={styles.dot} />
          {t('shell.home.localCode')}
        </span>
        <span className={styles.row}>
          <button type="button" onClick={() => onSelect('gitlab')}>
            {t('shell.home.connectGitlab')}
          </button>
          <button type="button" onClick={() => onSelect('github')}>
            {t('shell.home.connectGithub')}
          </button>
        </span>
      </footer>
    </div>
  )
}
