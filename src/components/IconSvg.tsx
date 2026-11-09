import type { LucideIcon } from 'lucide-react'

/** Lucide default is 2; 1.5 keeps the glyphs light once CSS scales them. */
export const ICON_STROKE = 1.5

export function AppIcon({
  icon: Icon,
  size,
  className,
  fill,
}: {
  icon: LucideIcon
  size: number
  className?: string
  fill?: string
}) {
  return (
    <Icon
      size={size}
      strokeWidth={ICON_STROKE}
      nonScalingStroke
      className={className}
      fill={fill ?? 'none'}
      aria-hidden="true"
    />
  )
}
