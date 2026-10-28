import { useState, type FormEvent } from 'react'
import type { InitInput } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useModal } from '../hooks/useModal'
import styles from './InitRepoDialog.module.css'

type Props = {
  busy: boolean
  defaultParent?: string
  onClose: () => void
  onCreate: (input: InitInput) => Promise<void>
  onPickParent: (defaultPath?: string) => Promise<string | null>
}

function joinPath(parent: string, name: string) {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

function isValidName(name: string) {
  const trimmed = name.trim()
  return (
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    trimmed !== '.git' &&
    !/[\\/]/.test(trimmed)
  )
}

export function InitRepoDialog({
  busy,
  defaultParent = '',
  onClose,
  onCreate,
  onPickParent,
}: Props) {
  const ref = useModal(true, onClose, busy)
  const [parent, setParent] = useState(defaultParent)
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = busy || submitting
  const destination =
    parent.trim() && isValidName(name)
      ? joinPath(parent.trim(), name.trim())
      : ''
  const showNameError = name.length > 0 && !isValidName(name)

  const browse = async () => {
    setError(null)
    try {
      const picked = await onPickParent(parent.trim() || undefined)
      if (picked) {
        setParent(picked)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!destination || disabled) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({
        destination,
        initialBranch: branch.trim() || undefined,
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (!disabled && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="init-repo-title"
      >
        <header>
          <h2 id="init-repo-title">Créer un dépôt local</h2>
          <button
            type="button"
            aria-label="Fermer la création du dépôt"
            disabled={disabled}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className={styles.field}>
            Dossier parent
            <div className={styles.pathRow}>
              <input
                value={parent}
                onChange={(event) => setParent(event.target.value)}
                placeholder="/Users/vous/src"
                spellCheck={false}
                aria-label="Dossier parent"
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void browse()}
                disabled={disabled}
              >
                Parcourir…
              </button>
            </div>
          </label>
          <label className={styles.field}>
            Nom du dépôt
            <input
              data-autofocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="mon-projet"
              spellCheck={false}
              required
              aria-label="Nom du dépôt"
              aria-invalid={showNameError || undefined}
            />
          </label>
          {showNameError ? (
            <p className={styles.error} role="alert">
              Le nom ne peut pas contenir « / » ou « \ ».
            </p>
          ) : null}
          <label className={styles.field}>
            Branche initiale (optionnel)
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="suit init.defaultBranch"
              spellCheck={false}
              aria-label="Branche initiale"
            />
          </label>
          <p className={styles.preview}>
            {destination || 'Choisissez un dossier parent et un nom.'}
          </p>
          <p className={styles.hint}>
            Le dossier est créé s’il n’existe pas. Un dossier existant est
            conservé : ses fichiers restent non suivis tant qu’ils ne sont pas
            ajoutés.
          </p>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <footer className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={onClose}
              disabled={disabled}
            >
              Annuler
            </button>
            <button
              type="submit"
              className={styles.primary}
              disabled={disabled || !destination}
            >
              {submitting ? 'Création…' : 'Créer le dépôt'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
