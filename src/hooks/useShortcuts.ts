import { useEffect } from 'react'
import { matchesShortcut, type ShortcutMap } from '../lib/shortcuts'

export type ShortcutHandlers = {
  palette: () => void
  settings: () => void
  newBranch: () => void
  search: () => void
  findInGraph: () => void
  openRepo: () => void
  newTab: () => void
  closeTab: () => void
  workspaces: () => void
  undo: () => void
  redo: () => void
  close: () => void
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const tag = target.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  )
}

/** Global keyboard shortcuts. No shortcut silently overrides a form field. */
export function useShortcuts(handlers: ShortcutHandlers, shortcuts: ShortcutMap) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handlers.close()
        return
      }
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return
      if (isEditable(event.target)) {
        // Cmd/Ctrl+K / T / W / Shift+F stay global. Mod+F is left to the focused
        // field (CodeMirror search, native inputs) so it does not fight them.
        if (
          !matchesShortcut(event, shortcuts.palette) &&
          !matchesShortcut(event, shortcuts.newTab) &&
          !matchesShortcut(event, shortcuts.closeTab) &&
          !matchesShortcut(event, shortcuts.search)
        ) {
          return
        }
      }
      for (const [action, handler] of Object.entries(handlers) as [
        keyof ShortcutHandlers,
        () => void,
      ][]) {
        if (action === 'close') {
          continue
        }
        if (matchesShortcut(event, shortcuts[action])) {
          event.preventDefault()
          handler()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handlers, shortcuts])
}
