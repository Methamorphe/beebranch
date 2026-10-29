/**
 * Settings for a user-supplied image (workspace wallpaper or boot splash).
 *
 * The schema is shared by both preferences so the splash page and the settings
 * UI cannot drift: only the file path and the presentation options are stored,
 * never the image itself.
 */

export type MediaFit = 'cover' | 'contain' | 'tile'

export type MediaSettings = {
  /** Absolute path of the file chosen through the native dialog. */
  path: string
  fit: MediaFit
  /** 0–90: opacity of the scrim painted over the image, in percent. */
  dim: number
  /** 0–24: gaussian blur applied to the image, in pixels. */
  blur: number
}

export type MediaOptions = Omit<MediaSettings, 'path'>

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  fit: 'cover',
  dim: 45,
  blur: 0,
}

export const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']

export const BACKGROUND_KEY = 'ui.background'
export const SPLASH_KEY = 'ui.splash'

const FITS: MediaFit[] = ['cover', 'contain', 'tile']

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

export function normalizeMediaOptions(
  value: Partial<MediaOptions> | null | undefined,
): MediaOptions {
  return {
    fit: FITS.includes(value?.fit as MediaFit)
      ? (value!.fit as MediaFit)
      : DEFAULT_MEDIA_OPTIONS.fit,
    dim: clamp(value?.dim ?? DEFAULT_MEDIA_OPTIONS.dim, 0, 90),
    blur: clamp(value?.blur ?? DEFAULT_MEDIA_OPTIONS.blur, 0, 24),
  }
}

/** Stored preferences are user-editable; a corrupt value must never break boot. */
export function parseMediaSettings(raw: string | null): MediaSettings | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<MediaSettings> | null
    if (!value || typeof value.path !== 'string' || value.path.trim() === '') {
      return null
    }
    return { path: value.path, ...normalizeMediaOptions(value) }
  } catch {
    return null
  }
}

export function serializeMediaSettings(settings: MediaSettings | null) {
  return settings ? JSON.stringify(settings) : ''
}

/** File name shown in Settings; the full path stays in the tooltip. */
export function mediaLabel(path: string) {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}
