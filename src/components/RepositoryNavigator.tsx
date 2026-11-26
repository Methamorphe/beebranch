import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { EXPLORER_CENTER_VIEWS, type ViewId } from '../data/navigation'
import { useI18n, type MessageKey } from '../i18n'
import { filterBranches } from '../lib/branchList'
import { buildBranchRows } from '../lib/branchTree'
import type { RefEntry, StashEntry } from '../types/git'
import { ToolbarIcon } from './ToolbarIcon'
import { ViewIcon, type ViewIconName } from './ViewIcon'
import styles from './RepositoryNavigator.module.css'

const treeKey = 'beebranch.branches.view'
const collapsedKey = 'beebranch.navigator.collapsed'
/** Folders by default; only an explicit "list" choice turns them off. */
function readTreePreference() {
  try { return localStorage.getItem(treeKey) !== 'list' } catch { return true }
}
function readCollapsedPreference() {
  try { return localStorage.getItem(collapsedKey) === '1' } catch { return false }
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
  linkProvider: 'gitlab' | 'github' | 'azure' | null
  onNavigate: (view: ViewId) => boolean
  onSelect: (sha: string) => void
  onCheckout: (entry: RefEntry) => void
  onRefMenu: (entry: RefEntry, x: number, y: number) => void
  onStashMenu: (entry: StashEntry, x: number, y: number) => void
  onCreateBranch: () => void
  onCreateTag: () => void
  onCreateStash: () => void
  onCreateRemote: () => void
  onCreateWorktree: () => void
  onCreateSubmodule: () => void
  onRemoteMenu: (name: string, x: number, y: number) => void
  /** Remote names from Git, including remotes that currently have no branches. */
  remoteNames: string[]
  canStash: boolean
}

function RailFlyout({
  icon,
  label,
  count,
  action,
  sectionId,
  children,
}: {
  icon: ViewIconName
  label: string
  count?: number
  action?: () => void
  sectionId: string
  children: ReactNode
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const position = () => {
    if (!trigger.current || !panel.current) return
    const rect = trigger.current.getBoundingClientRect()
    const element = panel.current
    const left = rect.right + 8 + element.offsetWidth > window.innerWidth - 8
      ? Math.max(8, rect.left - element.offsetWidth - 8)
      : rect.right + 8
    element.style.left = `${left}px`
    element.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - element.offsetHeight - 8))}px`
  }
  useEffect(() => {
    const element = panel.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.matches(':popover-open')) position()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!open) return
    const onMove = () => position()
    window.addEventListener('resize', onMove)
    return () => window.removeEventListener('resize', onMove)
  }, [open])
  return <div className={styles.railItem}>
    <button ref={trigger} type="button" className={styles.railButton} popoverTarget={id}
      aria-expanded={open} aria-controls={id} aria-label={label} title={label} data-rail-item={sectionId}>
      <ViewIcon view={icon} size={16} />
      {count !== undefined ? <span>{count}</span> : null}
    </button>
    <div ref={panel} id={id} popover="auto" className={styles.flyout} data-repository-section={sectionId}
      aria-label={label}
      onToggle={(event) => {
        const next = event.newState === 'open'
        setOpen(next)
        if (!next || !trigger.current) return
        position()
        window.requestAnimationFrame(position)
      }}>
      <div className={styles.flyoutHead}>
        <ViewIcon view={icon} size={14} />
        <strong>{label}</strong>
        {count !== undefined ? <span className={styles.count}>{count}</span> : null}
        {action ? <button type="button" className={styles.add} data-add="" aria-label={`${label} +`} onClick={action}><ToolbarIcon name="plus" size={14} /></button> : null}
      </div>
      <div className={styles.flyoutBody}>{children}</div>
    </div>
  </div>
}

function RailLink({
  icon,
  label,
  count,
  onClick,
  id,
  current,
}: {
  icon: ViewIconName
  label: string
  count?: number
  onClick: () => void
  id: string
  current?: boolean
}) {
  return <button type="button" className={styles.railButton} title={label} aria-label={label}
    data-rail-item={id} data-repository-section={id} aria-current={current ? 'page' : undefined} onClick={onClick}>
    <ViewIcon view={icon} size={16} />
    {count !== undefined ? <span>{count}</span> : null}
  </button>
}

/** Repository objects and their actions, never a list of destination pages. */
export function RepositoryNavigator(props: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ local: true })
  const [folders, setFolders] = useState<Record<string, boolean>>({})
  const [tree, setTreeState] = useState(readTreePreference)
  const [collapsedPref, setCollapsedPref] = useState(readCollapsedPreference)
  const [centerExpanded, setCenterExpanded] = useState(false)
  const onCenterScreen = EXPLORER_CENTER_VIEWS.includes(props.active)
  const collapsed = onCenterScreen ? !centerExpanded : collapsedPref
  const setTree = (value: boolean) => {
    setTreeState(value)
    try { localStorage.setItem(treeKey, value ? 'tree' : 'list') } catch { /* preference stays per session */ }
  }
  const setCollapsed = (value: boolean) => {
    setCollapsedPref(value)
    if (value) setQuery('')
    try { localStorage.setItem(collapsedKey, value ? '1' : '0') } catch { /* preference stays per session */ }
  }
  useEffect(() => {
    setCenterExpanded(false)
  }, [props.active])
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
  const showPipelines = props.linkProvider !== null || props.gitlabConnected || props.githubConnected
  const showMrs = showsForge('gitlab', 'mrs')
  const showPrs = showsForge('github', 'prs')
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
  const remoteMenu = (name: string, event: { preventDefault: () => void; clientX: number; clientY: number }) => {
    event.preventDefault()
    props.onRemoteMenu(name, event.clientX, event.clientY)
  }
  const remoteIdentity = (name: string) => (
    <button
      type="button"
      key={`remote:${name}`}
      className={styles.folder}
      data-remote={name}
      aria-haspopup="menu"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        props.onRemoteMenu(name, rect.right, rect.top)
      }}
      onContextMenu={(event) => remoteMenu(name, event)}
    >
      <span className={styles.kind} aria-hidden="true"><ViewIcon view="remotes" size={14} /></span>
      <span className={styles.name}>{name}</span>
    </button>
  )
  const remotesWithBranches = new Set(
    props.entries
      .filter((entry) => entry.kind === 'remoteBranch')
      .map((entry) => entry.name.split('/')[0] ?? '')
      .filter((name) => name.length > 0),
  )
  const listedRemotes = new Set(
    groups.remote
      .map((entry) => entry.name.split('/')[0] ?? '')
      .filter((name) => name.length > 0),
  )
  const emptyRemotes = props.remoteNames.filter(
    (name) => !remotesWithBranches.has(name) && matches(name),
  )
  const listRemoteNames = [...new Set([...props.remoteNames.filter((name) => matches(name)), ...listedRemotes])]
  const branchRows = (scope: 'local' | 'remotes', list: RefEntry[]) => {
    if (!tree) {
      return scope === 'remotes'
        ? [...listRemoteNames.map((name) => remoteIdentity(name)), ...list.map((entry) => refRow(entry))]
        : list.map((entry) => refRow(entry))
    }
    return [
      ...buildBranchRows(list, scope, folders, query.trim() !== '').map((row) => row.kind === 'branch'
        ? refRow(row.entry, row.label, row.depth)
        : <button type="button" key={row.key} className={styles.folder} data-folder={row.key}
          data-remote={scope === 'remotes' && row.depth === 0 ? row.name : undefined}
          style={{ paddingLeft: 12 + row.depth * 14 }} aria-expanded={row.open}
          onClick={() => setFolders((state) => ({ ...state, [row.key]: !row.open }))}
          aria-haspopup={scope === 'remotes' && row.depth === 0 ? 'menu' : undefined}
          onContextMenu={scope === 'remotes' && row.depth === 0
            ? (event) => remoteMenu(row.name, event)
            : undefined}>
          <span className={styles.chevron} data-open={row.open} aria-hidden="true">›</span>
          <span className={styles.name}>{row.name}</span>
          <span className={styles.count}>{row.count}</span>
        </button>),
      ...(scope === 'remotes' ? emptyRemotes.map((name) => remoteIdentity(name)) : []),
    ]
  }
  const stashRows = () => stashes.map((entry) => <button type="button" className={styles.row}
    data-stash={entry.selector} key={entry.selector} title={entry.message}
    aria-current={props.selected === entry.sha ? 'true' : undefined}
    onClick={() => props.onSelect(entry.sha)}
    onContextMenu={(event) => { event.preventDefault(); props.onStashMenu(entry, event.clientX, event.clientY) }}>
    <span className={styles.kind} aria-hidden="true"><ViewIcon view="stash" size={14} /></span><span className={styles.name}>{entry.message}</span>
  </button>)
  const openTool = (view: ViewId) => { props.onNavigate(view) }
  const pageLink = (id: ViewId, label: MessageKey, action?: () => void) => {
    const active = props.active === id
    return <div className={styles.pageRow} key={id}>
      <button type="button" className={styles.page} data-repository-section={id}
        aria-current={active ? 'page' : undefined}
        onClick={() => props.onNavigate(active ? 'graph' : id)}>
        <ViewIcon view={id} size={14} />
        <span className={styles.name}>{t(label)}</span>
      </button>
      {action ? <button type="button" className={styles.add} data-add="" aria-label={`${t(label)} +`} onClick={action}><ToolbarIcon name="plus" size={14} /></button> : null}
    </div>
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
        {action ? <button type="button" className={styles.add} data-add="" aria-label={`${t(label)} +`} onClick={action}><ToolbarIcon name="plus" size={14} /></button> : null}
      </div>
      <div id={`repository-${id}`} hidden={!open} className={styles.sectionBody}>
        {content}
        {open && props.tools[(view ?? id) as ViewId]
          ? <div className={styles.inlineTool} data-repository-tool={view ?? id}>{props.tools[(view ?? id) as ViewId]}</div> : null}
      </div>
    </section>
  }
  return <aside className={styles.navigator} data-collapsed={collapsed ? 'true' : undefined} aria-label={t('workbench.repository.aria')}>
    <div className={styles.heading}>
      <strong>{props.name}</strong>
      <button
        type="button"
        className={styles.collapse}
        aria-pressed={!collapsed}
        aria-label={t(collapsed ? 'workbench.repository.expand' : 'workbench.repository.collapse')}
        title={t(collapsed ? 'workbench.repository.expand' : 'workbench.repository.collapse')}
        onClick={() => {
          if (collapsed) {
            if (onCenterScreen) setCenterExpanded(true)
            else setCollapsed(false)
            return
          }
          if (onCenterScreen) {
            setCenterExpanded(false)
            return
          }
          if (props.active !== 'graph') props.onNavigate('graph')
          setCollapsed(true)
        }}
      >
        <ToolbarIcon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={14} />
      </button>
    </div>
    <div className={styles.filterRow}>
      <input type="search" className={styles.search} value={query} onChange={(event) => setQuery(event.target.value)}
        aria-label={t('workbench.repository.filter')} placeholder={t('workbench.repository.filter')} />
      <button type="button" className={styles.viewToggle} aria-pressed={tree}
        title={t(tree ? 'workbench.repository.viewList' : 'workbench.repository.viewTree')}
        aria-label={t(tree ? 'workbench.repository.viewList' : 'workbench.repository.viewTree')}
        onClick={() => setTree(!tree)}>{tree ? '☷' : '≣'}</button>
    </div>
    {collapsed ? <nav className={styles.rail}>
      <RailFlyout icon="local" label={t('workbench.branches.local')} count={groups.local.length}
        action={props.onCreateBranch} sectionId="local">
        {branchRows('local', groups.local)}
      </RailFlyout>
      <RailFlyout icon="remotes" label={t('workbench.branches.remote')} count={groups.remote.length}
        action={props.onCreateRemote} sectionId="remotes">
        {branchRows('remotes', groups.remote)}
      </RailFlyout>
      <RailFlyout icon="tags" label={t('nav.tags')} count={tags.length} action={props.onCreateTag} sectionId="tags">
        {tags.map((entry) => refRow(entry))}
      </RailFlyout>
      <RailFlyout icon="stash" label={t('nav.stash')} count={stashes.length}
        action={props.canStash ? props.onCreateStash : undefined} sectionId="stash">
        {stashRows()}
      </RailFlyout>
      <div className={styles.railSplit} />
      <RailLink icon="worktrees" label={t('nav.worktrees')} id="worktrees" current={props.active === 'worktrees'} onClick={() => openTool('worktrees')} />
      <RailLink icon="submodules" label={t('nav.submodules')} id="submodules" current={props.active === 'submodules'} onClick={() => openTool('submodules')} />
      {showMrs ? <RailLink icon="mrs" label={t('nav.mrs')} id="mrs" current={props.active === 'mrs'} onClick={() => openTool('mrs')} /> : null}
      {showPrs ? <RailLink icon="prs" label={t('nav.prs')} id="prs" current={props.active === 'prs'} onClick={() => openTool('prs')} /> : null}
      {showPipelines ? <RailLink icon="pipelines" label={t('nav.pipelines')} id="pipelines" current={props.active === 'pipelines'} onClick={() => openTool('pipelines')} /> : null}
      <RailLink icon="search" label={t('nav.search')} id="search" current={props.active === 'search'} onClick={() => openTool('search')} />
      {props.active === 'patches' ? <RailLink icon="patches" label={t('nav.patches')} id="patches" current onClick={() => openTool('patches')} /> : null}
    </nav> : null}
    {collapsed ? null : <div className={styles.sections}>
      {section('local', 'workbench.branches.local', branchRows('local', groups.local), groups.local.length, props.onCreateBranch)}
      {section('remotes', 'workbench.branches.remote', branchRows('remotes', groups.remote), groups.remote.length, props.onCreateRemote)}
      {section('tags', 'nav.tags', tags.map((entry) => refRow(entry)), tags.length, props.onCreateTag)}
      {section('stash', 'nav.stash', stashRows(), stashes.length, props.canStash ? props.onCreateStash : undefined)}
      <nav className={styles.pages} aria-label={t('workbench.repository.pages')}>
        {pageLink('worktrees', 'nav.worktrees', props.onCreateWorktree)}
        {pageLink('submodules', 'nav.submodules', props.onCreateSubmodule)}
        {showMrs ? pageLink('mrs', 'nav.mrs') : null}
        {showPrs ? pageLink('prs', 'nav.prs') : null}
        {showPipelines ? pageLink('pipelines', 'nav.pipelines') : null}
        {pageLink('search', 'nav.search')}
      </nav>
      {props.active === 'patches' ? section('patches', 'nav.patches', null, undefined, undefined, 'patches') : null}
      {props.tools[props.active] && !['remotes', 'tags', 'worktrees', 'submodules', 'mrs', 'prs', 'pipelines', 'patches', 'search'].includes(props.active)
        ? <div className={styles.inlineTool} data-repository-tool={props.active}>{props.tools[props.active]}</div> : null}
    </div>}
  </aside>
}
