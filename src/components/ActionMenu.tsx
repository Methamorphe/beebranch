import { useId, useRef, type ReactNode } from 'react'
import styles from './ActionMenu.module.css'

export function ActionMenu({ label, children, triggerContent, triggerClassName, disabled = false }: { label: string; children: ReactNode; triggerContent?: ReactNode; triggerClassName?: string; disabled?: boolean }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={trigger} type="button" onClick={(event) => event.currentTarget.focus()} disabled={disabled} className={`${styles.trigger} ${triggerClassName ?? ''}`} popoverTarget={id} aria-label={label} title={triggerContent ? label : 'Autres actions'}>{triggerContent ?? '···'}</button>
    <div id={id} popover="auto" className={styles.menu} aria-label={label}
      onToggle={(event) => {
        if (event.newState !== 'open' || !trigger.current) return
        const rect = trigger.current.getBoundingClientRect()
        const menu = event.currentTarget
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`
        menu.style.top = `${rect.bottom + menu.offsetHeight + 8 > window.innerHeight ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) event.currentTarget.hidePopover()
      }}>
      {children}
    </div>
  </>
}
