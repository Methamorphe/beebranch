import { useState } from 'react'
import { tagCreate } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  /** Commit the tag points at, as a sha or a ref. */
  target: string
  /** Annotated tags carry a message and a tagger; lightweight ones do not. */
  annotated: boolean
  onClose: () => void
  onCreated: (name: string) => void
}

/**
 * Tag creation from the graph menu. The annotated variant requires a message
 * because that is the only difference the user asked for; a lightweight tag
 * would silently ignore it.
 */
export function TagDialog({ repoId, target, annotated, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = name.trim().length > 0 && (!annotated || message.trim().length > 0)

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const tag = name.trim()
      await tagCreate({
        repoId,
        name: tag,
        target,
        message: annotated ? message.trim() : undefined,
      })
      onCreated(tag)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="tag-dialog-title">
        <h2 id="tag-dialog-title">
          {annotated ? 'Créer un tag annoté' : 'Créer un tag'}
        </h2>
        <p>
          Le tag pointe sur <code>{target.slice(0, 10)}</code>. Le push d’un tag
          reste une action explicite depuis l’onglet Tags.
        </p>
        <label className={shared.field}>
          Nom
          <input
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={annotated ? 'v1.0.0' : 'v1.0.0-rc1'}
            spellCheck={false}
            aria-label="Nom du tag"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !annotated) void submit()
            }}
          />
        </label>
        {annotated ? (
          <label className={shared.field}>
            Message
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              placeholder="chore(release): prépare la version"
              aria-label="Message du tag annoté"
            />
          </label>
        ) : null}
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
            disabled={!ready || busy}
          >
            {busy ? 'Création…' : 'Créer le tag'}
          </Button>
        </div>
    </Dialog>
  )
}
