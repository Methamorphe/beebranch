import { useState, type ReactNode } from 'react'
import type { ViewId } from '../data/navigation'
import { useI18n, type MessageKey } from '../i18n'
import { filterBranches } from '../lib/branchList'
import type { RefEntry, StashEntry } from '../types/git'
import styles from './RepositoryNavigator.module.css'

type Props = {
  name: string
  entries: RefEntry[]
  stashes: StashEntry[]
  current: string | null
  selected?: string
  active: ViewId
  tools: Partial<Record<ViewId, ReactNode>>
  busy: boolean
  gitlabConnected: boolean
  githubConnected: boolean
  onNavigate: (view: ViewId) => boolean
  onSelect: (sha: string) => void
  onCheckout: (entry: RefEntry) => void
  onRefMenu: (entry: RefEntry, x: number, y: number) => void
  onStashMenu: (entry: StashEntry, x: number, y: number) => void
  onCreateBranch: () => void
  onCreateTag: () => void
  onCreateStash: () => void
  canStash: boolean
}

/** Repository objects and their actions, never a list of destination pages. */
export function RepositoryNavigator(props: Props) {
  const { t } = useI18n()
  const [manage, setManage] = useState<ViewId | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ local: true })
  const groups = filterBranches(props.entries, query, props.current)
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase())
  const tags = props.entries.filter((entry) => entry.kind === 'tag' && matches(entry.name))
  const stashes = props.stashes.filter((entry) => matches(entry.message) || matches(entry.selector))
  // An annotated tag stores a tag object; only the commit it peels to exists as
  // a row of the history, so selecting the tag object opens the detail without
  // ever focusing the graph.
  const refRow = (entry: RefEntry) => <button type="button" key={entry.fullName}
    className={styles.row} data-ref={entry.fullName} data-current={entry.isHead}
    aria-current={props.selected === (entry.peeledOid ?? entry.targetOid) ? 'true' : undefined}
    title={entry.name} disabled={props.busy}
    onClick={() => props.onSelect(entry.peeledOid ?? entry.targetOid)}
    onDoubleClick={() => entry.kind !== 'tag' && props.onCheckout(entry)}
    onContextMenu={(event) => { event.preventDefault(); props.onRefMenu(entry, event.clientX, event.clientY) }}>
    <span aria-hidden="true">{entry.kind === 'tag' ? '◇' : entry.kind === 'remoteBranch' ? '☁' : '⑂'}</span>
    <span className={styles.name}>{entry.name}</span>{entry.isHead ? <span aria-hidden="true">✓</span> : null}
  </button>
  const section = (id: string, label: MessageKey, content: ReactNode, count?: number,
    action?: () => void, view?: ViewId) => {
    const active = props.active === (view ?? id)
    const open = active || expanded[id] || false
    return <section className={styles.section} key={id} data-repository-section={id}>
      <div className={styles.sectionHeading}>
        <button type="button" aria-expanded={Boolean(open)} aria-controls={`repository-${id}`}
          onClick={() => {
            if (active && open) props.onNavigate('graph')
            setExpanded((state) => ({ ...state, [id]: !open }))
          }}>
          <span className={styles.chevron} data-open={open} aria-hidden="true">›</span>
          <span>{t(label)}</span>{count !== undefined ? <span className={styles.count}>{count}</span> : null}
        </button>
        {action ? <button type="button" className={styles.add} aria-label={`${t(label)} +`} onClick={action}>+</button> : null}
      </div>
      <div id={`repository-${id}`} hidden={!open} className={styles.sectionBody}>
        {content}
        {open && (view || manage === id || active) && props.tools[(view ?? id) as ViewId]
          ? <div className={styles.inlineTool} data-repository-tool={view ?? id}>{props.tools[(view ?? id) as ViewId]}</div> : null}
      </div>
    </section>
  }
  return <aside className={styles.navigator} aria-label={t('workbench.repository.aria')}>
    <div className={styles.heading}><strong>{props.name}</strong></div>
    <input type="search" className={styles.search} value={query} onChange={(event) => setQuery(event.target.value)}
      aria-label={t('workbench.repository.filter')} placeholder={t('workbench.repository.filter')} />
    <div className={styles.sections}>
      {section('local', 'workbench.branches.local', groups.local.map(refRow), groups.local.length, props.onCreateBranch)}
      {section('remotes', 'workbench.branches.remote', groups.remote.map(refRow), groups.remote.length, () => { setManage('remotes'); setExpanded((state) => ({ ...state, remotes: true })) })}
      {section('tags', 'nav.tags', tags.map(refRow), tags.length, props.onCreateTag)}
      {section('stash', 'nav.stash', stashes.map((entry) => <button type="button" className={styles.row}
        data-stash={entry.selector} key={entry.selector} title={entry.message}
        aria-current={props.selected === entry.sha ? 'true' : undefined}
        onClick={() => props.onSelect(entry.sha)}
        onContextMenu={(event) => { event.preventDefault(); props.onStashMenu(entry, event.clientX, event.clientY) }}>
        <span aria-hidden="true">▱</span><span className={styles.name}>{entry.message}</span>
      </button>), stashes.length, props.canStash ? props.onCreateStash : undefined)}
      {section('worktrees', 'nav.worktrees', null, undefined, undefined, 'worktrees')}
      {section('submodules', 'nav.submodules', null, undefined, undefined, 'submodules')}
      {section('mrs', 'nav.mrs', null, undefined, undefined, 'mrs')}
      {section('prs', 'nav.prs', null, undefined, undefined, 'prs')}
      {section('patches', 'nav.patches', null, undefined, undefined, 'patches')}
      {section('search', 'nav.search', null, undefined, undefined, 'search')}
      {section('operations', 'nav.group.operations', <div className={styles.operations}>
        {(['rebase', 'conflicts', 'sync', 'fileHistory', 'activity', 'tools'] as const).map((view) =>
          <button type="button" key={view} onClick={() => props.onNavigate(view)}>{t(`nav.${view}`)}</button>)}
      </div>)}
      {props.tools[props.active] && !['remotes', 'tags', 'worktrees', 'submodules', 'mrs', 'prs', 'patches', 'search'].includes(props.active)
        ? <div className={styles.inlineTool} data-repository-tool={props.active}>{props.tools[props.active]}</div> : null}
    </div>
    <nav className={styles.forges} aria-label={t('forge.hub.integrations')}>
      {(['gitlab', 'github'] as const).map((provider) => <button type="button" key={provider}
        data-forge-link={provider} aria-pressed={props.active === provider}
        onClick={() => props.onNavigate(provider)}>
        <span className={styles.forgeMark} data-provider={provider} aria-hidden="true">{provider === 'gitlab' ? 'GL' : 'GH'}</span>
        <span>{provider === 'gitlab' ? 'GitLab' : 'GitHub'}</span>
        <span className={styles.forgeStatus} data-connected={provider === 'gitlab' ? props.gitlabConnected : props.githubConnected}
          aria-label={t((provider === 'gitlab' ? props.gitlabConnected : props.githubConnected) ? 'forge.connect.badge.connected' : 'forge.hub.disconnected')} />
      </button>)}
    </nav>
  </aside>
}
