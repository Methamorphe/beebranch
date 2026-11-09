import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { t } from '../../i18n'
import { ToolbarIcon } from '../ToolbarIcon'
import styles from './Toasts.module.css'

export type ToastTone = 'success' | 'info' | 'error'

export type ToastInput = {
  tone?: ToastTone
  message: string
  /** Optional button, e.g. "Undo"; running it closes the toast. */
  action?: { label: string; run: () => void }
  /**
   * A channel holds at most one toast: a new message replaces the previous
   * one and `dismiss(channel)` clears it, like the banner it replaces.
   */
  channel?: string
}

type Toast = ToastInput & { id: number; tone: ToastTone }

type ToastApi = {
  show: (toast: ToastInput) => void
  dismiss: (channel: string) => void
}

/** Successes fade on their own; errors stay until the user closes them. */
const LIFETIME: Record<ToastTone, number | null> = { success: 5000, info: 6000, error: null }
const ACTION_LIFETIME = 9000
const MAX_VISIBLE = 4

const ToastContext = createContext<ToastApi>({ show: () => {}, dismiss: () => {} })

/** Owns the toast list and renders the viewport at the bottom centre. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback((input: ToastInput) => {
    const toast: Toast = { ...input, tone: input.tone ?? 'info', id: nextId.current++ }
    setToasts((current) => {
      const kept = input.channel
        ? current.filter((existing) => existing.channel !== input.channel)
        : current
      return [...kept, toast].slice(-MAX_VISIBLE)
    })
  }, [])

  const dismiss = useCallback((channel: string) => {
    setToasts((current) => current.filter((toast) => toast.channel !== channel))
  }, [])

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.viewport} data-toasts="">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => remove(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [paused, setPaused] = useState(false)
  const lifetime = toast.action ? ACTION_LIFETIME : LIFETIME[toast.tone]

  useEffect(() => {
    if (lifetime === null || paused) return
    const timer = window.setTimeout(onClose, lifetime)
    return () => window.clearTimeout(timer)
  }, [lifetime, paused, onClose])

  return (
    <div
      className={styles.toast}
      data-tone={toast.tone}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.message}>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            toast.action?.run()
            onClose()
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className={styles.close} aria-label={t('common.close')} onClick={onClose}>
        <ToolbarIcon name="x" size={14} />
      </button>
    </div>
  )
}

export function useToasts(): ToastApi {
  return useContext(ToastContext)
}

/**
 * Drop-in replacement for a `useState<string | null>` banner: a message shows
 * a toast on `channel`, `null` dismisses it.
 */
export function useToastChannel(channel: string, tone: ToastTone): (message: string | null) => void {
  const { show, dismiss } = useToasts()
  return useCallback(
    (message: string | null) => {
      if (message) show({ tone, message, channel })
      else dismiss(channel)
    },
    [channel, tone, show, dismiss],
  )
}
