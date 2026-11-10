import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { errorMessage } from '../ipc/client'
import {
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
} from '../ipc/commands'
import { useI18n } from '../i18n'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './TerminalPanel.module.css'

type Props = { repoId: string; onClose?: () => void }

type DataEvent = { sessionId: string; data: string }
type ExitEvent = { sessionId: string; code: number | null }

function encode(data: string): string {
  const bytes = new TextEncoder().encode(data)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decode(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * One shell per open view. The PTY belongs to the backend; this component
 * forwards keystrokes, resizes and closes it on unmount, and never chooses the
 * program (the backend uses the user's shell in the worktree).
 */
export function TerminalPanel({ repoId, onClose }: Props) {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    // Known before the spawn so the first byte of output is not lost.
    let sessionId: string | null = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let unlisten: UnlistenFn[] = []
    const pending: Uint8Array[] = []
    const root = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string) =>
      root.getPropertyValue(name).trim() || fallback
    const terminal = new Terminal({
      fontFamily: 'Geist Mono Variable, ui-monospace, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: false,
      theme: {
        background: token('--surface', '#12161d'),
        foreground: token('--text', '#e6e9ef'),
        cursor: token('--accent-text', '#7aa2f7'),
        selectionBackground: token('--selection-bg', '#2a3242'),
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    fit.fit()
    const dataSubscription = terminal.onData((data) => {
      if (sessionId) void terminalWrite(sessionId, encode(data)).catch(() => undefined)
    })
    const resizeSubscription = terminal.onResize(({ rows, cols }) => {
      fit.fit()
      if (sessionId) void terminalResize(sessionId, rows, cols).catch(() => undefined)
    })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(element)
    void (async () => {
      try {
        const [onData, onExit] = await Promise.all([
          listen<DataEvent>('term://data', (event) => {
            if (event.payload.sessionId !== sessionId) return
            terminal.write(decode(event.payload.data))
          }),
          listen<ExitEvent>('term://exit', (event) => {
            if (event.payload.sessionId !== sessionId) return
            terminal.write(`\r\n[${event.payload.code ?? 0}]\r\n`)
          }),
        ])
        unlisten = [onData, onExit]
        const opened = await terminalOpen({
          repoId,
          sessionId: sessionId!,
          rows: terminal.rows,
          cols: terminal.cols,
        })
        if (disposed) {
          void terminalClose(opened.sessionId).catch(() => undefined)
          return
        }
        sessionId = opened.sessionId
        setShell(opened.shell)
        for (const chunk of pending.splice(0)) terminal.write(chunk)
        terminal.focus()
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause))
      }
    })()
    return () => {
      disposed = true
      observer.disconnect()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      for (const stop of unlisten) stop()
      if (sessionId) void terminalClose(sessionId).catch(() => undefined)
      terminal.dispose()
    }
  }, [repoId])

  return (
    <div className={styles.panel} data-terminal={repoId}>
      <div className={styles.head}>
        <span>{shell ? t('terminal.shell', { shell }) : t('terminal.opening')}</span>
        {onClose ? (
          <button type="button" className={styles.close} onClick={onClose} aria-label={t('terminal.close')}>
            <ToolbarIcon name="x" size={14} />
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div ref={host} className={styles.host} />
    </div>
  )
}
