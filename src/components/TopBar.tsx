import type { RepoView } from '../types/git'
import { ActionMenu } from './ActionMenu'
import { Brand } from './Brand'
import { ToolbarIcon } from './ToolbarIcon'
import styles from './TopBar.module.css'

type Props = {
  repos: RepoView[]
  activeId: string | null
  busy: boolean
  onActivate: (repoId: string) => void
  onClose: (repoId: string) => void
  onOpenDialog: () => void
  onClone: () => void
  onSettings: () => void
  updateVersion?: string | null
  updateBusy?: boolean
  onInstallUpdate?: () => void
  user?: string | null
}

export function TopBar({ repos, activeId, busy, onActivate, onClose, onOpenDialog, onClone, onSettings, updateVersion, updateBusy = false, onInstallUpdate, user }: Props) {
  return <header className={styles.topbar}>
    <button type="button" className={styles.iconButton} onClick={onOpenDialog} aria-label="Ouvrir un dépôt" title="Ouvrir un dépôt · ⌘O"><ToolbarIcon name="folder" /></button>
    <div className={styles.brandSlot}><Brand /></div>
    <div className={styles.tabsGroup}><div className={styles.repoTabs} role="group" aria-label="Dépôts ouverts">
      {repos.map((entry) => <div key={entry.repo.repoId} className={entry.repo.repoId === activeId ? styles.repoTabActive : styles.repoTab}>
        <button type="button" className={styles.repoMain} onClick={() => onActivate(entry.repo.repoId)} title={entry.repo.worktree} aria-current={entry.repo.repoId === activeId ? 'page' : undefined}>
          <ToolbarIcon name="branch" /><span className={styles.repoName}>{entry.repo.name}</span>
        </button>
        <button type="button" className={styles.close} onClick={() => onClose(entry.repo.repoId)} aria-label={`Fermer ${entry.repo.name}`} disabled={busy}>×</button>
      </div>)}
    </div>
      <ActionMenu label="Ajouter un dépôt" triggerClassName={styles.add} disabled={busy} triggerContent={<ToolbarIcon name="plus" />}>
        <button type="button" onClick={onOpenDialog}><ToolbarIcon name="folder" />Ouvrir un dépôt local…</button>
        <button type="button" onClick={onClone}><ToolbarIcon name="clone" />Cloner un dépôt…</button>
      </ActionMenu>
    </div>
    <div className={styles.spacer} />
    {updateVersion ? (
      <button type="button" className={styles.updateButton} onClick={onInstallUpdate} data-update={updateVersion}
        disabled={updateBusy} aria-busy={updateBusy || undefined}
        aria-label={updateBusy ? `Installation de la mise à jour ${updateVersion} en cours` : `Mise à jour ${updateVersion} disponible, installer`}
        title={updateBusy ? `Installation de la mise à jour ${updateVersion}…` : `Mise à jour ${updateVersion} disponible · cliquer pour installer`}>
        <ToolbarIcon name="update" />{updateBusy ? null : <span className={styles.updateDot} aria-hidden="true" />}
      </button>
    ) : null}
    <button type="button" className={styles.iconButton} onClick={onSettings} aria-label="Profils et réglages" title="Profils et réglages · ⌘,"><ToolbarIcon name="settings" /></button>
    <ActionMenu label="Menu du profil" triggerClassName={styles.profile} triggerContent={<><span className={styles.avatar}>{(user ?? 'P').slice(0, 1).toUpperCase()}</span><span className={styles.userName}>{user ?? 'Profil local'}</span><ToolbarIcon name="chevron" /></>}>
      <button type="button" onClick={onSettings}>Profils et réglages</button>
    </ActionMenu>
  </header>
}
