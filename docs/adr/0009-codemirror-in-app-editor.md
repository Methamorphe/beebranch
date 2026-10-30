# ADR-0009 — CodeMirror 6 for the in-app file editor

- **Status:** accepted
- **Date:** 2026-10-30
- **Decision makers:** project team

## Context

Editing a working-tree file used to open a dialog with a plain `<textarea>`.
The product direction is an IDE-like experience: the diff viewer itself switches
to edit mode, keeps the file's indentation and line endings, and highlights the
code. A textarea cannot do syntax highlighting, bracket matching, indentation or
a local undo history without a fragile overlay.

Constraints:

- Tauri webview, no Node runtime; workers must be bundled and are costly to set
  up per platform.
- Startup must stay fast: the history and diff views are used far more often
  than the editor.
- Both themes are driven by CSS variables (`--bg`, `--text`, `--accent`, lanes),
  so the editor must not ship its own hard-coded palette.
- The backend remains the only writer: encoding, atomic replace and the
  SHA-256 staleness check stay in Rust.

## Decision

1. **CodeMirror 6**, imported as modular packages (`@codemirror/state`,
   `view`, `commands`, `language`, `search`, language modes).
2. Languages: TypeScript/JavaScript (JSX/TSX), Python, Rust, JSON, Markdown,
   shell and YAML; anything else opens as plain text with the same editor.
3. The theme and the highlight style are defined once in
   `src/lib/codeMirror.ts`, mapped onto the application CSS variables.
4. The editor is **lazily loaded**: `FileEditorPane` is a separate chunk, so the
   main bundle does not grow for users who never edit.
5. The document is normalized to `\n` in memory; the original line ending
   (`\r\n` or `\n`) is re-applied on save, so editing never rewrites the file's
   EOL silently.
6. No completion, no LSP, no diagnostics: the editor highlights and edits, Git
   and the backend validate.

## Alternatives considered

| Alternative | Advantages | Disadvantages | Why rejected |
|---|---|---|---|
| Monaco | IDE-grade, familiar | ~5 MB, workers, heavy Tauri setup | Disproportionate for editing one file |
| Ace | Mature | Older theme system, less modular | Weaker TypeScript integration |
| Textarea + highlight overlay | No dependency | Fragile scroll/selection sync, no indent or brackets | Exactly the behaviour being fixed |
| `contenteditable` hand-rolled | Small | Selection, undo and IME edge cases | Too much surface to own |

## Consequences

### Positive

- The editor feels like an IDE: line numbers, active line, bracket matching,
  local undo, search, tab indentation, syntax highlighting.
- Startup cost unchanged; the 695 kB editor chunk (248 kB gzip) is fetched on the
  first edit only.
- Theming stays in one place and follows both app themes.

### Negative

- One more dependency family to keep updated; the language list must be extended
  deliberately.
- The highlight style must be reviewed when new token classes matter.
- Undo inside the editor is local; the Git-level undo stays in the shell, and the
  shortcut guard already ignores editable targets.

## References

- `src/lib/codeMirror.ts`, `src/components/CodeEditor.tsx`,
  `src/components/FileEditorPane.tsx`
- [10-design-direction](../10-design-direction.md) — interaction principles
