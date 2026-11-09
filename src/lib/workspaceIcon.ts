import {
  BookOpen,
  Bot,
  Box,
  Boxes,
  Briefcase,
  Bug,
  Cloud,
  Cpu,
  Database,
  Flame,
  FlaskConical,
  FolderGit2,
  Folders,
  Globe,
  Heart,
  Hexagon,
  Layers,
  Package,
  Palette,
  Puzzle,
  Rocket,
  Shield,
  Star,
  Terminal,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/** Keys accepted by `workspace_set_icon`. Keep in step with `LUCIDE_ICONS`. */
export const WORKSPACE_ICONS: { key: string; icon: LucideIcon }[] = [
  { key: 'folders', icon: Folders },
  { key: 'folder-git-2', icon: FolderGit2 },
  { key: 'box', icon: Box },
  { key: 'boxes', icon: Boxes },
  { key: 'terminal', icon: Terminal },
  { key: 'bug', icon: Bug },
  { key: 'rocket', icon: Rocket },
  { key: 'flame', icon: Flame },
  { key: 'heart', icon: Heart },
  { key: 'star', icon: Star },
  { key: 'zap', icon: Zap },
  { key: 'database', icon: Database },
  { key: 'cloud', icon: Cloud },
  { key: 'globe', icon: Globe },
  { key: 'cpu', icon: Cpu },
  { key: 'layers', icon: Layers },
  { key: 'package', icon: Package },
  { key: 'puzzle', icon: Puzzle },
  { key: 'briefcase', icon: Briefcase },
  { key: 'book-open', icon: BookOpen },
  { key: 'flask-conical', icon: FlaskConical },
  { key: 'palette', icon: Palette },
  { key: 'shield', icon: Shield },
  { key: 'wrench', icon: Wrench },
  { key: 'bot', icon: Bot },
  { key: 'hexagon', icon: Hexagon },
  { key: 'workflow', icon: Workflow },
]

const byKey = new Map(WORKSPACE_ICONS.map((entry) => [entry.key, entry.icon]))

export function workspaceLucideIcon(key: string | null | undefined): LucideIcon | null {
  if (!key) return null
  return byKey.get(key) ?? null
}

export function workspaceMonogram(name: string): string {
  const first = [...name.trim()][0]
  return first ? first.toLocaleUpperCase() : '?'
}

const iconImages = new Map<string, string>()

export function cachedWorkspaceImage(id: string, updatedAt: number): string | undefined {
  return iconImages.get(`${id}:${updatedAt}`)
}

export function rememberWorkspaceImage(id: string, updatedAt: number, url: string) {
  iconImages.set(`${id}:${updatedAt}`, url)
}

/** Cover-crop a decoded image into a 128px PNG and return the raw base64 payload. */
export function rasterizeWorkspaceIcon(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const size = 128
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context || image.width === 0 || image.height === 0) {
        reject(new Error('image'))
        return
      }
      const scale = Math.max(size / image.width, size / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('png'))
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const payload = String(reader.result ?? '').split(',')[1]
          if (!payload) reject(new Error('png'))
          else resolve(payload)
        }
        reader.onerror = () => reject(reader.error ?? new Error('png'))
        reader.readAsDataURL(blob)
      }, 'image/png')
    }
    image.onerror = () => reject(new Error('image'))
    image.src = dataUrl
  })
}
