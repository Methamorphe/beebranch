import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './ContextMenu.module.css'

export function ContextMenu({ x, y, title, subtitle, children, onClose }: {
  x: number; y: number; title: string; subtitle: string; children: ReactNode; onClose: () => void
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
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) close.current()
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
  return createPortal(<div ref={ref} className={styles.menu} role="menu" aria-label="Actions sur le commit"
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
