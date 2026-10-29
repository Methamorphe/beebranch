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
  label: string
  icon: string
  requiresRepo: boolean
}

export type NavigationGroup = {
  id: string
  label: string
  items: NavigationItem[]
}

export const navigationGroups: NavigationGroup[] = [
  {
    id: 'workspace',
    label: 'Espace de travail',
    items: [
      { id: 'graph', label: 'Historique', icon: '⑂', requiresRepo: true },
      { id: 'workspaces', label: 'Workspaces', icon: '▦', requiresRepo: false },
      { id: 'status', label: 'Modifications', icon: '◧', requiresRepo: true },
      { id: 'commit', label: 'Commit', icon: '◉', requiresRepo: true },
      { id: 'conflicts', label: 'Conflits', icon: '⇄', requiresRepo: true },
      { id: 'stash', label: 'Stash', icon: '▱', requiresRepo: true },
    ],
  },
  {
    id: 'branches',
    label: 'Branches',
    items: [
      { id: 'worktrees', label: 'Worktrees', icon: '⊞', requiresRepo: true },
      { id: 'tags', label: 'Tags', icon: '◇', requiresRepo: true },
      { id: 'remotes', label: 'Remotes', icon: '⇅', requiresRepo: true },
      { id: 'submodules', label: 'Sous-modules', icon: '▣', requiresRepo: true },
    ],
  },
  {
    id: 'gitlab',
    label: 'Forge',
    items: [
      { id: 'mrs', label: 'Merge requests', icon: '⑃', requiresRepo: true },
      { id: 'prs', label: 'Pull requests', icon: '⑂', requiresRepo: true },
      { id: 'sync', label: 'Synchronisation', icon: '↻', requiresRepo: true },
      { id: 'gitlab', label: 'Connexion GitLab', icon: '◎', requiresRepo: false },
      { id: 'github', label: 'Connexion GitHub', icon: '◉', requiresRepo: false },
    ],
  },
  {
    id: 'operations',
    label: 'Outils avancés',
    items: [
      { id: 'rebase', label: 'Rebase interactif', icon: '⇶', requiresRepo: true },
      { id: 'patches', label: 'Patches', icon: '▤', requiresRepo: true },
      { id: 'fileHistory', label: 'Historique de fichier', icon: '⌖', requiresRepo: true },
      { id: 'search', label: 'Rechercher', icon: '⌕', requiresRepo: true },
      { id: 'diff', label: 'Diff', icon: '±', requiresRepo: true },
    ],
  },
  {
    id: 'system',
    label: 'Préférences',
    items: [
      { id: 'profiles', label: 'Réglages', icon: '⚙', requiresRepo: false },
      { id: 'tools', label: 'Outils externes', icon: '⌘', requiresRepo: true },
      { id: 'recovery', label: 'Journal et récupération', icon: '⟲', requiresRepo: false },
    ],
  },
]

export const navigationItems: NavigationItem[] = navigationGroups.flatMap(
  (group) => group.items,
)

// Short, task-oriented context shared by every secondary screen.
export const viewDescriptions: Partial<Record<ViewId, string>> = {
  workspaces: 'Regroupez vos dépôts et suivez leur état au même endroit.',
  status: 'Examinez vos modifications et préparez le prochain commit.',
  commit: 'Sélectionnez les changements à inclure dans votre commit.',
  stash: 'Mettez vos modifications de côté et reprenez-les plus tard.',
  mrs: 'Retrouvez vos merge requests GitLab, les discussions et les pipelines.',
  prs: 'Retrouvez vos pull requests GitHub, les revues et les checks.',
  search: 'Retrouvez un commit, un fichier ou du texte dans votre dépôt.',
  conflicts: 'Comparez les versions et choisissez le contenu à conserver.',
  rebase: 'Réordonnez et regroupez vos commits avant de les partager.',
  fileHistory: 'Suivez les changements d’un fichier et retrouvez leurs auteurs.',
  worktrees: 'Travaillez sur plusieurs branches dans des dossiers distincts.',
  tags: 'Identifiez les versions et les étapes clés de votre dépôt.',
  remotes: 'Gérez les dépôts distants utilisés pour la synchronisation.',
  submodules: 'Consultez et actualisez les dépôts intégrés à votre projet.',
  patches: 'Préparez, vérifiez et appliquez un ensemble de changements.',
  sync: 'Récupérez et publiez les changements de votre branche.',
  profiles: 'Personnalisez votre environnement et vos identités Git.',
  gitlab: 'Connectez votre compte et associez vos projets GitLab.',
  github: 'Connectez votre compte et associez vos dépôts GitHub.',
  tools: 'Ouvrez votre dépôt dans vos outils de développement.',
  recovery: 'Retrouvez les opérations interrompues et les actions récentes.',
  diff: 'Comparez les versions et examinez chaque changement.',
}
