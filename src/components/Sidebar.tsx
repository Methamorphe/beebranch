import { useState } from 'react'
import { navigationGroups, type ViewId } from '../data/navigation'
import { useI18n } from '../i18n'
import { ToolbarIcon } from './ToolbarIcon'
import { ViewIcon } from './ViewIcon'
import styles from './Sidebar.module.css'

type Props = {
  active: ViewId
  /** The start screen is open: highlight Accueil, not the view underneath. */
  homeActive: boolean
  /** Icon rail. The same catalogue, without the labels. */
  compact: boolean
  repoName: string | null
  conflicts: number
  stashes: number
  gitlabConnected: boolean
  githubConnected: boolean
  /** Connected forge user, when one is known. */
  userName: string | null
  /** Tab last requested from the gear or the account mark. */
  settingsTab?: 'appearance' | 'profiles' | null
  onSelect: (view: ViewId) => void
  /** Opens the settings screen. */
  onSettings: () => void
  /** Opens the account on the profiles tab. */
  onAccount: () => void
  /** Opens the start screen without closing repository tabs. */
  onHome: () => void
  /** Repository-scoped entries open the picker instead of sitting disabled. */
  onOpenRepository: () => void
  /** Present while a repository is open, so the rail can grow back into the map. */
  onToggleCompact?: () => void
}

/** With a repository open, the rail keeps what the repository browser does not already show. */
const COMPACT_VIEWS = new Set<ViewId>(['graph', 'workspaces'])

export function Sidebar(props: Props) {
  const {
    active,
    homeActive,
    compact,
    repoName,
    conflicts,
    stashes,
    gitlabConnected,
    githubConnected,
    userName,
    settingsTab = null,
    onSelect,
    onHome,
    onOpenRepository,
    onSettings,
    onAccount,
    onToggleCompact,
  } = props
  const { t, plural } = useI18n()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const current = homeActive ? null : active === 'commit' || active === 'diff' || active === 'status' ? 'graph' : active
  const openRepo = t('shell.sidebar.openRepoAction')
  const connected = { gitlab: gitlabConnected, github: githubConnected }
  const accountName = userName ?? t('shell.topbar.localProfile')
  const accountMark = accountName.slice(0, 1).toUpperCase()

  return (
    <aside className={styles.sidebar} data-compact={compact ? 'true' : undefined} aria-label={t('shell.sidebar.aria')}>
      <div className={styles.repoTitle}>
        <ViewIcon view="graph" size={16} />
        <span title={repoName ?? undefined}>{repoName ?? t('shell.sidebar.welcome')}</span>
        {onToggleCompact ? (
          <button
            type="button"
            className={styles.pin}
            aria-pressed={!compact}
            aria-label={t(compact ? 'shell.sidebar.expand' : 'shell.sidebar.collapse')}
            title={t(compact ? 'shell.sidebar.expand' : 'shell.sidebar.collapse')}
            onClick={onToggleCompact}
          >
            <ToolbarIcon name={compact ? 'expand' : 'chevronLeft'} size={14} />
          </button>
        ) : null}
      </div>
      <nav className={styles.nav}>
        <button
          type="button"
          data-view="home"
          className={homeActive ? styles.itemActive : styles.item}
          aria-current={homeActive ? 'page' : undefined}
          title={t('shell.sidebar.home')}
          onClick={onHome}
        >
          <span className={styles.icon} aria-hidden="true"><ToolbarIcon name="actions" size={16} /></span>
          <span className={styles.label}>{t('shell.sidebar.home')}</span>
        </button>
        {navigationGroups.map((section) => {
          const items = section.items.filter((item) => item.catalog !== false && item.sidebar !== false && !item.connection && (!compact || COMPACT_VIEWS.has(item.id) || (item.id === 'conflicts' && (conflicts > 0 || current === 'conflicts'))))
          if (items.length === 0) return null
          const containsActive = current !== null && items.some((item) => item.id === current)
          const expandable = section.id !== 'workspace'
          const open = !expandable || (expanded[section.id] ?? containsActive)
          return (
            <section key={section.id} className={styles.group}>
              {expandable ? (
                <button
                  type="button"
                  className={styles.summary}
                  aria-expanded={open}
                  aria-controls={`nav-${section.id}`}
                  onClick={() => setExpanded((value) => ({ ...value, [section.id]: !open }))}
                >
                  {t(section.labelKey)}
                  <span className={styles.chevron} data-open={open} aria-hidden="true">
                    <ToolbarIcon name="chevron" size={14} />
                  </span>
                </button>
              ) : (
                <div className={styles.summary}>{t(section.labelKey)}</div>
              )}
              <div id={`nav-${section.id}`} hidden={!open} className={styles.items}>
                {items.map((entry) => {
                  const label = t(entry.labelKey)
                  const needsRepo = entry.requiresRepo && !repoName
                  const count = entry.id === 'stash' ? stashes : entry.id === 'conflicts' ? conflicts : 0
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      data-view={entry.id}
                      data-needs-repo={needsRepo ? 'true' : undefined}
                      className={current === entry.id ? styles.itemActive : styles.item}
                      aria-current={current === entry.id ? 'page' : undefined}
                      title={needsRepo ? `${label} — ${openRepo}` : label}
                      onClick={() => (needsRepo ? onOpenRepository() : onSelect(entry.id))}
                    >
                      <span className={styles.icon} aria-hidden="true"><ViewIcon view={entry.id} /></span>
                      <span className={styles.label}>
                        <span>{label}</span>
                        {needsRepo ? <small>{openRepo}</small> : null}
                      </span>
                      {count > 0 ? <span className={styles.count}>{count}</span> : null}
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </nav>
      <div className={styles.connections}>
        <button
          type="button"
          className={styles.connection}
          data-view="integrations"
          aria-pressed={current === 'integrations' || current === 'gitlab' || current === 'github'}
          title={t('shell.sidebar.integrations')}
          onClick={() => onSelect('integrations')}
        >
          <span className={styles.icon} aria-hidden="true"><ViewIcon view="integrations" size={16} /></span>
          <span className={styles.connectionText}>
            {t('nav.integrations')}
            <small>
              {connected.gitlab || connected.github
                ? plural('shell.sidebar.integrationsConnected.one', 'shell.sidebar.integrationsConnected.other', Number(connected.gitlab) + Number(connected.github), { count: Number(connected.gitlab) + Number(connected.github) })
                : t('shell.sidebar.disconnectedHint')}
            </small>
          </span>
        </button>
      </div>
      <div className={styles.accountBlock}>
        <button
          type="button"
          className={current === 'profiles' && settingsTab !== 'profiles' ? styles.itemActive : styles.item}
          data-view="profiles"
          aria-current={current === 'profiles' && settingsTab !== 'profiles' ? 'page' : undefined}
          title={t('shell.topbar.settings')}
          onClick={onSettings}
        >
          <span className={styles.icon} aria-hidden="true"><ToolbarIcon name="settings" size={16} /></span>
          <span className={styles.label}><span>{t('nav.profiles')}</span></span>
        </button>
        <button
          type="button"
          className={current === 'profiles' && settingsTab === 'profiles' ? `${styles.account} ${styles.accountActive}` : styles.account}
          aria-current={current === 'profiles' && settingsTab === 'profiles' ? 'page' : undefined}
          title={accountName}
          aria-label={t('shell.sidebar.account', { name: accountName })}
          onClick={onAccount}
        >
          <span className={styles.avatar} aria-hidden="true">{accountMark}</span>
          <span className={styles.accountName}>{accountName}</span>
        </button>
      </div>
    </aside>
  )
}
