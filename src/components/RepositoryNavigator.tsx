import { useState, type ReactNode } from 'react'
import type { ViewId } from '../data/navigation'
import { useI18n, type MessageKey } from '../i18n'
import { filterBranches } from '../lib/branchList'
import { buildBranchRows } from '../lib/branchTree'
import type { RefEntry, StashEntry } from '../types/git'
import { ToolbarIcon } from './ToolbarIcon'
import { ViewIcon } from './ViewIcon'
import styles from './RepositoryNavigator.module.css'

const treeKey = 'beebranch.branches.view'
/** Folders by default; only an explicit "list" choice turns them off. */
function readTreePreference() {
  try { return localStorage.getItem(treeKey) !== 'list' } catch { return true }
}

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
  /** Forge this repository is linked to, when one was matched. */
  linkProvider: 'gitlab' | 'github' | null
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
  const [folders, setFolders] = useState<Record<string, boolean>>({})
  const [tree, setTreeState] = useState(readTreePreference)
  const setTree = (value: boolean) => {
    setTreeState(value)
    try { localStorage.setItem(treeKey, value ? 'tree' : 'list') } catch { /* preference stays per session */ }
  }
  const groups = filterBranches(props.entries, query, props.current)
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase())
  const tags = props.entries.filter((entry) => entry.kind === 'tag' && matches(entry.name))
  // Review requests only appear for the forge of this repository; an unlinked
  // repository falls back to the connected forges. An open section stays.
  const showsForge = (provider: 'gitlab' | 'github', view: ViewId) =>
    props.active === view
    || props.linkProvider === provider
    || (props.linkProvider === null && (provider === 'gitlab' ? props.gitlabConnected : props.githubConnected))
  const stashes = props.stashes.filter((entry) => matches(entry.message) || matches(entry.selector))
  // An annotated tag stores a tag object; only the commit it peels to exists as
  // a row of the history, so selecting the tag object opens the detail without
  // ever focusing the graph.
  const refRow = (entry: RefEntry, label = entry.name, depth = 0) => <button type="button" key={entry.fullName}
    className={styles.row} data-ref={entry.fullName} data-current={entry.isHead}
    style={depth > 0 ? { paddingLeft: 24 + depth * 14 } : undefined}
    aria-current={props.selected === (entry.peeledOid ?? entry.targetOid) ? 'true' : undefined}
    title={entry.name} disabled={props.busy}
    onClick={() => props.onSelect(entry.peeledOid ?? entry.targetOid)}
    onDoubleClick={() => entry.kind !== 'tag' && props.onCheckout(entry)}
    onContextMenu={(event) => { event.preventDefault(); props.onRefMenu(entry, event.clientX, event.clientY) }}>
    <span className={styles.kind} aria-hidden="true"><ViewIcon view={entry.kind === 'tag' ? 'tags' : entry.kind === 'remoteBranch' ? 'remotes' : 'branch'} size={14} /></span>
    <span className={styles.name}>{label}</span>{entry.isHead ? <span aria-hidden="true"><ToolbarIcon name="check" size={12} /></span> : null}
  </button>
  // Branches as folders on "/", or the flat sorted list. While filtering,
  // every folder holding a match opens; a folder the user toggled keeps its state.
  const branchRows = (scope: 'local' | 'remotes', list: RefEntry[]) => {
    if (!tree) return list.map((entry) => refRow(entry))
    return buildBranchRows(list, scope, folders, query.trim() !== '').map((row) => row.kind === 'branch'
      ? refRow(row.entry, row.label, row.depth)
      : <button type="button" key={row.key} className={styles.folder} data-folder={row.key}
        style={{ paddingLeft: 12 + row.depth * 14 }} aria-expanded={row.open}
        onClick={() => setFolders((state) => ({ ...state, [row.key]: !row.open }))}>
        <span className={styles.chevron} data-open={row.open} aria-hidden="true">›</span>
        <span className={styles.name}>{row.name}</span>
        <span className={styles.count}>{row.count}</span>
      </button>)
  }
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
          <span className={styles.chevron} data-open={open} aria-hidden="true"><ToolbarIcon name="chevronRight" size={14} /></span>
          <span>{t(label)}</span>{count !== undefined ? <span className={styles.count}>{count}</span> : null}
        </button>
        {action ? <button type="button" className={styles.add} aria-label={`${t(label)} +`} onClick={action}><ToolbarIcon name="plus" size={14} /></button> : null}
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
    <div className={styles.filterRow}>
      <input type="search" className={styles.search} value={query} onChange={(event) => setQuery(event.target.value)}
        aria-label={t('workbench.repository.filter')} placeholder={t('workbench.repository.filter')} />
      <button type="button" className={styles.viewToggle} aria-pressed={tree}
        title={t(tree ? 'workbench.repository.viewList' : 'workbench.repository.viewTree')}
        aria-label={t(tree ? 'workbench.repository.viewList' : 'workbench.repository.viewTree')}
        onClick={() => setTree(!tree)}>{tree ? '☷' : '≣'}</button>
    </div>
    <div className={styles.sections}>
      {section('local', 'workbench.branches.local', branchRows('local', groups.local), groups.local.length, props.onCreateBranch)}
      {section('remotes', 'workbench.branches.remote', branchRows('remotes', groups.remote), groups.remote.length, () => { setManage('remotes'); setExpanded((state) => ({ ...state, remotes: true })) })}
      {section('tags', 'nav.tags', tags.map((entry) => refRow(entry)), tags.length, props.onCreateTag)}
      {section('stash', 'nav.stash', stashes.map((entry) => <button type="button" className={styles.row}
        data-stash={entry.selector} key={entry.selector} title={entry.message}
        aria-current={props.selected === entry.sha ? 'true' : undefined}
        onClick={() => props.onSelect(entry.sha)}
        onContextMenu={(event) => { event.preventDefault(); props.onStashMenu(entry, event.clientX, event.clientY) }}>
        <span className={styles.kind} aria-hidden="true"><ViewIcon view="stash" size={14} /></span><span className={styles.name}>{entry.message}</span>
      </button>), stashes.length, props.canStash ? props.onCreateStash : undefined)}
      {section('worktrees', 'nav.worktrees', null, undefined, undefined, 'worktrees')}
      {section('submodules', 'nav.submodules', null, undefined, undefined, 'submodules')}
      {showsForge('gitlab', 'mrs') ? section('mrs', 'nav.mrs', null, undefined, undefined, 'mrs') : null}
      {showsForge('github', 'prs') ? section('prs', 'nav.prs', null, undefined, undefined, 'prs') : null}
      {props.linkProvider !== null || props.gitlabConnected || props.githubConnected
        ? section('pipelines', 'nav.pipelines', null, undefined, undefined, 'pipelines')
        : null}
      {section('search', 'nav.search', null, undefined, undefined, 'search')}
      {props.active === 'patches' ? section('patches', 'nav.patches', null, undefined, undefined, 'patches') : null}
      {props.tools[props.active] && !['remotes', 'tags', 'worktrees', 'submodules', 'mrs', 'prs', 'patches', 'search'].includes(props.active)
        ? <div className={styles.inlineTool} data-repository-tool={props.active}>{props.tools[props.active]}</div> : null}
    </div>
  </aside>
}
