import {
  AppWindow,
  Archive,
  Boxes,
  Cloud,
  FileClock,
  FileDiff,
  FilePlus,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitFork,
  GitGraph,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestArrow,
  Hexagon,
  Logs,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Tag,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ViewId } from '../data/navigation'
import { AppIcon } from './IconSvg'

type IconKey = ViewId | 'branch'

const icons: Record<IconKey, LucideIcon> = {
  graph: GitGraph,
  status: FileDiff,
  commit: GitCommitHorizontal,
  conflicts: GitMergeConflict,
  rebase: GitPullRequestArrow,
  worktrees: Folders,
  workspaces: AppWindow,
  tags: Tag,
  remotes: Cloud,
  submodules: Boxes,
  patches: FilePlus,
  fileHistory: FileClock,
  search: Search,
  mrs: GitPullRequest,
  prs: GitPullRequest,
  pipelines: Workflow,
  gitlab: Hexagon,
  github: GitFork,
  stash: Archive,
  sync: RefreshCw,
  terminal: SquareTerminal,
  diff: GitCompare,
  tools: Wrench,
  activity: Logs,
  recovery: RotateCcw,
  profiles: SlidersHorizontal,
  branch: GitBranch,
}

export function ViewIcon({ view, size = 18 }: { view: IconKey; size?: number }) {
  return <AppIcon icon={icons[view]} size={size} />
}
