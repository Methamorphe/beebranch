/** Workspace wallpaper: a local image or animated GIF behind the UI. */

import type { MediaSettings } from './mediaSettings'

/**
 * Image last written on a layer. Fit, dim and blur fire continuously while a
 * slider is dragged: repainting the same `data:` URL each time would re-parse
 * a payload that can reach tens of megabytes.
 */
let painted: { layer: HTMLElement; url: string } | null = null

/**
 * Paints the wallpaper on its own layer, keeping only the presentation options
 * in CSS custom properties.
 *
 * The image used to travel through a `--app-bg-image` custom property, but
 * Chromium silently drops every custom property value above 2 MiB — smaller
 * than the base64 of an ordinary photo — so the wallpaper never appeared on
 * Windows (WebView2) while WebKit accepted it. A plain `background-image` on
 * the layer has no such cap, and writing it on the DOM node keeps the data URL
 * out of React's diff, which is why the variables were used in the first place.
 */
export function applyBackground(
  settings: MediaSettings | null,
  dataUrl: string | null,
  layer: HTMLElement | null,
) {
  const root = document.documentElement
  if (layer && (painted?.layer !== layer || painted.url !== dataUrl)) {
    layer.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : ''
    painted = dataUrl ? { layer, url: dataUrl } : null
  }
  if (!dataUrl) {
    // The layer unmounts when the wallpaper is cleared: drop the reference so a
    // tens-of-megabytes URL is not kept alive.
    painted = null
  }
  if (!settings || !dataUrl) {
    delete root.dataset.background
    root.style.removeProperty('--app-bg-size')
    root.style.removeProperty('--app-bg-repeat')
    root.style.removeProperty('--app-bg-dim')
    root.style.removeProperty('--app-bg-blur')
    return
  }
  root.dataset.background = 'image'
  root.style.setProperty(
    '--app-bg-size',
    settings.fit === 'cover' ? 'cover' : settings.fit === 'contain' ? 'contain' : 'auto',
  )
  root.style.setProperty('--app-bg-repeat', settings.fit === 'tile' ? 'repeat' : 'no-repeat')
  root.style.setProperty('--app-bg-dim', String(settings.dim / 100))
  root.style.setProperty('--app-bg-blur', `${settings.blur}px`)
}
