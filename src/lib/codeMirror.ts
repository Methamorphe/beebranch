/**
 * CodeMirror setup for the in-app file editor.
 *
 * One place owns the language selection, the theme (mapped onto the app's CSS
 * variables so both themes follow) and the editing keymap. The editor keeps the
 * file's indentation and line endings: the pane re-applies the original EOL on
 * save instead of rewriting the file with `\n`.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

function languageFor(path: string): Extension {
  const extension = path.toLowerCase().split('.').pop() ?? ''
  switch (extension) {
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'json':
      return json()
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell)
    case 'yml':
    case 'yaml':
      return StreamLanguage.define(yaml)
    default:
      return []
  }
}

const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text)',
      backgroundColor: 'var(--bg)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      fontSize: '13px',
      lineHeight: '1.55',
    },
    '.cm-content': {
      padding: '10px 0',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': {
      color: 'var(--muted)',
      backgroundColor: 'var(--surface)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)',
    },
    '.cm-activeLineGutter': {
      color: 'var(--text)',
      backgroundColor: 'transparent',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      color: 'var(--accent)',
      backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
      outline: 'none',
    },
    '.cm-panels': {
      color: 'var(--text)',
      backgroundColor: 'var(--surface)',
    },
    '.cm-panels input': {
      color: 'var(--text)',
      backgroundColor: 'var(--bg)',
      border: '1px solid var(--border)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--warning) 32%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 34%, transparent)',
    },
    '.cm-tooltip': {
      color: 'var(--text)',
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--border)',
    },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'var(--info)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: 'var(--accent)',
  },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: 'var(--lane-4)' },
  { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: 'var(--text)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--muted)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.invalid, color: 'var(--error)' },
])

export function editorExtensions(
  path: string,
  ariaLabel: string,
  readOnly: boolean,
  onChange: (value: string) => void,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    EditorState.tabSize.of(2),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    languageFor(path),
    syntaxHighlighting(highlight),
    theme,
    EditorState.readOnly.of(readOnly),
    EditorView.contentAttributes.of({
      'aria-label': ariaLabel,
      'aria-multiline': 'true',
      role: 'textbox',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.doc.toString())
      }
    }),
  ]
}
