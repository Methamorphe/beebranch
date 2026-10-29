import { useEffect } from 'react'
import { matchesShortcut, type ShortcutMap } from '../lib/shortcuts'

export type ShortcutHandlers = {
  palette: () => void
  settings: () => void
  newBranch: () => void
  search: () => void
  openRepo: () => void
  newTab: () => void
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
        // Cmd/Ctrl+K and Cmd/Ctrl+T stay global; other shortcuts must not
        // steal typing.
        if (
          !matchesShortcut(event, shortcuts.palette) &&
          !matchesShortcut(event, shortcuts.newTab)
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
