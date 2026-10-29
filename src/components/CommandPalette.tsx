import { useEffect, useMemo, useRef, useState } from 'react'
import { useModal } from '../hooks/useModal'
import { useI18n } from '../i18n'
import styles from './CommandPalette.module.css'

export type PaletteCommand = {
  id: string
  label: string
  group: string
  shortcut?: string
  detail?: string
  available?: boolean
  unavailableReason?: string
  run: () => void
}

type Props = {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}

function score(query: string, label: string): number | null {
  if (!query) {
    return 0
  }
  const haystack = label.toLowerCase()
  const needle = query.toLowerCase()
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    return direct
  }
  let index = 0
  let gaps = 0
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1
      if (index === needle.length) {
        return 100 + gaps
      }
    } else if (index > 0) {
      gaps += 1
    }
  }
  return null
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const { t } = useI18n()
  const modalRef = useModal(open, onClose)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const ranked = commands
      .map((command) => ({
        command,
        score: score(query.trim(), command.label),
      }))
      .filter((entry): entry is { command: PaletteCommand; score: number } => entry.score !== null)
      .sort((a, b) => Number(a.command.available === false) - Number(b.command.available === false) || a.score - b.score || a.command.label.localeCompare(b.command.label))
    return ranked.map((entry) => entry.command)
  }, [commands, query])

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
          onClose()
          command.run()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, index, onClose])

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
      <div ref={modalRef} tabIndex={-1} className={styles.modal} role="dialog" aria-modal="true" aria-label="Palette de commandes">
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
        <div className={styles.commands} ref={listRef} role="listbox" id="palette-results" aria-label="Commandes">
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
                onClose()
                command.run()
              }}
            >
              <span className={styles.group}>{command.group}</span>
              <span className={styles.label}>{command.label}</span>
              {command.available === false ? (
                <span className={styles.reason}>indisponible</span>
              ) : command.shortcut ? (
                <kbd>{command.shortcut}</kbd>
              ) : null}
            </button>
          ))}
        </div>
        <div className={styles.footer}>
          ↑ ↓ naviguer · ↵ exécuter
          <span>{t('shell.palette.escape')}</span>
        </div>
      </div>
    </div>
  )
}
