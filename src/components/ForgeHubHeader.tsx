import { useI18n } from '../i18n'
import type { GitlabSession } from '../types/git'
import styles from './GitlabPanel.module.css'

export type ForgeHubTab = 'reviews' | 'projects' | 'connection'

type Props = {
  provider: 'gitlab' | 'github'
  session: GitlabSession | null
  active: ForgeHubTab
  count: number
  onSelect: (tab: ForgeHubTab) => void
}

export function ForgeHubHeader({ provider, session, active, count, onSelect }: Props) {
  const { t } = useI18n()
  const label = provider === 'gitlab' ? 'GitLab' : 'GitHub'
  return <>
    <header className={styles.hubHeader}>
      <span className={styles.brandMark} data-provider={provider} aria-hidden="true">{provider === 'gitlab' ? 'GL' : 'GH'}</span>
      <div className={styles.hubHeading}>
        <span>{t('forge.hub.integrations')}</span>
        <h2>{label}</h2>
        <p>{t(provider === 'gitlab' ? 'forge.hub.gitlab.subtitle' : 'forge.hub.github.subtitle')}</p>
      </div>
      <div className={styles.account}>
        {session?.connected ? <>
          <span className={styles.avatar} aria-hidden="true">{(session.user?.name ?? label).slice(0, 1).toUpperCase()}</span>
          <div><strong>{session.user?.name ?? label}</strong><span>{session.user ? `@${session.user.username}` : session.instance?.baseUrl}</span></div>
        </> : null}
        <span className={styles.connectionState} data-connected={session?.connected ?? false}>
          <i aria-hidden="true" />{t(session === null ? 'common.loading' : session.connected ? 'forge.connect.badge.connected' : 'forge.hub.disconnected')}
        </span>
      </div>
    </header>
    <div className={styles.hubTabs} role="tablist" aria-label={label}>
      {(['reviews', 'projects', 'connection'] as const).map((tab) => <button key={tab} type="button"
        role="tab" id={`${provider}-tab-${tab}`} aria-controls={`${provider}-panel-${tab}`}
        aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
        disabled={tab !== 'connection' && !session?.connected}
        onClick={() => onSelect(tab)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const index = tabs.indexOf(event.currentTarget)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          tabs[next]?.click(); tabs[next]?.focus()
        }}>
        {tab === 'reviews' ? t(provider === 'gitlab' ? 'forge.gitlab.title' : 'forge.github.title') : t(tab === 'projects' ? 'forge.hub.projects' : 'forge.hub.connection')}
        {tab === 'projects' && session?.connected ? <span>{count}</span> : null}
      </button>)}
    </div>
  </>
}
