import { useI18n, type MessageKey } from '../i18n'
import { SHORTCUT_LABELS, displayShortcut, type ShortcutAction, type ShortcutMap } from '../lib/shortcuts'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'
import styles from './ShortcutHelp.module.css'

/** Keys handled outside the configurable map; kept in sync with their handlers. */
const FIXED: { keys: string; label: MessageKey }[] = [
  { keys: '?', label: 'common.shortcutHelp.help' },
  { keys: 'Esc', label: 'common.shortcutHelp.close' },
  { keys: 'Mod+Enter', label: 'common.shortcutHelp.commit' },
  { keys: '← → ↑ ↓', label: 'common.shortcutHelp.diffFiles' },
  { keys: 'Mod+Alt+1…9', label: 'common.shortcutHelp.favourites' },
]

type Props = {
  open: boolean
  shortcuts: ShortcutMap
  onClose: () => void
}

export function ShortcutHelp({ open, shortcuts, onClose }: Props) {
  const { t } = useI18n()
  const row = (keys: string, label: MessageKey) => (
    <li key={label}>
      <span>{t(label)}</span>
      <kbd>{displayShortcut(keys)}</kbd>
    </li>
  )
  return (
    <Dialog open={open} onClose={onClose} titleId="shortcut-help-title" className={styles.dialog}>
      <h2 id="shortcut-help-title">{t('common.shortcutHelp.title')}</h2>
      <h3>{t('common.shortcutHelp.configurable')}</h3>
      <ul className={styles.list}>
        {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) =>
          row(shortcuts[action], SHORTCUT_LABELS[action]),
        )}
      </ul>
      <h3>{t('common.shortcutHelp.fixed')}</h3>
      <ul className={styles.list}>{FIXED.map(({ keys, label }) => row(keys, label))}</ul>
      <div className={shared.dialogActions}>
        <button type="button" className={shared.secondary} data-autofocus onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  )
}
