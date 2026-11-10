import { useI18n } from '../i18n'
import type { CloneInput } from '../ipc/commands'
import { CloneForm } from './CloneForm'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'
import styles from './WorkspaceCloneDialog.module.css'

type Props = {
  open: boolean
  busy: boolean
  draft: boolean
  onClose: () => void
  onClone: (input: CloneInput) => Promise<void>
  onPickDirectory?: (defaultPath?: string) => Promise<string | null>
  onOpenProvider?: (provider: 'gitlab' | 'github') => void
}

export function WorkspaceCloneDialog({
  open,
  busy,
  draft,
  onClose,
  onClone,
  onPickDirectory,
  onOpenProvider,
}: Props) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onClose={onClose} busy={busy} titleId="workspace-clone-title" className={styles.dialog}>
      <h2 id="workspace-clone-title">{t('workspaces.panel.cloneTitle')}</h2>
      <p className={shared.notice}>
        {t(draft ? 'workspaces.panel.cloneDraftIntro' : 'workspaces.panel.cloneIntro')}
      </p>
      {open ? (
        <CloneForm
          active
          busy={busy}
          idPrefix="workspace-clone"
          onClone={onClone}
          onPickDirectory={onPickDirectory}
          onOpenProvider={onOpenProvider ? (provider) => { onOpenProvider(provider); onClose() } : undefined}
          onCancel={onClose}
          onDone={onClose}
        />
      ) : null}
    </Dialog>
  )
}
