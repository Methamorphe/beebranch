const messages = {
  'status.entry.untracked': 'untracked',
  'status.entry.unmerged': 'conflict',
  'status.entry.renamed': 'renamed',
  'status.entry.copied': 'copied',
  'status.entry.ignored': 'ignored',

  'status.group.conflicts': 'Conflicts to resolve',
  'status.group.worktree': 'To stage',
  'status.group.index': 'Ready to commit',
  'status.group.ignored': 'Ignored',
  'status.group.unstageAll': 'Files unstaged.',
  'status.group.stageAll': 'Files staged.',
  'status.group.unstageAllAction': 'Unstage all',
  'status.group.stageAllAction': 'Stage all',
  'status.group.emptyStaged': 'Stage the files to include in the commit.',
  'status.group.emptyUnstaged': 'No file to stage.',

  'status.notice.staged': 'Staged: {path}',
  'status.notice.unstaged': 'Unstaged: {path}',
  'status.notice.discardOne': 'Irreversible discard: {path}',
  'status.notice.discardMany': 'Irreversible discard: {count} files',
  'status.notice.ignored': 'Added to .gitignore: {pattern}',
  'status.notice.mergeTool': 'Merge tool opened: {path}',
  'status.notice.editor': 'Editor opened: {path}',
  'status.notice.resolved': 'Conflict marked resolved: {path}',

  'status.error.discardUnsupported':
    'An untracked or conflicted file cannot be discarded here.',
  'status.loading': 'Reading status…',
  'status.empty': 'No status.',

  'status.bulk.staged.one': '{count} file staged.',
  'status.bulk.staged.other': '{count} files staged.',
  'status.bulk.unstaged.one': '{count} file unstaged.',
  'status.bulk.unstaged.other': '{count} files unstaged.',
  'status.bulk.selected.one': '{count} selected',
  'status.bulk.selected.other': '{count} selected',
  'status.bulk.regionAria': 'Selected files',
  'status.bulk.stage': 'Stage',
  'status.bulk.unstage': 'Unstage',
  'status.bulk.discard': 'Discard…',
  'status.bulk.discardTitle': 'Select only modified, unstaged files.',

  'status.row.select': 'Select {path}',
  'status.row.selectRange': 'Select {path} · Shift+click for a range',
  'status.row.resolve': 'Resolve',
  'status.row.unstageTitle': 'Unstage',
  'status.row.stageTitle': 'Stage this file',
  'status.row.unstageAria': 'Unstage {path}',
  'status.row.stageAria': 'Stage {path}',
  'status.row.actionsAria': 'Actions for {path}',
  'status.row.openEditor': 'Open in the editor',
  'status.row.mergeTool': 'Merge tool',
  'status.row.markResolved': 'Mark resolved',
  'status.row.ignoreFile': 'Ignore the file',
  'status.row.ignorePattern': 'Ignore {pattern}',
  'status.row.ignoreDir': 'Ignore the folder',
  'status.row.discardAction': 'Discard changes…',

  'status.filter.placeholder': 'Filter files…',
  'status.filter.aria': 'Filter paths',
  'status.filter.none': 'No file matches “{filter}”.',

  'status.view.options': 'File display options',
  'status.view.tree': 'Show as a tree',
  'status.view.treeTitle': 'Group files by folder, with collapsible folders',
  'status.view.ignored': 'Show ignored files',
  'status.view.ignoredTitle': 'Show ignored files',

  'status.locks': 'Git locks: {list}',
  'status.truncated': 'Partial list. Filter to narrow the results.',
  'status.more': '{count} more files. Narrow the filter.',

  'status.clean.title': 'Everything is up to date',
  'status.clean.body': 'No local changes. Your next commit starts here.',

  'status.discard.title': 'Irreversible discard',
  'status.discard.consequenceOne':
    '1 file ({path}): the unstaged content will be replaced by the index version.',
  'status.discard.consequenceMany':
    '{count} files ({list}): the unstaged content will be replaced by the index version.',
  'status.discard.confirm': 'Discard',
}

export default messages
