export type ShortcutAction =
  | 'palette'
  | 'settings'
  | 'newBranch'
  | 'search'
  | 'openRepo'
  | 'undo'
  | 'redo'

export type ShortcutMap = Record<ShortcutAction, string>

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  palette: 'Mod+K',
  settings: 'Mod+,',
  newBranch: 'Mod+B',
  search: 'Mod+Shift+F',
  openRepo: 'Mod+O',
  undo: 'Mod+Z',
  redo: 'Mod+Shift+Z',
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  palette: 'Palette de commandes',
  settings: 'Profils et réglages',
  newBranch: 'Nouvelle branche',
  search: 'Recherche approfondie',
  openRepo: 'Ouvrir un dépôt',
  undo: 'Annuler',
  redo: 'Rétablir',
}

type Parsed = {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

function parse(combo: string): Parsed | null {
  const parts = combo
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  const parsed: Parsed = {
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: '',
  }
  for (const [index, part] of parts.entries()) {
    const token = part.toLowerCase()
    const isLast = index === parts.length - 1
    if (!isLast) {
      if (token === 'mod') {
        parsed.meta = true
      } else if (token === 'meta' || token === 'cmd' || token === '⌘') {
        parsed.meta = true
      } else if (token === 'ctrl' || token === 'control') {
        parsed.ctrl = true
      } else if (token === 'alt' || token === 'option' || token === '⌥') {
        parsed.alt = true
      } else if (token === 'shift' || token === '⇧') {
        parsed.shift = true
      } else {
        return null
      }
    } else {
      if (token.length === 0 || token.length > 12) {
        return null
      }
      parsed.key = token
    }
  }
  return parsed.key ? parsed : null
}

export function normalizeShortcut(combo: string): string | null {
  const parsed = parse(combo)
  if (!parsed) {
    return null
  }
  const tokens: string[] = []
  if (parsed.meta) {
    tokens.push('Mod')
  }
  if (parsed.ctrl) {
    tokens.push('Ctrl')
  }
  if (parsed.alt) {
    tokens.push('Alt')
  }
  if (parsed.shift) {
    tokens.push('Shift')
  }
  tokens.push(parsed.key.toUpperCase())
  return tokens.join('+')
}

export function matchesShortcut(event: KeyboardEvent, combo: string): boolean {
  const parsed = parse(combo)
  if (!parsed) {
    return false
  }
  const mod = event.metaKey || event.ctrlKey
  if (parsed.meta && !mod) {
    return false
  }
  if (!parsed.meta && mod) {
    return false
  }
  if (parsed.ctrl && !event.ctrlKey) {
    return false
  }
  if (parsed.alt && !event.altKey) {
    return false
  }
  if (parsed.shift && !event.shiftKey) {
    return false
  }
  if (!parsed.shift && event.shiftKey && parsed.key.length === 1) {
    return false
  }
  return event.key.toLowerCase() === parsed.key.toLowerCase()
}

/** Returns the duplicated actions, if any. Silent conflicts are forbidden. */
export function findConflicts(shortcuts: ShortcutMap): ShortcutAction[] {
  const seen = new Map<string, ShortcutAction>()
  const conflicts = new Set<ShortcutAction>()
  for (const [action, combo] of Object.entries(shortcuts) as [
    ShortcutAction,
    string,
  ][]) {
    const normalized = normalizeShortcut(combo)
    if (!normalized) {
      continue
    }
    const existing = seen.get(normalized)
    if (existing && existing !== action) {
      conflicts.add(existing)
      conflicts.add(action)
    } else {
      seen.set(normalized, action)
    }
  }
  return [...conflicts]
}

export function displayShortcut(combo: string): string {
  return combo.replace(/\bMod\b/g, '⌘').replace(/\bShift\b/g, '⇧').replace(/\bAlt\b/g, '⌥')
}
