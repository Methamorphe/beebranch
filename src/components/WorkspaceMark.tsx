import { useEffect, useState } from 'react'
import { workspaceIconImage } from '../ipc/commands'
import {
  cachedWorkspaceImage,
  rememberWorkspaceImage,
  workspaceLucideIcon,
  workspaceMonogram,
} from '../lib/workspaceIcon'
import type { WorkspaceIconKind } from '../types/git'
import { AppIcon } from './IconSvg'
import styles from './WorkspaceMark.module.css'

type Props = {
  name: string
  iconKind?: WorkspaceIconKind | null
  iconKey?: string | null
  workspaceId?: string
  updatedAt?: number
  /** Unsaved preview. Skips the stored file. */
  imageUrl?: string | null
  size?: number
}

/**
 * Fixed frame for a workspace: a Lucide icon, a cover-cropped image, or the
 * first letter of the name. The frame never changes size.
 */
export function WorkspaceMark({
  name,
  iconKind,
  iconKey,
  workspaceId,
  updatedAt = 0,
  imageUrl,
  size = 28,
}: Props) {
  const lucide = iconKind === 'lucide' ? workspaceLucideIcon(iconKey) : null
  const cached = !imageUrl && iconKind === 'image' && workspaceId
    ? cachedWorkspaceImage(workspaceId, updatedAt)
    : undefined
  const requestKey = `${workspaceId ?? ''}:${updatedAt}`
  const [fetched, setFetched] = useState<{ key: string; url: string } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)

  useEffect(() => {
    if (imageUrl || iconKind !== 'image' || !workspaceId || cached) return
    let cancelled = false
    void workspaceIconImage(workspaceId)
      .then((url) => {
        if (cancelled) return
        if (!url) {
          setFailedKey(requestKey)
          return
        }
        rememberWorkspaceImage(workspaceId, updatedAt, url)
        setFetched({ key: requestKey, url })
      })
      .catch(() => {
        if (!cancelled) setFailedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [imageUrl, iconKind, workspaceId, updatedAt, cached, requestKey])

  const storedUrl = cached ?? (fetched?.key === requestKey ? fetched.url : null)
  const failed = failedKey === requestKey
  const photo = failed ? null : imageUrl || storedUrl
  const showPhoto = iconKind === 'image' && Boolean(photo)

  return (
    <span
      className={styles.mark}
      style={{ ['--mark-size' as string]: `${size}px` }}
      aria-hidden="true"
    >
      {showPhoto ? (
        <img src={photo ?? undefined} alt="" onError={() => setFailedKey(requestKey)} />
      ) : lucide ? (
        <AppIcon icon={lucide} size={Math.max(10, Math.round(size * 0.58))} />
      ) : (
        <span className={styles.letter}>{workspaceMonogram(name)}</span>
      )}
    </span>
  )
}
