const messages = {
  // Commit panel
  'commit.panel.title': 'New commit',
  'commit.panel.placeholder': 'Commit summary\n\nDescription (optional)',
  'commit.panel.messageAria': 'Commit message',
  'commit.panel.template': 'Short summary\n\nCommit message body (optional).\n',
  'commit.panel.useTemplate': 'Use a template',
  'commit.panel.options': 'Commit options',
  'commit.panel.optionsAmend': 'amend on',
  'commit.panel.optionsEmpty': 'empty commit allowed',
  'commit.panel.amend': 'Amend',
  'commit.panel.keepMessage': 'Keep the message',
  'commit.panel.allowEmpty': 'Allow an empty commit',
  'commit.panel.skipHooks': 'Skip hooks',
  'commit.panel.skipHooksHint':
    'Disables every hook for this commit only; the choice is not remembered.',
  'commit.panel.identity': 'Identity and signature',
  'commit.panel.signature': 'Signature: {state}',
  'commit.panel.signatureEnabled': 'enabled by Git',
  'commit.panel.signatureDisabled': 'not configured',
  'commit.panel.signatureKey': 'key {key}',
  'commit.panel.signatureFormat': 'format {format}',
  'commit.panel.loadingConfig': 'Reading the configuration…',
  'commit.panel.hooksNotice':
    'Hooks and the signature configured in Git are honoured.',
  'commit.panel.hooksRunning': 'Git hooks — running',
  'commit.panel.hooksOutput': 'Git hooks output',
  'commit.panel.submitTitle': 'Create the commit · ⌘/Ctrl + Enter',
  'commit.panel.creating': 'Creating…',
  'commit.panel.amendCommit': 'Amend the commit',
  'commit.panel.createEmpty': 'Create an empty commit',
  'commit.panel.createWithFiles.one': 'Create the commit · {count} file',
  'commit.panel.createWithFiles.other': 'Create the commit · {count} files',
  'commit.panel.needFiles': 'Stage files before committing',
  'commit.panel.enterKey': 'Enter',
  'commit.panel.toCommit': 'to commit',
  'commit.panel.conflictsHint': 'Resolve the conflicts before committing.',
  'commit.panel.created': 'created',
  'commit.panel.signed': '(signed)',
  'commit.panel.copySha': 'Copy the SHA',
  'commit.panel.shaCopied': 'SHA copied',
  'commit.panel.undoCommit': 'Undo the commit',
  'commit.panel.undoing': 'Undoing…',

  // Amend dialog
  'commit.amend.title': 'Amend {target}',
  'commit.amend.rewritesHistory': 'Amending rewrites history:',
  'commit.amend.replaced': 'is replaced by a new commit.',
  'commit.amend.branchHint':
    'Branch {branch} will point to the new commit. If it is already pushed, a push --force-with-lease will be needed and the other clones will have to resynchronise.',
  'commit.amend.detachedHint':
    'HEAD is detached: the amended commit will not be referenced by any branch until you create one.',
  'commit.amend.loading': 'Reading the commit…',
  'commit.amend.truncatedNotice':
    'The message exceeds the read limit and cannot be edited here; only the staged changes will be amended.',
  'commit.amend.messageLabel': 'Commit message',
  'commit.amend.messageAria': 'Commit message to amend',
  'commit.amend.staged.one':
    '{count} staged file will be included in the amended commit.',
  'commit.amend.staged.other':
    '{count} staged files will be included in the amended commit.',
  'commit.amend.noStaged':
    'No staged changes: only the message will be modified. Stage files in the Status tab to include them.',
  'commit.amend.noChanges':
    'Modify the message or stage files to be able to amend.',
  'commit.amend.headMoved':
    'HEAD has changed since it was opened: Git would no longer amend the displayed commit. Close this dialog and start the amend again.',
  'commit.amend.amending': 'Amending…',
  'commit.amend.submit': 'Amend the commit',

  // Tag dialog
  'commit.tag.title': 'Create a tag',
  'commit.tag.titleAnnotated': 'Create an annotated tag',
  'commit.tag.pointsTo': 'The tag points at',
  'commit.tag.pushHint':
    'Pushing a tag stays an explicit action from the Tags tab.',
  'commit.tag.nameAria': 'Tag name',
  'commit.tag.namePlaceholder': 'v1.0.0',
  'commit.tag.namePlaceholderRc': 'v1.0.0-rc1',
  'commit.tag.messageAria': 'Annotated tag message',
  'commit.tag.messagePlaceholder': 'chore(release): prepare the release',
  'commit.tag.creating': 'Creating…',
  'commit.tag.submit': 'Create the tag',

  // Worktree dialog
  'commit.worktree.title': 'Create a worktree',
  'commit.worktree.description': 'A second working copy of',
  'commit.worktree.shared':
    'The repository stays shared: a branch can only be checked out in a single worktree at a time.',
  'commit.worktree.destinationLabel': 'Destination folder',
  'commit.worktree.pathPlaceholder': '/Users/you/src/project-feature',
  'commit.worktree.pathAria': 'Worktree folder',
  'commit.worktree.choose': 'Choose…',
  'commit.worktree.newBranchLabel': 'New branch (optional)',
  'commit.worktree.branchPlaceholder': 'feature/new-feature',
  'commit.worktree.branchAria': 'New branch of the worktree',
  'commit.worktree.detach': 'Detached HEAD',
  'commit.worktree.creating': 'Creating…',
  'commit.worktree.submit': 'Create the worktree',

  // Stash panel
  'commit.stash.title': 'Create a stash',
  'commit.stash.messageLabel': 'Stash message (optional)',
  'commit.stash.messagePlaceholder': 'Stash message',
  'commit.stash.messageAria': 'Stash message',
  'commit.stash.includeUntracked': 'Include untracked files',
  'commit.stash.create': 'Create the stash',
  'commit.stash.notice':
    'Untracked files are never included implicitly. A pop that conflicts leaves the stash intact.',
  'commit.stash.conflictsNotice':
    'Stash applied with {count} conflict(s) ({files}); the stash is kept until they are resolved.',
  'commit.stash.listTitle': 'Stashes ({count})',
  'commit.stash.emptyTitle': 'No stash recorded',
  'commit.stash.emptyHint':
    'Set your changes aside to pick them up later.',
  'commit.stash.applyAndDrop': 'Apply and drop',
  'commit.stash.delete': 'Delete…',
  'commit.stash.createdNotice': 'Stash created.',
  'commit.stash.appliedNotice': 'Stash {selector} applied.',
  'commit.stash.poppedNotice': 'Stash {selector} popped.',
  'commit.stash.droppedNotice': 'Stash deleted · SHA {sha}',
  'commit.stash.deleteTitle': 'Delete {selector}',
  'commit.stash.deleteConsequence':
    'The stash entry {selector} will be deleted. The commit {sha} stays recoverable through the Git reflog, without any undo interface.',
}

export default messages
