import type { CloneInput } from '../ipc/commands'
import type { RecentRepo } from '../types/git'
import type { ViewId } from '../data/navigation'
import { useModal } from '../hooks/useModal'
import { Home } from './Home'
import styles from './CloneRepoDialog.module.css'

type Props = {
  busy: boolean
  recent: RecentRepo[]
  onClose: () => void
  onClone: (input: CloneInput) => Promise<void>
  onOpen: (path: string) => void
  onOpenDialog: () => void
  onNavigate: (view: ViewId) => void
}

export function CloneRepoDialog({ busy, recent, onClose, onClone, onOpen, onOpenDialog, onNavigate }: Props) {
  const ref = useModal(true, onClose, busy)
  return <div className={styles.backdrop} onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <div ref={ref} tabIndex={-1} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="clone-repo-title">
      <header><h2 id="clone-repo-title">Cloner un dépôt</h2><button type="button" aria-label="Fermer le clonage" disabled={busy} onClick={onClose}>×</button></header>
      <Home cloneOnly recent={recent} onCancelClone={onClose} onClone={onClone} onOpen={onOpen} onOpenDialog={onOpenDialog} onSelect={(view) => { onClose(); onNavigate(view) }} />
    </div>
  </div>
}
