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
  const detail = installing
    ? progress === null
      ? 'Téléchargement et vérification de la signature…'
      : `Téléchargement ${progress} %. Redémarrage à la fin.`
    : 'Signature vérifiée avant installation. L’application redémarre ensuite.'

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
        <p className={styles.title}>Mise à jour {version} disponible</p>
        <p className={styles.detail}>{detail}</p>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? 'Installation…' : 'Installer'}
          </Button>
          <Button type="button" size="sm" onClick={onDismiss} disabled={installing}>
            Plus tard
          </Button>
        </div>
      </div>
    </div>
  )
}
