import {
  Archive,
  ArchiveArrowUp,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  CloudDownload,
  Download,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Info,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  Plus,
  Redo2,
  Search,
  Settings,
  SquareTerminal,
  Star,
  TriangleExclamationPoint,
  Undo2,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { AppIcon } from './IconSvg'

const icons = {
  clone: FolderGit2,
  folder: FolderOpen,
  plus: Plus,
  chevron: ChevronDown,
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  search: Search,
  settings: Settings,
  fetch: CloudDownload,
  pull: ArrowDownToLine,
  push: ArrowUpFromLine,
  branch: GitBranch,
  stash: Archive,
  pop: ArchiveArrowUp,
  terminal: SquareTerminal,
  actions: LayoutGrid,
  undo: Undo2,
  update: Download,
  redo: Redo2,
  info: Info,
  pipeline: Workflow,
  warning: TriangleExclamationPoint,
  star: Star,
  starOff: Star,
  swap: ArrowLeftRight,
  expand: Maximize2,
  check: Check,
  x: X,
  more: MoreHorizontal,
  arrowRight: ArrowRight,
  externalLink: ExternalLink,
  circleDashed: CircleDashed,
} satisfies Record<string, LucideIcon>

export function ToolbarIcon({ name, size = 22 }: { name: keyof typeof icons; size?: number }) {
  return (
    <AppIcon
      icon={icons[name]}
      size={size}
      fill={name === 'star' ? 'currentColor' : undefined}
    />
  )
}
