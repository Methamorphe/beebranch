import type { ReactNode } from 'react'
import { useModal } from '../../hooks/useModal'
import shared from '../p1.module.css'

type Props = {
  open: boolean
  onClose: () => void
  busy?: boolean
  titleId: string
  kind?: 'dialog' | 'alertdialog'
  children: ReactNode
  className?: string
}

/**
 * Single modal primitive: focus trap, focus restore, Escape and inert
 * background. Every dialog in the application uses it.
 */
export function Dialog({
  open,
  onClose,
  busy = false,
  titleId,
  kind = 'dialog',
  children,
  className,
}: Props) {
  const ref = useModal(open, onClose, busy)
  if (!open) {
    return null
  }
  return (
    <div className={shared.dialogBackdrop} role="presentation">
      <div
        ref={ref}
        tabIndex={-1}
        className={[shared.dialog, className].filter(Boolean).join(' ')}
        role={kind}
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {children}
      </div>
    </div>
  )
}
