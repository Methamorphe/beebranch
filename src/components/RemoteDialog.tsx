import { useState } from 'react'
import { remoteAdd, remoteSetUrl } from '../ipc/commands'
import { errorMessage } from '../ipc/client'
import { useI18n } from '../i18n'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import shared from './p1.module.css'

type AddProps = {
  mode: 'add'
  existingNames: string[]
}

type EditProps = {
  mode: 'edit'
  name: string
  url: string
}

type Props = {
  repoId: string
  onClose: () => void
  onDone: (notice: string) => void
} & (AddProps | EditProps)

/**
 * Add or edit a remote. Same dialog chrome as a tag or a worktree: a short
 * title, a hint, the fields, then Cancel and the primary action.
 */
export function RemoteDialog(props: Props) {
  const { t } = useI18n()
  const adding = props.mode === 'add'
  const [name, setName] = useState(adding ? '' : props.name)
  const [url, setUrl] = useState(adding ? '' : props.url)
  const [pushOnly, setPushOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = (adding ? name.trim().length > 0 : true) && url.trim().length > 0
  const namePlaceholder =
    adding && props.existingNames.includes('origin')
      ? t('ops.refs.upstreamPlaceholder')
      : t('ops.refs.namePlaceholder')

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      if (adding) {
        await remoteAdd({ repoId: props.repoId, name: name.trim(), url: url.trim() })
        props.onDone(t('ops.refs.notice.remoteAdded'))
      } else {
        await remoteSetUrl({
          repoId: props.repoId,
          name: props.name,
          url: url.trim(),
          push: pushOnly,
        })
        props.onDone(t('ops.refs.notice.urlChanged'))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={props.onClose} busy={busy} titleId="remote-dialog-title">
      <h2 id="remote-dialog-title">
        {adding ? t('ops.refs.addRemoteTitle') : t('ops.refs.editUrl')}
      </h2>
      {adding ? (
        <p>{t('ops.refs.addRemoteHint')}</p>
      ) : (
        <p>
          {t('ops.refs.remoteLabel')} <code>{props.name}</code>. {t('ops.refs.setUrlHint')}
        </p>
      )}
      {adding ? (
        <label className={shared.field}>
          {t('common.name')}
          <input
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={namePlaceholder}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
        </label>
      ) : null}
      <label className={shared.field}>
        {t('common.url')}
        <input
          data-autofocus={!adding}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t('shell.home.urlPlaceholder')}
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </label>
      {adding ? null : (
        <label className={shared.checkbox}>
          <input
            type="checkbox"
            checked={pushOnly}
            onChange={(event) => setPushOnly(event.target.checked)}
          />
          {t('ops.refs.pushUrlOnly')}
        </label>
      )}
      {error ? (
        <p className={shared.danger} role="alert">
          {error}
        </p>
      ) : null}
      <div className={shared.dialogActions}>
        <Button type="button" onClick={props.onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? t('common.working') : adding ? t('common.add') : t('common.save')}
        </Button>
      </div>
    </Dialog>
  )
}
