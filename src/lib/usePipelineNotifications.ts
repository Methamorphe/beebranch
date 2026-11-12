import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { pipelineOverview, preferenceGet } from '../ipc/commands'
import {
  collectPipelineFailures,
  onPipelineNotifyChanged,
  PIPELINE_NOTIFY_PREFERENCE,
  pipelineFailureBody,
  pipelineFailureTitleKey,
  pipelineNotifyEnabled,
  setPipelineNotifyEnabled,
} from './pipelineNotify'

const REFRESH_MS = 30_000

type OpenRepo = { repo: { repoId: string; name: string } }

/** Asks the operating system, once, before the first toast. */
export async function ensureNotificationPermission(): Promise<boolean> {
  const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
  if (await isPermissionGranted()) return true
  return (await requestPermission()) === 'granted'
}

async function desktopNotify(title: string, body: string): Promise<void> {
  const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
  if (!(await isPermissionGranted())) return
  sendNotification({ title, body })
}

/**
 * While BeeBranch is open and the preference is on, watch the pipelines of
 * every open repository and post a system notification when one fails.
 */
export function usePipelineFailureNotifications(repos: OpenRepo[]): void {
  const reposRef = useRef(repos)
  reposRef.current = repos
  const { t } = useI18n()
  const seen = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const tick = async () => {
      if (!pipelineNotifyEnabled()) return
      for (const entry of reposRef.current) {
        let overview = null
        try {
          overview = await pipelineOverview(entry.repo.repoId)
        } catch {
          continue
        }
        if (!overview || cancelled) continue
        const notices = collectPipelineFailures(
          entry.repo.repoId,
          entry.repo.name,
          overview.pipelines,
          seen.current,
        )
        for (const failure of notices) {
          await desktopNotify(t(pipelineFailureTitleKey()), pipelineFailureBody(failure, t))
        }
      }
    }
    const arm = () => {
      window.clearInterval(timer)
      if (!pipelineNotifyEnabled()) return
      void tick()
      timer = window.setInterval(() => void tick(), REFRESH_MS)
    }
    void preferenceGet(PIPELINE_NOTIFY_PREFERENCE)
      .then((raw) => {
        if (cancelled) return
        setPipelineNotifyEnabled(raw === '1')
        arm()
      })
      .catch(() => undefined)
    const unsubscribe = onPipelineNotifyChanged(() => {
      seen.current = new Map()
      arm()
    })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [t])
}
