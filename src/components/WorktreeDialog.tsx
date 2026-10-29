import { useState } from 'react'
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog'
import { worktreeAdd } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  /** Ref the new worktree starts from (branch, tag or sha). */
  reference: string
  onClose: () => void
  onCreated: (path: string) => void
}

/**
 * Worktree creation from the graph menu: same backend call as the Worktrees
 * panel, with the reference already filled by the menu entry.
 */
export function WorktreeDialog({ repoId, reference, onClose, onCreated }: Props) {
  const [path, setPath] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [detach, setDetach] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    try {
      const picked = await openNativeDialog({ directory: true, multiple: false })
      if (typeof picked === 'string') setPath(picked)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const submit = async () => {
    const destination = path.trim()
    if (!destination || busy) return
    setBusy(true)
    setError(null)
    try {
      await worktreeAdd({
        repoId,
        path: destination,
        reference,
        newBranch: detach ? undefined : newBranch.trim() || undefined,
        detach,
      })
      onCreated(destination)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="worktree-dialog-title">
        <h2 id="worktree-dialog-title">Créer un worktree</h2>
        <p>
          Une seconde copie de travail sur <code>{reference}</code>. Le dépôt
          reste partagé : une branche ne peut être extraite que dans un seul
          worktree à la fois.
        </p>
        <label className={shared.field}>
          Dossier de destination
          <span className={shared.row}>
            <input
              data-autofocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/Users/you/src/project-feature"
              spellCheck={false}
              aria-label="Dossier du worktree"
            />
            <Button type="button" onClick={() => void pick()}>
              Choisir…
            </Button>
          </span>
        </label>
        <label className={shared.field}>
          Nouvelle branche (optionnel)
          <input
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            placeholder="feature/nouvelle"
            spellCheck={false}
            disabled={detach}
            aria-label="Nouvelle branche du worktree"
          />
        </label>
        <label className={shared.checkbox}>
          <input
            type="checkbox"
            checked={detach}
            onChange={(event) => setDetach(event.target.checked)}
          />
          HEAD détachée
        </label>
        {error ? (
          <p className={shared.danger} role="alert">
            {error}
          </p>
        ) : null}
        <div className={shared.dialogActions}>
          <Button type="button" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void submit()}
            disabled={!path.trim() || busy}
          >
            {busy ? 'Création…' : 'Créer le worktree'}
          </Button>
        </div>
    </Dialog>
  )
}
