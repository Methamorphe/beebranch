import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'

/** Interface zoom bounds, as fractions of the native size. */
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2
export const ZOOM_STEP = 0.1

/** Keep the zoom level on a step grid inside the allowed range. */
export function clampZoom(level: number): number {
  const snapped = Math.round(level * 100) / 100
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, snapped))
}

/**
 * Keyboard-only interface zoom: ⌘/Ctrl + `+`, `-`, and `0`.
 *
 * Mouse wheel and trackpad pinch are intentionally absent: scrolling must never
 * change the interface zoom. Bounds and step live here rather than in Tauri's
 * `zoomHotkeysEnabled` polyfill (20%–1000%, wheel included), which stays off.
 */
export function installZoomControls(): () => void {
  let level = 1
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) {
      return
    }
    const key = event.key
    const zoomIn = key === '+' || key === '='
    const zoomOut = key === '-' || key === '_'
    if (key !== '0' && !zoomIn && !zoomOut) {
      return
    }
    event.preventDefault()
    level = key === '0' ? 1 : clampZoom(level + (zoomIn ? ZOOM_STEP : -ZOOM_STEP))
    if (!isTauri()) {
      return
    }
    void getCurrentWebview().setZoom(level).catch((cause: unknown) => {
      console.error('Réglage du zoom impossible', cause)
    })
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
