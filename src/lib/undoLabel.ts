import { getLocale, plural, t } from '../i18n'
import type { UndoEntry } from '../types/git'

/**
 * Action labels persisted by the backend are French free text built from a
 * closed set of templates (`crates/app/src/commands/*.rs`), because they are
 * stored in SQLite at mutation time and must stay readable in the journal.
 *
 * The interface renders them through the catalogue instead of the raw string.
 * Parsing those templates is deterministic — they are produced by `format!`
 * from fixed literals — and an unknown label simply falls back to the stored
 * text, so a new backend action never breaks the UI.
 */
type Matcher = {
  pattern: RegExp
  render: (params: Record<string, string>) => string
}

const MATCHERS: Matcher[] = [
  {
    pattern: /^cherry-pick de (\d+) commit/,
    render: (p) =>
      plural('shell.undo.label.cherryPick.one', 'shell.undo.label.cherryPick.other', Number(p.count), p),
  },
  {
    pattern: /^revert de (\d+) commit/,
    render: (p) =>
      plural('shell.undo.label.revert.one', 'shell.undo.label.revert.other', Number(p.count), p),
  },
  {
    pattern: /^rebase interactif sur (.+)$/,
    render: (p) => t('shell.undo.label.rebaseInteractive', p),
  },
  { pattern: /^merge de (.+) dans (.+)$/, render: (p) => t('shell.undo.label.mergeInto', p) },
  { pattern: /^rebase de (.+) sur (.+)$/, render: (p) => t('shell.undo.label.rebaseFrom', p) },
  { pattern: /^rebase sur (.+)$/, render: (p) => t('shell.undo.label.rebase', p) },
  { pattern: /^merge de (.+)$/, render: (p) => t('shell.undo.label.merge', p) },
  { pattern: /^checkout de (.+) sur (.+)$/, render: (p) => t('shell.undo.label.checkoutAt', p) },
  { pattern: /^renommage de (.+) en (.+)$/, render: (p) => t('shell.undo.label.branchRename', p) },
  { pattern: /^suppression de la branche (.+)$/, render: (p) => t('shell.undo.label.branchDelete', p) },
  { pattern: /^suppression de (\d+) branches$/, render: (p) => t('shell.undo.label.branchDeleteMany', p) },
  { pattern: /^création de la branche (.+)$/, render: (p) => t('shell.undo.label.branchCreate', p) },
  { pattern: /^création du tag (.+)$/, render: (p) => t('shell.undo.label.tagCreate', p) },
  { pattern: /^suppression du tag (.+)$/, render: (p) => t('shell.undo.label.tagDelete', p) },
  { pattern: /^ajout du remote (.+)$/, render: (p) => t('shell.undo.label.remoteAdd', p) },
  { pattern: /^suppression du remote (.+)$/, render: (p) => t('shell.undo.label.remoteRemove', p) },
  { pattern: /^création du worktree (.+)$/, render: (p) => t('shell.undo.label.worktreeAdd', p) },
  { pattern: /^suppression du worktree (.+)$/, render: (p) => t('shell.undo.label.worktreeRemove', p) },
  { pattern: /^stash « (.*) »$/, render: (p) => t('shell.undo.label.stash', p) },
  { pattern: /^reset (.+)$/, render: (p) => t('shell.undo.label.reset', p) },
  { pattern: /^checkout (.+)$/, render: (p) => t('shell.undo.label.checkout', p) },
  { pattern: /^amend du commit$/, render: () => t('shell.undo.label.commitAmend', {}) },
  { pattern: /^commit$/, render: () => t('shell.undo.label.commit', {}) },
]

/** Field order of each matcher, matching its capture groups. */
const PARAM_NAMES: string[][] = [
  ['count'],
  ['count'],
  ['upstream'],
  ['source', 'target'],
  ['target', 'source'],
  ['upstream'],
  ['target'],
  ['name', 'start'],
  ['old', 'new'],
  ['name'],
  ['count'],
  ['name'],
  ['name'],
  ['name'],
  ['name'],
  ['name'],
  ['path'],
  ['path'],
  ['message'],
  ['revision'],
  ['ref'],
  [],
  [],
]

/**
 * Translate a stored action label. French is the source language, so the stored
 * text is already correct and returned untouched; other languages map through
 * the catalogue.
 */
export function undoActionLabel(record: Pick<UndoEntry, 'label'>): string {
  const raw = record.label
  if (getLocale() === 'fr') {
    return raw
  }
  for (const [index, matcher] of MATCHERS.entries()) {
    const match = matcher.pattern.exec(raw)
    if (!match) {
      continue
    }
    const params: Record<string, string> = {}
    PARAM_NAMES[index].forEach((name, position) => {
      params[name] = match[position + 1] ?? ''
    })
    return matcher.render(params)
  }
  return raw
}

/** "Undo" / "Redo" entry label, e.g. `Undo · create branch feat`. */
export function undoButtonLabel(record: UndoEntry, direction: 'undo' | 'redo'): string {
  return t(direction === 'undo' ? 'shell.undo.action' : 'shell.undo.redoAction', {
    action: undoActionLabel(record),
  })
}

/** Confirmation notice after a successful undo or redo. */
export function undoNotice(record: UndoEntry, direction: 'undo' | 'redo'): string {
  return t(direction === 'undo' ? 'shell.undo.done' : 'shell.undo.redone', {
    action: undoActionLabel(record),
  })
}
