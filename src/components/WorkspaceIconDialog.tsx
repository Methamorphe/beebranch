import { useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { errorMessage } from '../ipc/client'
import { workspaceReadIcon } from '../ipc/commands'
import { useI18n } from '../i18n'
import { rasterizeWorkspaceIcon, WORKSPACE_ICONS, workspaceMonogram } from '../lib/workspaceIcon'
import { Dialog } from './ui/Dialog'
import { AppIcon } from './IconSvg'
import shared from './p1.module.css'
import styles from './WorkspaceIconDialog.module.css'

export type DraftWorkspaceIcon =
  | { kind: 'none' }
  | { kind: 'lucide'; key: string }
  | { kind: 'image'; pngBase64: string; previewUrl: string }

type Props = {
  open: boolean
  name: string
  value: DraftWorkspaceIcon
  busy: boolean
  onClose: () => void
  onChange: (next: DraftWorkspaceIcon) => void
}

export function WorkspaceIconDialog({ open, name, value, busy, onClose, onChange }: Props) {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const locked = busy || reading

  const pickImage = async () => {
    setError(null)
    const selected = await openNativeDialog({
      title: t('workspaces.panel.iconChoose'),
      multiple: false,
      directory: false,
      filters: [{
        name: t('workspaces.panel.iconFormats'),
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
      }],
    })
    if (typeof selected !== 'string') return
    setReading(true)
    try {
      const source = await workspaceReadIcon(selected)
      const pngBase64 = await rasterizeWorkspaceIcon(source)
      onChange({
        kind: 'image',
        pngBase64,
        previewUrl: `data:image/png;base64,${pngBase64}`,
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setReading(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} busy={locked} titleId="workspace-icon-title">
      <h2 id="workspace-icon-title">{t('workspaces.panel.iconTitle')}</h2>
      <p className={shared.notice}>{t('workspaces.panel.iconHint')}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.grid} role="listbox" aria-label={t('workspaces.panel.iconTitle')}>
        <button
          type="button"
          className={value.kind === 'none' ? styles.cellSelected : styles.cell}
          aria-pressed={value.kind === 'none'}
          aria-label={t('workspaces.panel.iconNone')}
          disabled={locked}
          onClick={() => onChange({ kind: 'none' })}
        >
          <span className={styles.letter}>{workspaceMonogram(name)}</span>
        </button>
        {WORKSPACE_ICONS.map((entry) => {
          const selected = value.kind === 'lucide' && value.key === entry.key
          return (
            <button
              key={entry.key}
              type="button"
              className={selected ? styles.cellSelected : styles.cell}
              aria-pressed={selected}
              aria-label={entry.key}
              disabled={locked}
              onClick={() => onChange({ kind: 'lucide', key: entry.key })}
            >
              <AppIcon icon={entry.icon} size={16} />
            </button>
          )
        })}
      </div>
      <div className={styles.imageRow}>
        {value.kind === 'image' ? (
          <img className={styles.preview} src={value.previewUrl} alt="" />
        ) : null}
        <button type="button" className={shared.secondary} disabled={locked} onClick={() => void pickImage()}>
          {reading
            ? t('common.loading')
            : value.kind === 'image'
              ? t('workspaces.panel.iconReplace')
              : t('workspaces.panel.iconChoose')}
        </button>
        {value.kind === 'image' ? (
          <button
            type="button"
            className={shared.secondary}
            disabled={locked}
            onClick={() => onChange({ kind: 'none' })}
          >
            {t('workspaces.panel.iconRemove')}
          </button>
        ) : null}
      </div>
      <div className={shared.row}>
        <button type="button" className={shared.primary} onClick={onClose} disabled={locked}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  )
}
