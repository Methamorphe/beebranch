import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { editorExtensions } from '../lib/codeMirror'
import styles from './CodeEditor.module.css'

type Props = {
  value: string
  path: string
  ariaLabel: string
  readOnly?: boolean
  onChange: (value: string) => void
}

/**
 * Thin React wrapper around one CodeMirror view.
 *
 * The view is created once per file (path/readOnly change remounts it through
 * the effect), so the cursor, undo history and scroll survive ordinary
 * re-renders. An external `value` (discard, file reload) replaces the document
 * only when it really differs from what the view already holds.
 */
export function CodeEditor({
  value,
  path,
  ariaLabel,
  readOnly = false,
  onChange,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!host.current) {
      return
    }
    const instance = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions(path, ariaLabel, readOnly, (next) =>
          change.current(next),
        ),
      }),
      parent: host.current,
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // `value` is the initial document only: replacing it on every keystroke
    // would recreate the view and lose the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly, ariaLabel])

  useEffect(() => {
    const instance = view.current
    if (!instance) {
      return
    }
    const current = instance.state.doc.toString()
    if (current !== value) {
      instance.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }
  }, [value])

  return <div className={styles.host} ref={host} />
}
