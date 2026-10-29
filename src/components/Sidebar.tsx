import { useState } from 'react'
import { navigationItems, type ViewId } from '../data/navigation'
import { useI18n, type MessageKey } from '../i18n'
import { ViewIcon } from './ViewIcon'
import styles from './Sidebar.module.css'

type Props = {
  active: ViewId
  repoName: string | null
  branch: string | null
  conflicts: number
  stashes: number
  mergeRequests: number
  gitlabConnected: boolean
  githubConnected: boolean
  version: string
  onSelect: (view: ViewId) => void
}

const sections: { id: string; labelKey: MessageKey; ids: ViewId[]; expandable?: boolean }[] = [
  { id: 'workspace', labelKey: 'nav.group.workspace', ids: ['graph', 'workspaces', 'stash', 'mrs', 'prs', 'search'] },
  { id: 'operations', labelKey: 'nav.group.operations', ids: ['rebase', 'fileHistory', 'worktrees', 'tags', 'remotes', 'submodules', 'patches', 'sync'], expandable: true },
  { id: 'system', labelKey: 'nav.group.system', ids: ['profiles', 'gitlab', 'github', 'tools', 'recovery'], expandable: true },
]

export function Sidebar(props: Props) {
  const { active, repoName, conflicts, stashes, gitlabConnected, githubConnected, onSelect } = props
  const { t } = useI18n()
  const forgeView: ViewId = gitlabConnected || !githubConnected ? 'gitlab' : 'github'
  const forgeLabel = gitlabConnected
    ? t('shell.sidebar.gitlabConnected')
    : githubConnected
      ? t('shell.sidebar.githubConnected')
      : t('shell.sidebar.connectGitlab')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const current = active === 'commit' || active === 'diff' ? 'graph' : active
  const item = (id: ViewId) => {
    const entry = navigationItems.find((value) => value.id === id)!
    const label = t(entry.labelKey)
    const count = id === 'stash' ? stashes : id === 'conflicts' ? conflicts : 0
    return <button key={id} type="button" data-view={id}
      className={current === id ? styles.itemActive : styles.item}
      disabled={entry.requiresRepo && !repoName}
      aria-current={current === id ? 'page' : undefined}
      title={entry.requiresRepo && !repoName ? t('shell.sidebar.openRepoToContinue') : label}
      onClick={() => onSelect(id)}>
      <span className={styles.icon} aria-hidden="true"><ViewIcon view={id} /></span>
      <span className={styles.label}>{label}</span>
      {count > 0 ? <span className={styles.count}>{count}</span> : null}
    </button>
  }
  return <aside className={styles.sidebar} aria-label={t('shell.sidebar.aria')}>
    <div className={styles.caption}>{t('shell.sidebar.caption')}</div>
    <div className={styles.repoTitle} title={repoName ?? undefined}>◇ <span>{repoName ?? t('shell.sidebar.welcome')}</span></div>
    <nav className={styles.nav}>
      {sections.map((section) => {
        const containsActive = section.ids.includes(current)
        const open = !section.expandable || (expanded[section.id] ?? containsActive)
        return <section key={section.id} className={styles.group}>
          {section.expandable ? <button type="button" className={styles.summary}
            aria-expanded={open} aria-controls={`nav-${section.id}`}
            onClick={() => setExpanded((value) => ({ ...value, [section.id]: !open }))}>
            {t(section.labelKey)}<span className={styles.chevron} data-open={open} aria-hidden="true">⌄</span>
          </button> : <div className={styles.summary}>{t(section.labelKey)}</div>}
          <div id={`nav-${section.id}`} hidden={!open} className={styles.items}>
            {section.ids.map(item)}
            {section.ids.includes('graph') && (conflicts > 0 || active === 'conflicts') ? item('conflicts') : null}
          </div>
        </section>
      })}
    </nav>
    <button type="button" className={styles.connection} onClick={() => onSelect(forgeView)}>
      <span
        className={styles.dot}
        data-connected={gitlabConnected || githubConnected}
        aria-hidden="true"
      />
      <span>
        {forgeLabel}
        <small>
          {gitlabConnected || githubConnected
            ? t('shell.sidebar.connectedHint')
            : t('shell.sidebar.disconnectedHint')}
        </small>
      </span>
      <span aria-hidden="true">↗</span>
    </button>
  </aside>
}
