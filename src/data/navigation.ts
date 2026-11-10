import type { MessageKey } from '../i18n'

export type ViewId =
  | 'graph'
  | 'status'
  | 'commit'
  | 'conflicts'
  | 'rebase'
  | 'worktrees'
  | 'tags'
  | 'remotes'
  | 'submodules'
  | 'patches'
  | 'fileHistory'
  | 'search'
  | 'mrs'
  | 'prs'
  | 'pipelines'
  | 'gitlab'
  | 'github'
  | 'integrations'
  | 'stash'
  | 'sync'
  | 'terminal'
  | 'diff'
  | 'tools'
  | 'activity'
  | 'recovery'
  | 'profiles'
  | 'workspaces'

export type NavigationItem = {
  id: ViewId
  /** Catalogue key resolved with `t` at render time. */
  labelKey: MessageKey
  icon: string
  requiresRepo: boolean
  /**
   * Transient screens opened from another view. They stay out of the sidebar
   * and the command palette; the screen that opened them is the way back.
   */
  catalog?: boolean
  /**
   * Same catalogue entry as the others, pinned to the connection control
   * instead of the scrolling list. The command palette still lists it in
   * its group.
   */
  connection?: boolean
  /**
   * Left out of the sidebar. The command palette still lists it.
   * Status and commit are not screens: they open the worktree on the history.
   */
  sidebar?: boolean
}

export type NavigationGroup = {
  id: string
  labelKey: MessageKey
  items: NavigationItem[]
}

export const navigationGroups: NavigationGroup[] = [
  {
    id: 'workspace',
    labelKey: 'nav.group.workspace',
    items: [
      { id: 'graph', labelKey: 'nav.graph', icon: '⑂', requiresRepo: true },
      { id: 'workspaces', labelKey: 'nav.workspaces', icon: '▦', requiresRepo: false },
      { id: 'status', labelKey: 'nav.status', icon: '◧', requiresRepo: true, sidebar: false },
      { id: 'commit', labelKey: 'nav.commit', icon: '◉', requiresRepo: true, sidebar: false },
      { id: 'conflicts', labelKey: 'nav.conflicts', icon: '⇄', requiresRepo: true },
      { id: 'stash', labelKey: 'nav.stash', icon: '▱', requiresRepo: true, sidebar: false },
      { id: 'search', labelKey: 'nav.search', icon: '⌕', requiresRepo: true, sidebar: false },
    ],
  },
  {
    id: 'branches',
    labelKey: 'nav.group.branches',
    items: [
      { id: 'worktrees', labelKey: 'nav.worktrees', icon: '⊞', requiresRepo: true, sidebar: false },
      { id: 'tags', labelKey: 'nav.tags', icon: '◇', requiresRepo: true, sidebar: false },
      { id: 'remotes', labelKey: 'nav.remotes', icon: '⇅', requiresRepo: true, sidebar: false },
      { id: 'submodules', labelKey: 'nav.submodules', icon: '▣', requiresRepo: true, sidebar: false },
    ],
  },
  {
    id: 'gitlab',
    labelKey: 'nav.group.forge',
    items: [
      { id: 'mrs', labelKey: 'nav.mrs', icon: '⑃', requiresRepo: true, sidebar: false },
      { id: 'prs', labelKey: 'nav.prs', icon: '⑂', requiresRepo: true, sidebar: false },
      { id: 'pipelines', labelKey: 'nav.pipelines', icon: '⌁', requiresRepo: true, sidebar: false },
      { id: 'sync', labelKey: 'nav.sync', icon: '↻', requiresRepo: true },
      { id: 'terminal', labelKey: 'nav.terminal', icon: '>_', requiresRepo: true },
      { id: 'gitlab', labelKey: 'nav.gitlab', icon: '◎', requiresRepo: false, connection: true },
      { id: 'github', labelKey: 'nav.github', icon: '◉', requiresRepo: false, connection: true },
    ],
  },
  {
    id: 'operations',
    labelKey: 'nav.group.operations',
    items: [
      { id: 'rebase', labelKey: 'nav.rebase', icon: '⇶', requiresRepo: true },
      { id: 'patches', labelKey: 'nav.patches', icon: '▤', requiresRepo: true },
      { id: 'fileHistory', labelKey: 'nav.fileHistory', icon: '⌖', requiresRepo: true },
      { id: 'diff', labelKey: 'nav.diff', icon: '±', requiresRepo: true, catalog: false },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.group.system',
    items: [
      { id: 'profiles', labelKey: 'nav.profiles', icon: '⚙', requiresRepo: false, sidebar: false },
      { id: 'integrations', labelKey: 'nav.integrations', icon: '◎', requiresRepo: false, sidebar: false },
      { id: 'tools', labelKey: 'nav.tools', icon: '⌘', requiresRepo: true },
      { id: 'activity', labelKey: 'nav.activity', icon: '◷', requiresRepo: true },
      { id: 'recovery', labelKey: 'nav.recovery', icon: '⟲', requiresRepo: false },
    ],
  },
]

export const navigationItems: NavigationItem[] = navigationGroups.flatMap(
  (group) => group.items,
)

/** Short, task-oriented context shared by every secondary screen. */
export const viewDescriptions: Partial<Record<ViewId, MessageKey>> = {
  workspaces: 'nav.description.workspaces',
  status: 'nav.description.status',
  commit: 'nav.description.commit',
  stash: 'nav.description.stash',
  mrs: 'nav.description.mrs',
  prs: 'nav.description.prs',
  pipelines: 'nav.description.pipelines',
  search: 'nav.description.search',
  conflicts: 'nav.description.conflicts',
  rebase: 'nav.description.rebase',
  fileHistory: 'nav.description.fileHistory',
  worktrees: 'nav.description.worktrees',
  tags: 'nav.description.tags',
  remotes: 'nav.description.remotes',
  submodules: 'nav.description.submodules',
  patches: 'nav.description.patches',
  sync: 'nav.description.sync',
  terminal: 'nav.description.terminal',
  profiles: 'nav.description.profiles',
  integrations: 'nav.description.integrations',
  gitlab: 'nav.description.gitlab',
  github: 'nav.description.github',
  tools: 'nav.description.tools',
  recovery: 'nav.description.recovery',
  diff: 'nav.description.diff',
}

/** Pages about the application or the forges, not about the open repository. */
export const APP_PAGES: readonly ViewId[] = ['profiles', 'workspaces', 'gitlab', 'github', 'integrations', 'recovery']
