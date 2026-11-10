import { useEffect, useState } from 'react'
import { githubStatus, gitlabStatus, preferenceGet, preferenceSet } from '../ipc/commands'
import { useI18n } from '../i18n'
import { ForgeLogo } from './ForgeLogo'
import { type ForgeHubTab } from './ForgeHubHeader'
import { GithubPanel } from './GithubPanel'
import { GitlabPanel } from './GitlabPanel'
import styles from './IntegrationsPanel.module.css'

type Provider = 'gitlab' | 'github'

type Props = {
  provider: Provider
  repoId?: string | null
  generation?: number
  onLinked?: () => void
  onProvider: (provider: Provider) => void
}

const PROVIDERS: Provider[] = ['gitlab', 'github']
const GROUP_KEY = 'ui.integrations.groupProjects'

/**
 * One screen for every forge. A provider tab sits above the reviews, projects
 * and connection tabs that already belong to that forge.
 */
export function IntegrationsPanel({ provider, repoId = null, generation = 0, onLinked, onProvider }: Props) {
  const { t } = useI18n()
  const [connected, setConnected] = useState<Record<Provider, boolean>>({ gitlab: false, github: false })
  const [section, setSection] = useState<ForgeHubTab>('projects')
  const [grouped, setGrouped] = useState(false)
  const [groupReady, setGroupReady] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<Provider, ReadonlySet<string>>>({
    gitlab: new Set(),
    github: new Set(),
  })
  const toggleGroup = (id: Provider, key: string) => {
    setCollapsed((current) => {
      const next = new Set(current[id])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...current, [id]: next }
    })
  }

  useEffect(() => {
    let cancelled = false
    void preferenceGet(GROUP_KEY)
      .then((value) => {
        if (cancelled) return
        setGrouped(value === 'true')
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setGroupReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!groupReady) return
    void preferenceSet(GROUP_KEY, grouped ? 'true' : 'false').catch(() => undefined)
  }, [grouped, groupReady])

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([gitlabStatus(), githubStatus()]).then(([gitlab, github]) => {
      if (cancelled) return
      setConnected({
        gitlab: gitlab.status === 'fulfilled' && gitlab.value.connected,
        github: github.status === 'fulfilled' && github.value.connected,
      })
    })
    return () => {
      cancelled = true
    }
  }, [provider, generation])

  return (
    <div className={styles.shell}>
      <div className={styles.providers} role="tablist" aria-label={t('forge.hub.integrations')}>
        {PROVIDERS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-forge-link={id}
            aria-selected={provider === id}
            onClick={() => onProvider(id)}
          >
            <ForgeLogo provider={id} />
            <span>{id === 'gitlab' ? 'GitLab' : 'GitHub'}</span>
            <i data-connected={connected[id]} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className={styles.body}>
        {provider === 'github' ? (
          <GithubPanel repoId={repoId} generation={generation} onLinked={onLinked} hubTab={section} onHubTab={setSection} grouped={grouped} onGrouped={setGrouped} collapsedGroups={collapsed.github} onToggleGroup={(key) => toggleGroup('github', key)} />
        ) : (
          <GitlabPanel repoId={repoId} generation={generation} onLinked={onLinked} hubTab={section} onHubTab={setSection} grouped={grouped} onGrouped={setGrouped} collapsedGroups={collapsed.gitlab} onToggleGroup={(key) => toggleGroup('gitlab', key)} />
        )}
      </div>
    </div>
  )
}
