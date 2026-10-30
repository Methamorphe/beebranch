import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { errorMessage } from '../ipc/client'
import { fileContentGet, fileWrite, indexStage } from '../ipc/commands'
import type { FileContent } from '../types/git'
import { CodeEditor } from './CodeEditor'
import { Markdown } from './Markdown'
import shared from './p1.module.css'
import styles from './FileEditorPane.module.css'

const MARKDOWN_PREVIEW_LIMIT = 200_000

type Props = {
  repoId: string
  path: string
  onClose: () => void
  onSaved: () => void
}

/**
 * Editor for one worktree file, rendered in place of the diff it came from.
 *
 * The buffer starts from the bytes that were read, and their SHA-256 travels
 * back with the save: a file changed outside the application is refused instead
 * of overwritten. The backend applies the configured encoding, so a Windows-1252
 * file stays Windows-1252. Saving keeps the editor open so the file can be
 * continued, staged, or closed without leaving the page.
 */
export function FileEditorPane({ repoId, path, onClose, onSaved }: Props) {
  const [document, setDocument] = useState<FileContent | null>(null)
  const [draft, setDraft] = useState('')
  /** Saved text as the editor sees it (LF only), for dirty and discard. */
  const [baseline, setBaseline] = useState('')
  /** Line ending of the file on disk, re-applied on save. */
  const [eol, setEol] = useState('\n')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    fileContentGet({ repoId, path })
      .then((value) => {
        if (cancelled) {
          return
        }
        setDocument(value)
        const text = (value.content ?? '').replaceAll('\r\n', '\n')
        setBaseline(text)
        setDraft(text)
        setEol(value.content?.includes('\r\n') ? '\r\n' : '\n')
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
  const dirty = draft !== baseline
  const editable = Boolean(
    document && document.content !== null && !document.binary && !document.truncated,
  )

  const save = async (stage: boolean) => {
    if (!document) {
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const payload =
        eol === '\r\n' ? draft.replaceAll('\n', '\r\n') : draft
      const written = await fileWrite({
        repoId,
        path,
        content: payload,
        expectedSha256: document.sha256,
      })
      if (stage) {
        await indexStage(repoId, [{ path, hunks: [] }])
      }
      // The saved bytes become the new baseline, so the next save carries the
      // fresh SHA-256 and the dirty marker clears without closing the editor.
      setDocument((current) =>
        current
          ? {
              ...current,
              content: draft,
              bytes: written.bytes,
              sha256: written.sha256,
            }
          : current,
      )
      setBaseline(draft)
      setSaved(true)
      onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!saved) {
      return
    }
    const timer = window.setTimeout(() => setSaved(false), 2500)
    return () => window.clearTimeout(timer)
  }, [saved])

  return (
    <div className={styles.pane}>
      <header className={styles.head}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        <span className={styles.state} data-dirty={dirty ? 'true' : undefined}>
          {dirty
            ? t('editor.unsaved')
            : saved
              ? t('editor.savedNotice')
              : t('editor.savedBaseline')}
        </span>
        <span className={styles.spacer} />
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
        <button
          type="button"
          className={shared.small}
          disabled={busy}
          onClick={onClose}
          aria-label={t('editor.closeAria')}
        >
          {t('editor.close')}
        </button>
      </header>

      {document && !editable ? (
        <p className={styles.banner} role="alert">
          {document.binary ? t('editor.binary') : t('editor.truncated')}
        </p>
      ) : null}

      <div className={styles.body}>
        {preview ? (
          <div className={styles.document}>
            <Markdown source={draft} />
          </div>
        ) : (
          <CodeEditor
            value={draft}
            path={path}
            ariaLabel={t('editor.aria', { path })}
            readOnly={busy || !editable}
            onChange={setDraft}
          />
        )}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <footer className={styles.actions}>
        <button
          type="button"
          className={shared.secondary}
          disabled={busy || !dirty}
          onClick={() => setDraft(baseline)}
        >
          {t('editor.discard')}
        </button>
        <span className={styles.spacer} />
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
      </footer>
    </div>
  )
}
