import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './ContextMenu.module.css'

export function ContextMenu({ x, y, title, subtitle, ariaLabel, children, onClose }: {
  x: number; y: number; title: string; subtitle: string; ariaLabel?: string; children: ReactNode; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const place = () => {
      const bounds = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`
    }
    place()
    menu.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    // Submenus are portaled next to the menu: a click inside one is not outside.
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || menu.contains(event.target) || event.target.closest('[data-context-submenu]')) return
      close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); close.current()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', place)
      if (previous?.isConnected) previous.focus()
    }
  }, [x, y])
  return createPortal(<div ref={ref} className={styles.menu} role="menu" aria-label={ariaLabel ?? t('shell.contextMenu.aria')}
    onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLInputElement) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }}>
    <div className={styles.heading}><code>{title}</code><span title={subtitle}>{subtitle}</span></div>
    {children}
  </div>, document.body)
}

const SUBMENU_CLOSE_DELAY = 260

/**
 * A menu item that opens a nested menu to its right (left when there is no
 * room). It opens on hover, Enter, Space or ArrowRight; ArrowLeft returns to
 * the trigger. `className` styles the trigger like its sibling items.
 */
export function ContextSubmenu({ label, leading, className, disabled = false, children }: {
  label: string
  leading?: ReactNode
  className?: string
  disabled?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const focusFirst = useRef(false)
  const keepOpen = () => window.clearTimeout(closeTimer.current)
  const closeSoon = () => {
    keepOpen()
    closeTimer.current = window.setTimeout(() => setOpen(false), SUBMENU_CLOSE_DELAY)
  }
  useEffect(() => keepOpen, [])
  useLayoutEffect(() => {
    const element = panel.current
    const anchor = trigger.current
    if (!open || !element || !anchor) return
    const rect = anchor.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    const right = rect.right + 4
    element.style.left = `${right + bounds.width + 8 <= window.innerWidth ? right : Math.max(8, rect.left - bounds.width - 4)}px`
    element.style.top = `${Math.max(8, Math.min(rect.top - 5, window.innerHeight - bounds.height - 8))}px`
    if (focusFirst.current) {
      focusFirst.current = false
      element.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    }
  }, [open])
  const openWithKeyboard = () => {
    keepOpen()
    focusFirst.current = true
    if (open) panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    else setOpen(true)
  }
  return <>
    <button ref={trigger} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open}
      className={`${className ?? ''} ${styles.submenuTrigger}`} disabled={disabled}
      onPointerEnter={() => { keepOpen(); setOpen(true) }} onPointerLeave={closeSoon}
      onClick={openWithKeyboard}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight') return
        event.preventDefault(); event.stopPropagation(); openWithKeyboard()
      }}>
      <span className={styles.submenuLead}>
        {leading}
        <span>{label}</span>
      </span>
      <span className={styles.chevron} aria-hidden="true"><ToolbarIcon name="chevronRight" size={12} /></span>
    </button>
    {open ? createPortal(<div ref={panel} className={`${styles.menu} ${styles.submenu}`} role="menu" aria-label={label}
      data-context-submenu="" onPointerEnter={keepOpen} onPointerLeave={closeSoon}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation()
          setOpen(false); trigger.current?.focus()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}>
      {children}
    </div>, document.body) : null}
  </>
}
