import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { errorMessage } from '../ipc/client'
import { fileContentGet, fileWrite, indexStage } from '../ipc/commands'
import type { FileContent } from '../types/git'
import { Dialog } from './ui/Dialog'
import { Markdown } from './Markdown'
import shared from './p1.module.css'

const MARKDOWN_PREVIEW_LIMIT = 200_000

type BodyProps = {
  repoId: string
  path: string
  onClose: () => void
  onSaved: () => void
}

/**
 * Editor for one worktree file.
 *
 * The buffer starts from the bytes that were read, and their SHA-256 travels
 * back with the save: a file changed outside the application is refused instead
 * of overwritten. The backend applies the configured encoding, so a
 * Windows-1252 file stays Windows-1252.
 */
function FileEditorBody({ repoId, path, onClose, onSaved }: BodyProps) {
  const [document, setDocument] = useState<FileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fileContentGet({ repoId, path })
      .then((value) => {
        if (cancelled) {
          return
        }
        setDocument(value)
        setDraft(value.content ?? '')
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, path])

  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  const dirty = document ? draft !== (document.content ?? '') : false
  const editable = Boolean(
    document && document.content !== null && !document.binary && !document.truncated,
  )

  const save = async (stage: boolean) => {
    if (!document) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await fileWrite({
        repoId,
        path,
        content: draft,
        expectedSha256: document.sha256,
      })
      if (stage) {
        await indexStage(repoId, [{ path, hunks: [] }])
      }
      onSaved()
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} busy={busy} titleId="file-editor-title">
      <h2 id="file-editor-title">{t('editor.title', { path })}</h2>
      {document && !editable ? (
        <p className={shared.danger} role="alert">
          {document.binary ? t('editor.binary') : t('editor.truncated')}
        </p>
      ) : null}
      <div className={shared.row}>
        {isMarkdown ? (
          <button
            type="button"
            className={shared.small}
            aria-pressed={preview}
            disabled={busy || draft.length > MARKDOWN_PREVIEW_LIMIT}
            onClick={() => setPreview((current) => !current)}
          >
            {preview ? t('editor.editMode') : t('editor.preview')}
          </button>
        ) : null}
        <span className={shared.notice}>{dirty ? t('editor.unsaved') : t('editor.saved')}</span>
      </div>
      {preview ? (
        <div className={shared.document}>
          <Markdown source={draft} />
        </div>
      ) : (
        <textarea
          className={shared.editor}
          value={draft}
          aria-label={t('editor.aria', { path })}
          spellCheck={false}
          disabled={busy || !editable}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {error ? (
        <p className={shared.danger} role="alert">
          {error}
        </p>
      ) : null}
      <div className={shared.row}>
        <button type="button" className={shared.secondary} disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={shared.secondary}
          disabled={busy || !dirty}
          onClick={() => setDraft(document?.content ?? '')}
        >
          {t('editor.discard')}
        </button>
        <button
          type="button"
          className={shared.primary}
          disabled={busy || !dirty || !editable}
          onClick={() => void save(false)}
        >
          {t('editor.save')}
        </button>
        <button
          type="button"
          className={shared.primary}
          disabled={busy || !dirty || !editable}
          onClick={() => void save(true)}
        >
          {t('editor.saveAndStage')}
        </button>
      </div>
    </Dialog>
  )
}

type Props = {
  repoId: string
  path: string | null
  onClose: () => void
  onSaved: () => void
}

/**
 * Mount the editor for `path`.
 *
 * `key` remounts the body when another file is opened, so no effect has to
 * reset the buffer of the previous file.
 */
export function FileEditorDialog({ repoId, path, onClose, onSaved }: Props) {
  if (!path) {
    return null
  }
  return <FileEditorBody key={path} repoId={repoId} path={path} onClose={onClose} onSaved={onSaved} />
}
