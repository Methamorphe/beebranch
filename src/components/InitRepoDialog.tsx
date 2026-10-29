import { useState, type FormEvent } from 'react'
import type { InitInput } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
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
  const { t } = useI18n()
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
          <h2 id="init-repo-title">{t('shell.init.title')}</h2>
          <button
            type="button"
            aria-label={t('shell.init.close')}
            disabled={disabled}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className={styles.field}>
            {t('shell.init.parentFolder')}
            <div className={styles.pathRow}>
              <input
                value={parent}
                onChange={(event) => setParent(event.target.value)}
                placeholder={t('shell.init.parentPlaceholder')}
                spellCheck={false}
                aria-label={t('shell.init.parentFolder')}
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void browse()}
                disabled={disabled}
              >
                {t('shell.init.browse')}
              </button>
            </div>
          </label>
          <label className={styles.field}>
            {t('shell.init.repoName')}
            <input
              data-autofocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('shell.init.namePlaceholder')}
              spellCheck={false}
              required
              aria-label={t('shell.init.repoName')}
              aria-invalid={showNameError || undefined}
            />
          </label>
          {showNameError ? (
            <p className={styles.error} role="alert">
              {t('shell.init.invalidName')}
            </p>
          ) : null}
          <label className={styles.field}>
            {t('shell.init.initialBranch')}
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder={t('shell.init.branchPlaceholder')}
              spellCheck={false}
              aria-label={t('shell.init.initialBranchLabel')}
            />
          </label>
          <p className={styles.preview}>
            {destination || t('shell.init.previewEmpty')}
          </p>
          <p className={styles.hint}>
            {t('shell.init.hint')}
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
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={styles.primary}
              disabled={disabled || !destination}
            >
              {submitting ? t('shell.init.creating') : t('shell.init.create')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
