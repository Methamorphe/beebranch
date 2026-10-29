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
  | 'gitlab'
  | 'github'
  | 'stash'
  | 'sync'
  | 'diff'
  | 'tools'
  | 'recovery'
  | 'profiles'
  | 'workspaces'

export type NavigationItem = {
  id: ViewId
  /** Catalogue key resolved with `t` at render time. */
  labelKey: MessageKey
  icon: string
  requiresRepo: boolean
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
      { id: 'status', labelKey: 'nav.status', icon: '◧', requiresRepo: true },
      { id: 'commit', labelKey: 'nav.commit', icon: '◉', requiresRepo: true },
      { id: 'conflicts', labelKey: 'nav.conflicts', icon: '⇄', requiresRepo: true },
      { id: 'stash', labelKey: 'nav.stash', icon: '▱', requiresRepo: true },
    ],
  },
  {
    id: 'branches',
    labelKey: 'nav.group.branches',
    items: [
      { id: 'worktrees', labelKey: 'nav.worktrees', icon: '⊞', requiresRepo: true },
      { id: 'tags', labelKey: 'nav.tags', icon: '◇', requiresRepo: true },
      { id: 'remotes', labelKey: 'nav.remotes', icon: '⇅', requiresRepo: true },
      { id: 'submodules', labelKey: 'nav.submodules', icon: '▣', requiresRepo: true },
    ],
  },
  {
    id: 'gitlab',
    labelKey: 'nav.group.forge',
    items: [
      { id: 'mrs', labelKey: 'nav.mrs', icon: '⑃', requiresRepo: true },
      { id: 'prs', labelKey: 'nav.prs', icon: '⑂', requiresRepo: true },
      { id: 'sync', labelKey: 'nav.sync', icon: '↻', requiresRepo: true },
      { id: 'gitlab', labelKey: 'nav.gitlab', icon: '◎', requiresRepo: false },
      { id: 'github', labelKey: 'nav.github', icon: '◉', requiresRepo: false },
    ],
  },
  {
    id: 'operations',
    labelKey: 'nav.group.operations',
    items: [
      { id: 'rebase', labelKey: 'nav.rebase', icon: '⇶', requiresRepo: true },
      { id: 'patches', labelKey: 'nav.patches', icon: '▤', requiresRepo: true },
      { id: 'fileHistory', labelKey: 'nav.fileHistory', icon: '⌖', requiresRepo: true },
      { id: 'search', labelKey: 'nav.search', icon: '⌕', requiresRepo: true },
      { id: 'diff', labelKey: 'nav.diff', icon: '±', requiresRepo: true },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.group.system',
    items: [
      { id: 'profiles', labelKey: 'nav.profiles', icon: '⚙', requiresRepo: false },
      { id: 'tools', labelKey: 'nav.tools', icon: '⌘', requiresRepo: true },
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
  profiles: 'nav.description.profiles',
  gitlab: 'nav.description.gitlab',
  github: 'nav.description.github',
  tools: 'nav.description.tools',
  recovery: 'nav.description.recovery',
  diff: 'nav.description.diff',
}
