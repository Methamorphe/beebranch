import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { clamp } from '../lib/layout'
import styles from './Resizer.module.css'

type Props = {
  label: string
  value: number
  min: number
  max: number
  /** Side of the handle the resizable panel sits on. */
  side: 'left' | 'right'
  onChange: (value: number) => void
  onReset?: () => void
  className?: string
  style?: CSSProperties
}

/** Vertical splitter: drag, arrow keys (Shift for a wider step), or reset. */
export function Resizer({
  label,
  value,
  min,
  max,
  side,
  onChange,
  onReset,
  className,
  style,
}: Props) {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ x: 0, value: 0 })
  const ceiling = Math.max(min, max)
  const direction = side === 'right' ? 1 : -1
  // The parent re-renders on every width change; keep the drag listeners and
  // the body cursor stable for the whole gesture.
  const live = useRef({ onChange, min, ceiling, direction })
  useEffect(() => {
    live.current = { onChange, min, ceiling, direction }
  })

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      const latest = live.current
      const delta = (event.clientX - start.current.x) * latest.direction
      latest.onChange(
        clamp(start.current.value + delta, latest.min, latest.ceiling),
      )
    }
    const stop = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
    }
  }, [dragging])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * direction * step
      onChange(clamp(value + delta, min, ceiling))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      onChange(event.key === 'Home' ? min : ceiling)
    }
  }

  return (
    <div
      className={`${styles.handle} ${className ?? ''}`}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={ceiling}
      aria-valuetext={`${Math.round(value)} px`}
      tabIndex={0}
      data-dragging={dragging ? 'true' : undefined}
      title={`${label} — glisser ou utiliser les flèches`}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        start.current = { x: event.clientX, value }
        setDragging(true)
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onReset?.()}
    />
  )
}
