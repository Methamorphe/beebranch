/** Lane-aligned fills from `src/styles/tokens.css` (--lane-1 … --lane-6). */
const PALETTE_DARK = [
  '#81a9ef',
  '#a48ae0',
  '#52c993',
  '#e66b75',
  '#f0a45b',
  '#7cb518',
] as const

const PALETTE_LIGHT = [
  '#2B7CB3',
  '#7B3FC4',
  '#007A7A',
  '#C23A78',
  '#C2410C',
  '#557D0F',
] as const

export function normalizeAuthorEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Stable 32-bit hash; same normalized email always maps to the same palette slot. */
export function hashAuthorEmail(normalized: string): number {
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mixHex(color: string, target: string, ratio: number): string {
  const from = parseHex(color)
  const to = parseHex(target)
  if (!from || !to) return color
  const channel = (index: number) =>
    Math.round(from[index]! + (to[index]! - from[index]!) * ratio)
  return `#${[channel(0), channel(1), channel(2)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

export function authorAvatarFill(email: string, light: boolean): string {
  const palette = light ? PALETTE_LIGHT : PALETTE_DARK
  const slot = hashAuthorEmail(normalizeAuthorEmail(email)) % palette.length
  const base = palette[slot] ?? palette[0]!
  // Light-theme lane tokens are mid-tone; nudge darker so initials stay readable.
  return light ? mixHex(base, '#000000', 0.18) : base
}

/** Initials on the avatar disc: first grapheme of first and last name word, else email local part. */
export function authorInitials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return (
      firstGrapheme(words[0]!) + firstGrapheme(words[words.length - 1]!)
    ).toUpperCase()
  }
  if (words.length === 1) {
    return takeGraphemes(words[0]!, 2).toUpperCase()
  }
  const local = email.split('@')[0] ?? email
  const alnum = local.replace(/[^\p{L}\p{N}]/gu, '')
  const fallback = takeGraphemes(alnum || local, 2)
  return fallback.toUpperCase() || '?'
}

function parseHex(value: string): [number, number, number] | null {
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

/** WCAG contrast ratio between a fill and a text color on top of it. */
export function authorAvatarContrastRatio(fill: string, label: string): number {
  const fillRgb = parseHex(fill)
  const labelRgb = parseHex(label)
  if (!fillRgb || !labelRgb) return 1
  const fillLum = relativeLuminance(fillRgb[0], fillRgb[1], fillRgb[2])
  const labelLum = relativeLuminance(labelRgb[0], labelRgb[1], labelRgb[2])
  const lighter = Math.max(fillLum, labelLum)
  const darker = Math.min(fillLum, labelLum)
  return (lighter + 0.05) / (darker + 0.05)
}

export function authorAvatarLabelColor(fill: string): string {
  const candidates: string[] = ['#171a1f', '#f4f6fa']
  let best = candidates[0]!
  let bestRatio = 0
  for (const label of candidates) {
    const ratio = authorAvatarContrastRatio(fill, label)
    if (ratio > bestRatio) {
      bestRatio = ratio
      best = label
    }
  }
  return best
}

function firstGrapheme(value: string): string {
  return takeGraphemes(value, 1)
}

function takeGraphemes(value: string, count: number): string {
  if (!value || count <= 0) return ''
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let taken = ''
    for (const { segment } of segmenter.segment(value)) {
      if (/[\p{L}\p{N}]/u.test(segment)) {
        taken += segment
        if (taken.length >= count) break
      }
    }
    if (taken) return taken.slice(0, count)
  }
  const chars = [...value]
  let taken = ''
  for (const char of chars) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      taken += char
      if (taken.length >= count) break
    }
  }
  return taken || chars.slice(0, count).join('')
}

export type AuthorAvatarStyle = {
  initials: string
  fill: string
  label: string
}

export function authorAvatarStyle(
  name: string,
  email: string,
  light: boolean,
): AuthorAvatarStyle {
  const fill = authorAvatarFill(email, light)
  return {
    initials: authorInitials(name, email),
    fill,
    label: authorAvatarLabelColor(fill),
  }
}

export const AUTHOR_AVATAR_PALETTE_DARK = PALETTE_DARK
export const AUTHOR_AVATAR_PALETTE_LIGHT = PALETTE_LIGHT
