import { useState } from 'react'
import { navigationItems, type ViewId } from '../data/navigation'
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

const sections: { label: string; ids: ViewId[]; expandable?: boolean }[] = [
  { label: 'Espace de travail', ids: ['graph', 'workspaces', 'stash', 'mrs', 'prs', 'search'] },
  { label: 'Outils avancés', ids: ['rebase', 'fileHistory', 'worktrees', 'tags', 'remotes', 'submodules', 'patches', 'sync'], expandable: true },
  { label: 'Préférences', ids: ['profiles', 'gitlab', 'github', 'tools', 'recovery'], expandable: true },
]

export function Sidebar(props: Props) {
  const { active, repoName, conflicts, stashes, gitlabConnected, githubConnected, onSelect } = props
  const forgeView: ViewId = gitlabConnected || !githubConnected ? 'gitlab' : 'github'
  const forgeLabel = gitlabConnected
    ? 'GitLab connecté'
    : githubConnected
      ? 'GitHub connecté'
      : 'Connecter GitLab'
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const current = active === 'commit' || active === 'diff' ? 'graph' : active
  const item = (id: ViewId) => {
    const entry = navigationItems.find((value) => value.id === id)!
    const count = id === 'stash' ? stashes : id === 'conflicts' ? conflicts : 0
    return <button key={id} type="button" data-view={id}
      className={current === id ? styles.itemActive : styles.item}
      disabled={entry.requiresRepo && !repoName}
      aria-current={current === id ? 'page' : undefined}
      title={entry.requiresRepo && !repoName ? 'Ouvrez un dépôt pour continuer' : entry.label}
      onClick={() => onSelect(id)}>
      <span className={styles.icon} aria-hidden="true"><ViewIcon view={id} /></span>
      <span className={styles.label}>{entry.label}</span>
      {count > 0 ? <span className={styles.count}>{count}</span> : null}
    </button>
  }
  return <aside className={styles.sidebar} aria-label="Navigation principale">
    <div className={styles.caption}>VOTRE DÉPÔT</div>
    <div className={styles.repoTitle} title={repoName ?? undefined}>◇ <span>{repoName ?? 'Bienvenue'}</span></div>
    <nav className={styles.nav}>
      {sections.map((section) => {
        const containsActive = section.ids.includes(current)
        const open = !section.expandable || (expanded[section.label] ?? containsActive)
        return <section key={section.label} className={styles.group}>
          {section.expandable ? <button type="button" className={styles.summary}
            aria-expanded={open} aria-controls={`nav-${section.label.replaceAll(" ", "-")}`}
            onClick={() => setExpanded((value) => ({ ...value, [section.label]: !open }))}>
            {section.label}<span className={styles.chevron} data-open={open} aria-hidden="true">⌄</span>
          </button> : <div className={styles.summary}>{section.label}</div>}
          <div id={`nav-${section.label.replaceAll(" ", "-")}`} hidden={!open} className={styles.items}>
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
            ? 'Revues, CI et dépôts'
            : 'Vos dépôts restent accessibles'}
        </small>
      </span>
      <span aria-hidden="true">↗</span>
    </button>
  </aside>
}
