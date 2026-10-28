import type { ButtonHTMLAttributes, ReactNode } from 'react'
import shared from '../p1.module.css'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary: shared.primary,
  secondary: shared.secondary,
  danger: shared.dangerButton,
  ghost: shared.small,
}

/** Design-system button: one visual contract for every action. */
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      className={[VARIANTS[variant], size === 'sm' ? shared.small : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  )
}
