/**
 * WCAG 2.1 luminance and contrast, shared by the canvas paints (reference
 * pills, author avatars). Text drawn on a saturated fill must pick the ink
 * with the higher ratio: a fixed near-white label reads fine on a dark lane
 * hue but disappears on the light ones (#ffd257, #2fd39a).
 */

export function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace('#', '')
  const full =
    hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const number = Number.parseInt(full, 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const channel = (value: number) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  )
}

/** WCAG contrast ratio between a fill and a text color drawn on top of it. */
export function contrastRatio(fill: string, label: string): number {
  const fillRgb = parseHexColor(fill)
  const labelRgb = parseHexColor(label)
  if (!fillRgb || !labelRgb) return 1
  const fillLum = relativeLuminance(fillRgb[0], fillRgb[1], fillRgb[2])
  const labelLum = relativeLuminance(labelRgb[0], labelRgb[1], labelRgb[2])
  const lighter = Math.max(fillLum, labelLum)
  const darker = Math.min(fillLum, labelLum)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Ink with the higher contrast on `fill`: the dark ink or the near-white one. */
export function readableTextColor(
  fill: string,
  darkInk = '#101216',
  lightInk = '#f4f6fa',
): string {
  return contrastRatio(fill, darkInk) >= contrastRatio(fill, lightInk) ? darkInk : lightInk
}

/** Best ratio either ink reaches on `fill`. */
export function bestInkRatio(fill: string): number {
  return Math.max(contrastRatio(fill, '#101216'), contrastRatio(fill, '#f4f6fa'))
}

/**
 * Solid fill for a reference pill, keeping the hue of its rail.
 *
 * Two light-theme lanes (#2B7CB3, #557D0F) sit between the dark and the
 * near-white ink: neither reaches 4.5:1 on them, so the fill steps 4 % towards
 * black until one ink clears WCAG AA — the pill stays the colour of its line
 * while the label stays readable. Fills that already pass are returned as is.
 *
 * The history canvas asks for the same handful of token colours on every
 * frame, so results are memoised instead of re-parsing them per pill.
 */
const pillCache = new Map<string, string>()

export function pillFill(color: string, target = 4.5): string {
  const key = `${color}|${target}`
  const cached = pillCache.get(key)
  if (cached !== undefined) return cached
  let fill = color
  let rgb = parseHexColor(fill)
  for (let step = 0; step < 24 && rgb && bestInkRatio(fill) < target; step += 1) {
    rgb = rgb.map((channel) => Math.round(channel * 0.96)) as [number, number, number]
    fill = `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  pillCache.set(key, fill)
  return fill
}
