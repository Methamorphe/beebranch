import { useCallback, useEffect, useState } from 'react'
import { preferenceGet, preferenceSet } from '../ipc/commands'
import {
  DIFF_MODE_PREFERENCE,
  applyStoredDiffMode,
  diffModeEpoch,
  getDiffMode,
  onDiffModeChanged,
  rememberDiffMode,
  type DiffMode,
} from './diffMode'

/**
 * Diff view mode shared by every viewer. Choosing a mode writes the user
 * preference; remounts restore it immediately from the cache.
 */
export function useDiffMode(): [DiffMode, (mode: DiffMode) => void] {
  const [mode, setMode] = useState(getDiffMode)

  useEffect(() => onDiffModeChanged(setMode), [])

  useEffect(() => {
    const epoch = diffModeEpoch()
    let cancelled = false
    void preferenceGet(DIFF_MODE_PREFERENCE)
      .then((raw) => {
        if (!cancelled) applyStoredDiffMode(raw, epoch)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const choose = useCallback((next: DiffMode) => {
    rememberDiffMode(next)
    void preferenceSet(DIFF_MODE_PREFERENCE, next).catch(() => undefined)
  }, [])

  return [mode, choose]
}
