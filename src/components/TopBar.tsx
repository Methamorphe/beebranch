import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { RepoView } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { Brand } from './Brand'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './TopBar.module.css'

export type TabDropSide = 'before' | 'after'

type Props = {
  repos: RepoView[]
  activeId: string | null
  busy: boolean
  onActivate: (repoId: string) => void
  onClose: (repoId: string) => void
  onReorder: (repoId: string, targetId: string, side: TabDropSide) => void
  onOpenDialog: () => void
  launcherOpen: boolean
  onAdd: () => void
  onCloseLauncher: () => void
  onSettings: () => void
  updateVersion?: string | null
  updateBusy?: boolean
  onInstallUpdate?: () => void
  user?: string | null
  /** Active workspace switcher, rendered next to the open tabs. */
  workspaceSelector?: ReactNode
}

/** Pixels the pointer must travel before a press becomes a tab drag. */
const DRAG_THRESHOLD = 4

export function TopBar({ repos, activeId, busy, onActivate, onClose, onReorder, onOpenDialog, launcherOpen, onAdd, onCloseLauncher, onSettings, updateVersion, updateBusy = false, onInstallUpdate, user, workspaceSelector }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; side: TabDropSide } | null>(null)
  const { t } = useI18n()
  const suppressClick = useRef(false)
  const tabs = useRef(new Map<string, HTMLDivElement>())
  const order = useRef<string[]>([])
  const endDrag = useRef<(() => void) | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const live = useRef({ onReorder, onClose, busy })
  // Live values for the gesture, which outlives the render that started it.
  useEffect(() => {
    order.current = repos.map((entry) => entry.repo.repoId)
    live.current = { onReorder, onClose, busy }
  })

  const dropAt = (clientX: number): { id: string; side: TabDropSide } | null => {
    for (const id of order.current) {
      const element = tabs.current.get(id)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right) continue
      return { id, side: clientX < rect.left + rect.width / 2 ? 'before' : 'after' }
    }
    // Past either edge: dock at the first or last tab.
    const firstId = order.current[0]
    const lastId = order.current.at(-1)
    const first = firstId ? tabs.current.get(firstId) : undefined
    const last = lastId ? tabs.current.get(lastId) : undefined
    if (first && clientX < first.getBoundingClientRect().left) return { id: firstId!, side: 'before' }
    if (last && clientX > last.getBoundingClientRect().right) return { id: lastId!, side: 'after' }
    return null
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || endDrag.current) return
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let active = false

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!active) {
        if (Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD && Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) return
        active = true
        setDragId(id)
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      setDrop(dropAt(moveEvent.clientX))
    }

    const stop = (commit: boolean, clientX: number | null) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape)
      endDrag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragId(null)
      setDrop(null)
      if (!active) return
      // Swallow the click the browser emits right after a drag.
      suppressClick.current = true
      window.setTimeout(() => { suppressClick.current = false }, 0)
      if (!commit || clientX === null) return
      const target = dropAt(clientX)
      if (target && target.id !== id) live.current.onReorder(id, target.id, target.side)
    }
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) stop(true, upEvent.clientX)
    }
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) stop(false, null)
    }
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault()
        stop(false, null)
      }
    }

    endDrag.current = () => stop(false, null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape)
  }

  useEffect(() => () => endDrag.current?.(), [])

  // Closing the launcher removes the focused control with it; return the
  // keyboard to the tab strip instead of dropping focus on <body>.
  const wasLauncher = useRef(false)
  useEffect(() => {
    if (wasLauncher.current && !launcherOpen) {
      const active = document.activeElement
      if (!active || active === document.body) addButton.current?.focus()
    }
    wasLauncher.current = launcherOpen
  }, [launcherOpen])

  return <header className={styles.topbar}>
    <button type="button" className={styles.iconButton} onClick={onOpenDialog} aria-label={t('shell.topbar.openRepo')} title={t('shell.topbar.openRepoShortcut')}><ToolbarIcon name="folder" /></button>
    <div className={styles.brandSlot}><Brand /></div>
    {workspaceSelector}
    <div className={styles.tabsGroup}><div className={styles.repoTabs} role="group" aria-label={t('shell.topbar.openRepos')} data-dragging={dragId ? 'true' : undefined}>
      {repos.map((entry) => {
        const id = entry.repo.repoId
        return <div
          key={id}
          ref={(element) => {
            if (element) tabs.current.set(id, element)
            else tabs.current.delete(id)
          }}
          className={id === activeId ? styles.repoTabActive : styles.repoTab}
          data-dragging={dragId === id ? 'true' : undefined}
          data-drop={drop?.id === id ? drop.side : undefined}
          onPointerDown={(event) => beginDrag(event, id)}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
          onAuxClick={(event) => {
            if (event.button !== 1) return
            event.preventDefault()
            if (!live.current.busy) live.current.onClose(id)
          }}>
          <button type="button" className={styles.repoMain} onClick={() => { if (suppressClick.current) return; onActivate(id) }} title={entry.repo.worktree} aria-current={id === activeId ? 'page' : undefined}>
            <ToolbarIcon name="branch" /><span className={styles.repoName}>{entry.repo.name}</span>
          </button>
          <button type="button" className={styles.close} onClick={() => onClose(id)} aria-label={t('shell.topbar.closeTab', { name: entry.repo.name })} disabled={busy}>×</button>
        </div>
      })}
      {launcherOpen ? <div className={styles.repoTabActive} data-launcher="true"
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
        onAuxClick={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          onCloseLauncher()
        }}>
        <button type="button" className={styles.repoMain} onClick={onAdd} aria-current="page" title={t('shell.topbar.launcherDescription')}>
          <ToolbarIcon name="folder" /><span className={styles.repoName}>{t('shell.topbar.openRepo')}</span>
        </button>
        <button type="button" className={styles.close} onClick={onCloseLauncher} aria-label={t('shell.topbar.closeLauncher')}>×</button>
      </div> : null}
    </div>
      <button ref={addButton} type="button" className={styles.add} onClick={onAdd} aria-label={t('shell.topbar.addRepo')} title={t('shell.topbar.newTabHint')}><ToolbarIcon name="plus" /></button>
    </div>
    <div className={styles.spacer} />
    {updateVersion ? (
      <button type="button" className={styles.updateButton} onClick={onInstallUpdate} data-update={updateVersion}
        disabled={updateBusy} aria-busy={updateBusy || undefined}
        aria-label={updateBusy ? t('shell.topbar.updateInstalling', { version: updateVersion }) : t('shell.topbar.updateAvailable', { version: updateVersion })}
        title={updateBusy ? t('shell.topbar.updateProgress', { version: updateVersion }) : t('shell.topbar.updateAvailableHint', { version: updateVersion })}>
        <ToolbarIcon name="update" />{updateBusy ? null : <span className={styles.updateDot} aria-hidden="true" />}
      </button>
    ) : null}
    <button type="button" className={styles.iconButton} onClick={onSettings} aria-label={t('shell.topbar.settings')} title={t('shell.topbar.settingsShortcut')}><ToolbarIcon name="settings" /></button>
    <ActionMenu label={t('shell.topbar.profileMenu')} triggerClassName={styles.profile} triggerContent={<><span className={styles.avatar}>{(user ?? 'P').slice(0, 1).toUpperCase()}</span><span className={styles.userName}>{user ?? t('shell.topbar.localProfile')}</span><ToolbarIcon name="chevron" /></>}>
      <button type="button" onClick={onSettings}>{t('shell.topbar.settings')}</button>
    </ActionMenu>
  </header>
}
