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

export function authorAvatarFill(email: string, light: boolean): string {
  const palette = light ? PALETTE_LIGHT : PALETTE_DARK
  const slot = hashAuthorEmail(normalizeAuthorEmail(email)) % palette.length
  return palette[slot] ?? palette[0]!
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

export function authorAvatarLabelColor(light: boolean): string {
  return light ? '#ffffff' : '#171a1f'
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
  return {
    initials: authorInitials(name, email),
    fill: authorAvatarFill(email, light),
    label: authorAvatarLabelColor(light),
  }
}
