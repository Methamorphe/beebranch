import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useModal } from '../hooks/useModal'
import { useI18n } from '../i18n'
import { rankCommands } from '../lib/palette'
import styles from './CommandPalette.module.css'

export type PaletteCommand = {
  id: string
  label: string
  group: string
  shortcut?: string
  detail?: string
  available?: boolean
  unavailableReason?: string
  /** Relevant to the active view: ranked first when nothing was typed. */
  contextual?: boolean
  run: () => void
}

type Props = {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}

const RECENT_KEY = 'ui.palette.recent'
const RECENT_LIMIT = 8

function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === 'string').slice(0, RECENT_LIMIT)
      : []
  } catch {
    return []
  }
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const { t } = useI18n()
  const modalRef = useModal(open, onClose)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [recent, setRecent] = useState<string[]>(readRecent)
  const recentRef = useRef(recent)
  const listRef = useRef<HTMLDivElement>(null)

  /** Move an executed command to the front of the persisted recents. */
  const remember = useCallback((id: string) => {
    const next = [id, ...recentRef.current.filter((value) => value !== id)].slice(
      0,
      RECENT_LIMIT,
    )
    recentRef.current = next
    setRecent(next)
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // Storage unavailable: recents stay session-only.
    }
  }, [])

  const filtered = useMemo(
    () => rankCommands(commands, query, recent),
    [commands, query, recent],
  )

  useEffect(() => {
    if (!open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex((current) => {
          for (let next = current + 1; next < filtered.length; next++) if (filtered[next]?.available !== false) return next
          return current
        })
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIndex((current) => {
          for (let next = current - 1; next >= 0; next--) if (filtered[next]?.available !== false) return next
          return current
        })
      } else if (event.key === 'Enter') {
        const command = filtered[index]
        if (command && command.available !== false) {
          event.preventDefault()
          remember(command.id)
          onClose()
          command.run()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, index, onClose, remember])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) {
    return null
  }

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div ref={modalRef} tabIndex={-1} className={styles.modal} role="dialog" aria-modal="true" aria-label={t('shell.palette.dialogAria')}>
        <input
          value={query}
            data-autofocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('shell.palette.searchPlaceholder')}
          role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list"
          aria-activedescendant={filtered[index] ? `command-${filtered[index].id}` : undefined}
          aria-label={t('shell.palette.searchAria')}
          spellCheck={false}
        />
        <div className={styles.commands} ref={listRef} role="listbox" id="palette-results" aria-label={t('shell.palette.commandsAria')}>
          {filtered.length === 0 ? (
            <p className={styles.empty}>{t('shell.palette.empty')}</p>
          ) : null}
          {filtered.map((command, position) => (
            <button
              key={command.id}
              id={`command-${command.id}`}
              type="button"
              tabIndex={-1}
              role="option"
              aria-selected={position === index}
              data-active={position === index}
              className={
                position === index ? styles.commandFocus : styles.command
              }
              disabled={command.available === false}
              title={command.available === false ? command.unavailableReason : undefined}
              onMouseEnter={() => setIndex(position)}
              onClick={() => {
                remember(command.id)
                onClose()
                command.run()
              }}
            >
              <span className={styles.group}>{command.group}</span>
              <span className={styles.label}>{command.label}</span>
              {command.available === false ? (
                <span className={styles.reason}>
                  {command.unavailableReason ??
                    t('shell.palette.unavailable.generic')}
                </span>
              ) : command.shortcut ? (
                <kbd>{command.shortcut}</kbd>
              ) : null}
            </button>
          ))}
        </div>
        <div className={styles.footer}>
          {t('shell.palette.footer.navigate')}
          <span>{t('shell.palette.escape')}</span>
        </div>
      </div>
    </div>
  )
}
