import { useEffect, useId, useRef, type ReactNode } from 'react'
import styles from './ActionMenu.module.css'

export function ActionMenu({ label, children, triggerContent, triggerClassName, disabled = false, onOpen }: { label: string; children: ReactNode; triggerContent?: ReactNode; triggerClassName?: string; disabled?: boolean; onOpen?: () => void }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const position = () => {
    if (!trigger.current || !menu.current) return
    const rect = trigger.current.getBoundingClientRect()
    const element = menu.current
    element.style.left = `${Math.max(8, Math.min(window.innerWidth - element.offsetWidth - 8, rect.right - element.offsetWidth))}px`
    element.style.top = `${rect.bottom + element.offsetHeight + 8 > window.innerHeight ? Math.max(8, rect.top - element.offsetHeight - 6) : rect.bottom + 6}px`
  }
  useEffect(() => {
    const element = menu.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.matches(':popover-open')) position()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <>
    <button ref={trigger} type="button" onClick={(event) => event.currentTarget.focus()} disabled={disabled} className={`${styles.trigger} ${triggerClassName ?? ''}`} popoverTarget={id} aria-label={label} title={triggerContent ? label : 'Autres actions'}>{triggerContent ?? '···'}</button>
    <div ref={menu} id={id} popover="auto" className={styles.menu} aria-label={label}
      onToggle={(event) => {
        if (event.newState !== 'open' || !trigger.current) return
        onOpen?.()
        position()
        window.requestAnimationFrame(position)
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) event.currentTarget.hidePopover()
      }}>
      {children}
    </div>
  </>
}
