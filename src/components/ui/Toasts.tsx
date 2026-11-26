import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { t } from '../../i18n'
import type { PresentedError } from '../../ipc/client'
import type { ErrorAction } from '../../lib/errorRecovery'
import { ToolbarIcon } from '../ToolbarIcon'
import styles from './Toasts.module.css'

export type ToastTone = 'success' | 'info' | 'error'

export type ToastNotice = PresentedError & { action?: ErrorAction }

export type ToastInput = {
  tone?: ToastTone
  message: string
  /** Structured failure: title, next step, collapsed detail. */
  notice?: ToastNotice
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
const LIFETIME: Record<ToastTone, number | null> = { success: 5000, info: 5000, error: null }
const ACTION_LIFETIME = 9000
const MAX_VISIBLE = 4

const ICONS: Record<ToastTone, 'check' | 'info' | 'warning'> = {
  success: 'check',
  info: 'info',
  error: 'warning',
}

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
          <ToastItem key={toast.id} toast={toast} onClose={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const [paused, setPaused] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const lifetime = toast.action ? ACTION_LIFETIME : LIFETIME[toast.tone]
  const remaining = useRef(lifetime ?? 0)
  const startedAt = useRef(0)
  const toastId = toast.id

  useEffect(() => {
    if (lifetime === null) return
    if (paused) {
      if (startedAt.current > 0) {
        remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt.current))
        startedAt.current = 0
      }
      return
    }
    startedAt.current = performance.now()
    const timer = window.setTimeout(() => onClose(toastId), remaining.current)
    return () => window.clearTimeout(timer)
  }, [lifetime, paused, onClose, toastId])

  const title = toast.notice?.message ?? toast.message
  const subtitle = toast.notice?.remediation ?? null
  const technical = toast.notice
    ? [toast.notice.detail, toast.notice.code].filter((part) => part && part.length > 0).join('\n\n')
    : ''
  const noticeAction = toast.notice?.action
  const undoAction = toast.notice ? undefined : toast.action

  return (
    <div
      className={styles.toast}
      data-tone={toast.tone}
      data-paused={paused ? 'true' : undefined}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      style={
        lifetime !== null
          ? ({ '--toast-lifetime': `${lifetime}ms` } as CSSProperties)
          : undefined
      }
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToolbarIcon name={ICONS[toast.tone]} size={16} />
      </span>
      <div className={styles.body}>
        <p className={styles.title} title={title}>
          {title}
        </p>
        {subtitle ? (
          <p className={styles.subtitle} title={subtitle}>
            {subtitle}
          </p>
        ) : null}
        {noticeAction || undoAction || technical ? (
          <div className={styles.footer}>
            {noticeAction ? (
              <button type="button" className={styles.action} onClick={noticeAction.run}>
                {noticeAction.label}
              </button>
            ) : null}
            {undoAction ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  undoAction.run()
                  onClose(toast.id)
                }}
              >
                {undoAction.label}
              </button>
            ) : null}
            {technical ? (
              <button
                type="button"
                className={styles.details}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((value) => !value)}
              >
                {detailsOpen ? t('common.hide') : t('common.details')}
              </button>
            ) : null}
          </div>
        ) : null}
        {detailsOpen && technical ? <pre className={styles.output}>{technical}</pre> : null}
      </div>
      <button type="button" className={styles.close} aria-label={t('common.close')} onClick={() => onClose(toast.id)}>
        <ToolbarIcon name="x" size={14} />
      </button>
      {lifetime !== null ? (
        <span className={styles.timer} aria-hidden="true">
          <span />
        </span>
      ) : null}
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
export function useToastChannel(
  channel: string,
  tone: ToastTone,
): (message: string | ToastNotice | null) => void {
  const { show, dismiss } = useToasts()
  return useCallback(
    (message: string | ToastNotice | null) => {
      if (!message) {
        dismiss(channel)
        return
      }
      if (typeof message === 'string') {
        show({ tone, message, channel })
        return
      }
      show({ tone, message: message.message, notice: message, channel })
    },
    [channel, tone, show, dismiss],
  )
}
