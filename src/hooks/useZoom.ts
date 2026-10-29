import { useEffect } from 'react'
import { installZoomControls } from '../lib/zoom'

/** Global keyboard zoom, bounded by MIN_ZOOM / MAX_ZOOM. */
export function useZoom() {
  useEffect(() => installZoomControls(), [])
}
