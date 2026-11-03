import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ToolbarIcon } from '../ToolbarIcon'
import styles from './ActionBar.module.css'

type SlotContextValue = {
  slot: HTMLElement | null
  setSlot: (element: HTMLElement | null) => void
}

const SlotContext = createContext<SlotContextValue>({ slot: null, setSlot: () => {} })

/** Owns the place where every action bar is rendered. */
export function ActionBarProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ slot, setSlot }), [slot])
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>
}

/** Mount point at the top of the main area; bars stack in opening order. */
export function ActionBarSlot() {
  const { setSlot } = useContext(SlotContext)
  return <div ref={setSlot} className={styles.slot} />
}

type Props = {
  tone?: 'primary' | 'danger'
  title: ReactNode
  /** Consequence, counts or choices shown under the title. */
  children?: ReactNode
  /** Buttons, the confirming one last. */
  actions: ReactNode
  busy?: boolean
  /** Changing it moves focus again (e.g. when the bar enters its warning step). */
  focusKey?: string
  onCancel: () => void
}

/**
 * Non-modal decision bar shown above the workspace instead of a dialog.
 *
 * It takes focus when it opens (`[data-autofocus]` first), cancels on Escape
 * and gives focus back to its trigger when it closes. Without a slot (a panel
 * rendered on its own) it renders in place.
 */
export function ActionBar({
  tone = 'primary',
  title,
  children,
  actions,
  busy = false,
  focusKey,
  onCancel,
}: Props) {
  const { slot } = useContext(SlotContext)
  const ref = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const active = document.activeElement
      if (previous?.isConnected && (!active || active === document.body)) previous.focus()
    }
  }, [])

  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    const enabled = [...(actionsRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    const target = bar.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? enabled.at(-1) ?? bar
    target.focus()
  }, [focusKey, slot])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onCancel()
  }

  const bar = (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      data-tone={tone}
      className={styles.bar}
      onKeyDown={onKeyDown}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToolbarIcon name={tone === 'danger' ? 'warning' : 'info'} />
      </span>
      <div className={styles.body}>
        <p id={titleId} className={styles.title}>{title}</p>
        {children ? <div className={styles.detail}>{children}</div> : null}
      </div>
      <div ref={actionsRef} className={styles.actions}>{actions}</div>
    </div>
  )

  return slot ? createPortal(bar, slot) : bar
}
