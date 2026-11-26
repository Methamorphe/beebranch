import { useState } from 'react'
import { submoduleAdd } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'

type Props = {
  repoId: string
  onClose: () => void
  onDone: (notice: string) => void
}

/**
 * Add a submodule. Same dialog chrome as a remote or a worktree: a short
 * title, the URL and path, then Cancel / Add.
 */
export function SubmoduleDialog({ repoId, onClose, onDone }: Props) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = url.trim().length > 0 && path.trim().length > 0

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await submoduleAdd({
        repoId,
        url: url.trim(),
        path: path.trim(),
        branch: branch.trim() || undefined,
        force,
      })
      onDone(t('ops.submodule.notice.added'))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="submodule-dialog-title">
      <h2 id="submodule-dialog-title">{t('ops.submodule.addTitle')}</h2>
      <p>{t('ops.submodule.addHint')}</p>
      <label className={shared.field}>
        {t('common.url')}
        <input
          data-autofocus
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t('ops.submodule.urlPlaceholder')}
          spellCheck={false}
        />
      </label>
      <label className={shared.field}>
        {t('common.path')}
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="vendor/sdk"
          spellCheck={false}
        />
      </label>
      <label className={shared.field}>
        {t('ops.submodule.branchLabel')}
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="main"
          spellCheck={false}
        />
      </label>
      <label className={shared.checkbox} title={t('ops.submodule.forceHint')}>
        <input
          type="checkbox"
          checked={force}
          onChange={(event) => setForce(event.target.checked)}
        />
        {t('ops.submodule.force')}
      </label>
      {error ? (
        <p className={shared.danger} role="alert">
          {error}
        </p>
      ) : null}
      <div className={shared.dialogActions}>
        <Button type="button" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? t('common.working') : t('ops.submodule.addLabel')}
        </Button>
      </div>
    </Dialog>
  )
}
