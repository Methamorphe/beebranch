import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { displayShortcut } from '../lib/shortcuts'
import type { Workspace } from '../types/git'
import styles from './WorkspaceSwitcher.module.css'

type Props = {
  workspaces: Workspace[]
  activeId: string | null
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (workspaceId: string) => void
  onManage: () => void
  shortcut: string
}

/**
 * Active-workspace pill and its switcher. Selecting a workspace replaces the
 * open tabs with that workspace's repositories, so the choice must stay visible
 * even while no repository is open.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeId,
  busy,
  open,
  onOpenChange,
  onSelect,
  onManage,
  shortcut,
}: Props) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // An outside click already moves focus where the user clicked; only a
  // keyboard dismissal returns it to the trigger.
  const dismissedOutside = useRef(false)
  const wasOpen = useRef(false)
  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null

  useEffect(() => {
    if (!open) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const entries = menuEntries()
      const index = workspaces.findIndex((workspace) => workspace.id === activeId)
      ;(entries[Math.max(0, index)] ?? entries[0])?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, workspaces, activeId])

  useEffect(() => {
    if (wasOpen.current && !open) {
      if (!dismissedOutside.current) {
        trigger.current?.focus()
      }
      dismissedOutside.current = false
    }
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current && !root.current.contains(event.target)) {
        dismissedOutside.current = true
        onOpenChange(false)
      }
    }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [open, onOpenChange])

  const menuEntries = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ]

  const move = (delta: 1 | -1) => {
    const entries = menuEntries()
    if (entries.length === 0) {
      return
    }
    const current = entries.indexOf(document.activeElement as HTMLButtonElement)
    entries[(current + delta + entries.length) % entries.length]?.focus()
  }

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={trigger}
        type="button"
        className={active ? styles.triggerActive : styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspaces.switcher.label')}
        title={t('workspaces.switcher.title', {
          name: active?.name ?? t('workspaces.switcher.none'),
          shortcut: displayShortcut(shortcut),
        })}
        onClick={() => onOpenChange(!open)}
      >
        <span className={styles.glyph} aria-hidden="true">
          ▦
        </span>
        <span className={styles.name}>{active?.name ?? t('workspaces.switcher.none')}</span>
        <span className={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div
          ref={menu}
          className={styles.menu}
          role="menu"
          aria-label={t('workspaces.switcher.menu')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onOpenChange(false)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              menuEntries()[0]?.focus()
            } else if (event.key === 'End') {
              event.preventDefault()
              menuEntries().at(-1)?.focus()
            }
          }}
        >
          {workspaces.length === 0 ? (
            <p className={styles.empty}>{t('workspaces.switcher.empty')}</p>
          ) : (
            workspaces.map((workspace) => {
              const selected = workspace.id === activeId
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={busy}
                  className={selected ? styles.itemActive : styles.item}
                  onClick={() => onSelect(workspace.id)}
                >
                  <span className={styles.itemName}>{workspace.name}</span>
                  <span className={styles.count}>{workspace.repos.length}</span>
                  <span className={styles.check} aria-hidden="true">
                    {selected ? '✓' : ''}
                  </span>
                </button>
              )
            })
          )}
          <div className={styles.separator} role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={styles.manage}
            onClick={onManage}
          >
            {t('workspaces.switcher.manage')}
          </button>
          <p className={styles.hint} aria-hidden="true">
            <kbd>{displayShortcut(shortcut)}</kbd> {t('workspaces.switcher.hint')}
          </p>
        </div>
      ) : null}
    </div>
  )
}
