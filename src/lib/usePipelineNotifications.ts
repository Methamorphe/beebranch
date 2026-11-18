import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import {
  notificationPermission,
  notificationShow,
  pipelineOverview,
  preferenceGet,
  type NotificationPermission,
} from '../ipc/commands'
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

let prepared: NotificationPermission | null = null

/**
 * Asks the operating system when it actually has a permission dialog.
 *
 * The Tauri plugin always answers "granted" on desktop and never prompts.
 * A bundled Mac app goes through UNUserNotificationCenter, which shows the
 * system dialog. Windows toasts have no dialog. A Mac development build
 * keeps the plugin, which posts as Terminal.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  prepared = await notificationPermission()
  if (!prepared.granted) return false
  if (prepared.channel !== 'plugin') return true
  const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
  if (await isPermissionGranted()) return true
  return (await requestPermission()) === 'granted'
}

async function desktopNotify(title: string, body: string): Promise<void> {
  if (!prepared) {
    const allowed = await ensureNotificationPermission()
    if (!allowed) return
  }
  if (!prepared?.granted) return
  if (prepared.channel === 'plugin') {
    const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
    if (!(await isPermissionGranted())) return
    sendNotification({ title, body })
    return
  }
  await notificationShow(title, body)
}

/** Posts one toast so enabling the preference proves the path is live. */
export async function announceNotificationsEnabled(title: string, body: string): Promise<void> {
  await desktopNotify(title, body)
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
          try {
            await desktopNotify(t(pipelineFailureTitleKey()), pipelineFailureBody(failure, t))
          } catch {
            // A refused toast must not stop the watch. The settings toggle
            // reports the same failure when the preference is turned on.
          }
        }
      }
    }
    const arm = () => {
      window.clearInterval(timer)
      if (!pipelineNotifyEnabled()) return
      void (async () => {
        const allowed = await ensureNotificationPermission().catch(() => false)
        if (cancelled || !allowed || !pipelineNotifyEnabled()) return
        await tick()
        if (cancelled) return
        timer = window.setInterval(() => void tick(), REFRESH_MS)
      })()
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
