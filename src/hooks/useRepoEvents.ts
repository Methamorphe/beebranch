import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { ChangeEvent } from '../types/git'

export function useRepoEvents(
  repoId: string | null,
  onChanged: (event: ChangeEvent) => void,
): void {
  useEffect(() => {
    if (!repoId) {
      return
    }
    let disposed = false
    let unlisten: (() => void) | undefined

    void listen<ChangeEvent>('repo://changed', (event) => {
      if (!disposed && event.payload.repoId === repoId) {
        onChanged(event.payload)
      }
    }).then((stop) => {
      if (disposed) {
        stop()
      } else {
        unlisten = stop
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [repoId, onChanged])
}
