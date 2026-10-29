import { useI18n } from '../i18n'
import { Button } from './ui/Button'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './UpdateNotice.module.css'

type Props = {
  version: string
  installing: boolean
  /** Download percentage, or `null` while the size is unknown. */
  progress: number | null
  onInstall: () => void
  onDismiss: () => void
}

export function UpdateNotice({
  version,
  installing,
  progress,
  onInstall,
  onDismiss,
}: Props) {
  const { t } = useI18n()
  const detail = installing
    ? progress === null
      ? t('shell.update.downloading')
      : t('shell.update.progress', { progress })
    : t('shell.update.ready')

  return (
    <div
      className={styles.notice}
      role="status"
      aria-live="polite"
      data-update-notice={version}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToolbarIcon name="update" />
      </span>
      <div className={styles.body}>
        <p className={styles.title}>{t('shell.update.available', { version })}</p>
        <p className={styles.detail}>{detail}</p>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? t('shell.update.installing') : t('shell.update.install')}
          </Button>
          <Button type="button" size="sm" onClick={onDismiss} disabled={installing}>
            {t('shell.update.later')}
          </Button>
        </div>
      </div>
    </div>
  )
}
