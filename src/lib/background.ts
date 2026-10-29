/** Workspace wallpaper: a local image or animated GIF behind the UI. */

import type { MediaSettings } from './mediaSettings'

/**
 * Paints the wallpaper through CSS custom properties instead of React style
 * props: the image is a `data:` URL that can be tens of megabytes, and setting
 * it on the root avoids diffing it on every render.
 */
export function applyBackground(
  settings: MediaSettings | null,
  dataUrl: string | null,
) {
  const root = document.documentElement
  if (!settings || !dataUrl) {
    delete root.dataset.background
    root.style.removeProperty('--app-bg-image')
    root.style.removeProperty('--app-bg-size')
    root.style.removeProperty('--app-bg-repeat')
    root.style.removeProperty('--app-bg-dim')
    root.style.removeProperty('--app-bg-blur')
    return
  }
  root.dataset.background = 'image'
  root.style.setProperty('--app-bg-image', `url("${dataUrl}")`)
  root.style.setProperty(
    '--app-bg-size',
    settings.fit === 'cover' ? 'cover' : settings.fit === 'contain' ? 'contain' : 'auto',
  )
  root.style.setProperty('--app-bg-repeat', settings.fit === 'tile' ? 'repeat' : 'no-repeat')
  root.style.setProperty('--app-bg-dim', String(settings.dim / 100))
  root.style.setProperty('--app-bg-blur', `${settings.blur}px`)
}
