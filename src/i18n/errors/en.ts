/**
 * English copy for every backend error code declared in `fr.ts`.
 *
 * The record is typed on `keyof typeof fr`: a code without an English entry
 * fails the build, so the English interface can never fall back to French
 * silently for a known error. Placeholders mirror the French entry one for
 * one.
 */

import type fr from './fr'
import type { ErrorCopy } from './types'

const errors: Record<keyof typeof fr, ErrorCopy> = {
  // Generic and IPC.
  'op.cancelled': { message: 'The operation was cancelled.' },
  'input.invalid': { message: 'The provided data is invalid.' },
  'resource.not_found': { message: 'The requested resource was not found.' },
  'app.internal': { message: 'An internal error occurred.' },
  'ipc.unavailable': { message: 'The backend is unavailable.' },

  // Git failures classified from the command output.
  'repo.safe_directory': {
    message: 'The repository belongs to another user.',
    remediation: 'Add the repository to safe.directory explicitly if you trust it.',
  },
  'repo.busy': {
    message: 'Another Git process is using this repository.',
    remediation:
      'Check that no Git command is running, then try again. The lock file is never removed automatically.',
  },
  'repo.bare': {
    message: 'This operation requires a worktree.',
    remediation: 'Open a worktree linked to the repository.',
  },
  'repo.not_git': {
    message: 'This folder is not a Git repository.',
    remediation: 'Check the path or initialise a repository.',
  },
  'auth.host_key': {
    message: 'The SSH host key is not verified.',
    remediation: 'Check known_hosts or connect once over SSH to accept the host key.',
  },
  'auth.ssh_key': {
    message: 'The SSH key was rejected.',
    remediation: 'Check your SSH agent and test `ssh -T git@<host>`.',
  },
  'auth.failed': {
    message: 'Authentication failed.',
    remediation:
      'Check the token or the matching credential helper, and make sure the personal access token is valid and has not expired.',
  },
  'git.untracked_collision': {
    message: 'Untracked files would be overwritten.',
    remediation: 'Move or rename the untracked files concerned, then try again.',
  },
  'git.dirty_worktree': {
    message: 'Local changes are blocking the operation.',
    remediation: 'Commit or stash your changes, then try again.',
  },
  'git.unrelated_histories': {
    message: 'The histories share no common ancestor.',
    remediation: 'Explicitly allow `--allow-unrelated-histories` if that is what you want.',
  },
  'git.pull_not_fast_forward': {
    message: 'The pull could not fast-forward.',
    remediation:
      'The local history diverged from the remote branch: rebase or merge it, or relax `pull.ff`.',
  },
  'git.pull_strategy_missing': {
    message: 'Git requires a strategy to reconcile divergent branches.',
    remediation: 'Configure `pull.rebase` or `pull.ff`, or pick a pull strategy in BeeBranch.',
  },
  'git.non_fast_forward': {
    message: 'The push is not a fast-forward.',
    remediation: 'Fetch, then merge or rebase before pushing.',
  },
  'git.push_lease_stale': {
    message: 'The remote changed during the push.',
    remediation: 'Retry the push: the expected remote SHA is read right before every send.',
  },
  'git.unresolved_conflicts': {
    message: 'Some conflicts are not resolved.',
    remediation: 'Resolve the conflicting files, stage them, then continue.',
  },
  'git.conflict': {
    message: 'The operation produced a conflict.',
    remediation: 'Resolve the conflicts, then continue or abort the operation.',
  },
  'git.identity_missing': {
    message: 'The Git identity is incomplete.',
    remediation: 'Configure user.name and user.email.',
  },
  'git.signing_failed': {
    message: 'The commit signature failed.',
    remediation: 'Check the signing key and the GPG/SSH agent.',
  },
  'git.remote_missing': {
    message: 'The requested remote does not exist.',
    remediation: 'Check the remote configuration.',
  },
  'git.pathspec': {
    message: 'The requested path matches no file.',
    remediation: 'Check the path and its encoding.',
  },
  'git.detached': {
    message: 'HEAD is detached.',
    remediation: 'Create a branch before running this operation.',
  },
  'git.bad_ref': {
    message: 'The Git reference is unknown.',
    remediation: 'Check the branch, tag or SHA name.',
  },
  'git.shallow_unsupported': {
    message: 'The repository is shallow and does not allow this operation.',
    remediation: 'Fetch the full history (`git fetch --unshallow`).',
  },
  'git.exit_unknown': {
    message: 'The Git command failed (exit code {code}).',
    remediation: 'Check the detail for the full Git output.',
  },

  // Git process layer.
  'git.program_not_found': {
    message: 'Git was not found or is not executable.',
    remediation: 'Install Git 2.34 or later and check your PATH.',
  },
  'git.unavailable': {
    message: 'Git was not found on this machine.',
    remediation: 'Install Git, then restart the application.',
  },
  'git.spawn_failed': {
    message: 'The Git process could not be started.',
  },
  'git.invalid_argument': {
    message: 'The Git argument was rejected.',
  },
  'git.invalid_environment': {
    message: 'The Git environment variable was rejected.',
  },
  'git.io': {
    message: 'An I/O error occurred while running Git.',
  },
  'git.timeout': {
    message: 'The Git command timed out after {seconds} s.',
    remediation: 'Check the network or the repository, then try again.',
  },
  'git.exit_failure': {
    message: 'The Git command failed (exit code {code}).',
  },
  'git.version_unsupported': {
    message: 'Unsupported Git version (2.34 minimum required).',
    remediation: 'Update Git to version 2.34 or later.',
  },
  'git.version_unparsable': {
    message: 'The Git version could not be determined.',
  },
  'git.internal': {
    message: 'Internal error in the Git engine.',
  },

  // Repository, branches, tags, remotes and worktrees.
  'repo.not_open': {
    message: 'The repository is not open.',
    remediation: 'Open the repository before reading its state.',
  },
  'branch.current_delete': {
    message: 'The current branch cannot be deleted.',
  },
  'tag.missing': {
    message: 'The tag was not found.',
  },
  'push.remote_ref_missing': {
    message: 'The remote branch was not found for --force-with-lease.',
    remediation: 'Fetch the remote branch and check the remote.',
  },
  'workspace.no_remote': {
    message: 'This repository has no remote.',
  },
  'workspace.detached': {
    message: 'The pull requires a branch with an upstream.',
  },
  'workspace.no_upstream': {
    message: 'The branch has no upstream.',
  },
  'worktree.dirty': {
    message: 'This worktree contains uncommitted changes.',
    remediation:
      'Commit or discard the changes, or use the forced removal after confirmation.',
  },

  // Undo and redo.
  'undo.empty': {
    message: 'There is nothing to undo.',
  },
  'undo.precondition': {
    message: 'The repository changed since this operation.',
  },
  'undo.verify_failed': {
    message: 'The restored state does not match the expected state.',
  },
  'redo.empty': {
    message: 'There is nothing to redo.',
  },
  'redo.unsupported': {
    message: 'This operation cannot be redone.',
  },

  // External tools, patches and updates.
  'tool.missing': {
    message: 'The tool {tool} was not found.',
    remediation: 'Install the tool or specify its absolute path.',
  },
  'tool.spawn_failed': {
    message: '{program} could not be started.',
  },
  'patch.too_large': {
    message: 'The patch exceeds the 16 MiB limit.',
  },
  'patch.exists': {
    message: 'The export file already exists; choose another name.',
  },
  'patch.write_failed': {
    message: 'The patch could not be exported.',
  },
  'update.invalid_endpoint': {
    message: 'The update endpoint is invalid.',
  },
  'update.rollback_unconfigured': {
    message: 'No rollback endpoint is configured.',
  },
  'update.signature_invalid': {
    message: 'The update failed.',
    remediation:
      'No unsigned binary is installed. Check the manifest and the release signature.',
  },
  'update.tls': {
    message: 'The update failed.',
    remediation:
      'No unsigned binary is installed. Check the manifest and the release signature.',
  },
  'update.timeout': {
    message: 'The update failed.',
    remediation:
      'No unsigned binary is installed. Check the manifest and the release signature.',
  },
  'update.failed': {
    message: 'The update failed.',
    remediation:
      'No unsigned binary is installed. Check the manifest and the release signature.',
  },
  'update.none': {
    message: 'No update is available.',
  },
  'update.rollback_unavailable': {
    message: 'No earlier signed version is available.',
  },

  // Local store and keychain.
  'store.database': {
    message: 'SQLite error: {error}',
    remediation: "Check the permissions of the application's data folder.",
  },
  'store.io': {
    message: 'I/O error: {error}',
    remediation: "Check the permissions of the application's data folder.",
  },
  'store.keychain': {
    message: 'Keychain error: {error}',
    remediation: "Check the permissions of the application's data folder.",
  },
  'store.invalid': {
    message: 'Invalid data: {error}',
    remediation: "Check the permissions of the application's data folder.",
  },

  // Profiles.
  'profile.no_repo': {
    message: 'No repository is open.',
  },
  'profile.gitlab_unconfigured': {
    message: 'This profile is not linked to any GitLab instance.',
  },

  // Explicit confirmation of a destructive action.
  'confirmation.required': {
    message: 'Explicit confirmation is required.',
    remediation: 'Confirm the action and its consequences explicitly.',
  },

  // Authentication, network and TLS, shared by Git, GitLab and GitHub.
  'tls.ca_required': {
    message:
      'The TLS connection to {host} failed. Import the instance CA certificate in the settings.',
    remediation: "Import the PEM certificate of the instance's internal authority.",
  },
  'tls.ca_invalid': {
    message: 'The imported CA certificate is invalid.',
    remediation: "Import the PEM certificate of the instance's internal authority.",
  },
  'network.unreachable': {
    message: 'The {host} server is unreachable.',
    remediation: 'Check the instance address, the proxy and the network connection.',
  },

  // GitLab client and commands.
  'gitlab.not_configured': {
    message: 'No GitLab instance is configured.',
    remediation: 'Enter the instance URL and a personal access token.',
  },
  'gitlab.invalid_url': {
    message: 'The GitLab instance address is invalid.',
  },
  'gitlab.insecure_url': {
    message: 'The http scheme is refused. Use https to reach GitLab.',
  },
  'gitlab.url_credentials': {
    message: 'The GitLab address must not contain credentials.',
  },
  'gitlab.configuration': {
    message: 'The GitLab client configuration is invalid.',
  },
  'gitlab.invalid_response': {
    message: 'The GitLab response could not be read.',
  },
  'gitlab.forbidden': {
    message: 'GitLab denied access: the token lacks the required permissions.',
  },
  'gitlab.not_found': {
    message: 'The requested GitLab resource was not found.',
  },
  'gitlab.conflict': {
    message: 'Conflict with the current state of the GitLab resource.',
  },
  'gitlab.validation': {
    message: 'GitLab rejected the request: a field is invalid.',
  },
  'gitlab.rate_limited': {
    message: 'GitLab is temporarily rate limiting requests.',
    remediation: 'Wait before retrying the request.',
  },
  'gitlab.server': {
    message: 'The GitLab server encountered an error.',
  },
  'gitlab.request_failed': {
    message: 'The GitLab request failed.',
  },
  'gitlab.no_git_credential': {
    message: 'No Git credential is configured for {host}.',
    remediation:
      'Authenticate once with Git for this host, or enter a personal access token.',
  },
  'gitlab.no_remote': {
    message: 'No usable Git remote is configured.',
    remediation: 'Add an SSH or HTTPS remote pointing to the GitLab instance.',
  },
  'gitlab.project_not_found': {
    message: 'No GitLab project matches the repository remotes.',
    remediation: 'Check the remote URL or link the project manually.',
  },
  'gitlab.project_not_linked': {
    message: 'No GitLab project is linked to the repository.',
  },
  'gitlab.branch_not_pushed': {
    message: 'The branch {branch} is not present on the remote {remote}.',
    remediation: 'Push the branch before creating the merge request.',
  },
  'gitlab.discussion_invalid': {
    message: 'GitLab rejected the discussion (422).',
    remediation:
      'Check that the `diff_refs` SHAs and the targeted line still exist in the merge request.',
  },
  'gitlab.merge_not_allowed': {
    message: 'The merge request cannot be merged in its current state.',
    remediation:
      'Check the required checks, conflicts, draft status and your rights on the project.',
  },
  'gitlab.merge_conflict': {
    message: 'GitLab reports that the branch cannot be merged (406).',
    remediation: 'Update the branch and resolve the conflicts.',
  },
  'gitlab.merge_stale': {
    message: 'The merge request changed since you read it (409).',
    remediation: 'Reload the merge request, then try the merge again.',
  },
  'gitlab.token_missing': {
    message: 'No token is available for this instance.',
  },

  // GitHub client and commands.
  'github.not_configured': {
    message: 'No GitHub instance is configured.',
    remediation: 'Enter the instance URL and a personal access token.',
  },
  'github.invalid_url': {
    message: 'The GitHub instance address is invalid.',
  },
  'github.insecure_url': {
    message: 'The http scheme is refused. Use https to reach GitHub.',
  },
  'github.url_credentials': {
    message: 'The GitHub address must not contain credentials.',
  },
  'github.configuration': {
    message: 'The GitHub client configuration is invalid.',
  },
  'github.invalid_response': {
    message: 'The GitHub response could not be read.',
  },
  'github.forbidden': {
    message: 'GitHub denied access: the token lacks the required permissions.',
  },
  'github.not_found': {
    message: 'The requested GitHub resource was not found.',
  },
  'github.conflict': {
    message: 'Conflict with the current state of the GitHub resource.',
  },
  'github.validation': {
    message: 'GitHub rejected the request: a field is invalid.',
  },
  'github.rate_limited': {
    message: 'GitHub is temporarily rate limiting requests.',
    remediation: 'Wait before retrying the request.',
  },
  'github.server': {
    message: 'The GitHub server encountered an error.',
  },
  'github.request_failed': {
    message: 'The GitHub request failed.',
  },
  'github.not_allowed': {
    message: 'GitHub refuses this operation in the current state of the resource.',
  },
  'github.no_git_credential': {
    message: 'No Git credential is configured for {host}.',
    remediation:
      'Authenticate once with Git for this host, or enter a personal access token.',
  },
  'github.no_remote': {
    message: 'No usable Git remote is configured.',
    remediation: 'Add an SSH or HTTPS remote pointing to GitHub.',
  },
  'github.project_not_found': {
    message: 'No GitHub repository matches the repository remotes.',
    remediation: 'Check the remote URL or link the repository manually.',
  },
  'github.project_not_linked': {
    message: 'No GitHub repository is linked to the repository.',
  },
  'github.branch_not_pushed': {
    message: 'The branch {branch} is not present on the remote {remote}.',
    remediation: 'Push the branch before creating the pull request.',
  },
  'github.discussion_invalid': {
    message: 'GitHub rejected the comment (422).',
    remediation:
      'Check that the targeted commit, path and line still exist in the pull request.',
  },
  'github.merge_not_allowed': {
    message: 'The pull request cannot be merged in its current state.',
    remediation:
      'Check the required checks, conflicts, draft status and your rights on the repository.',
  },
  'github.merge_stale': {
    message: 'The pull request changed since you read it (409).',
    remediation: 'Reload the pull request, then try the merge again.',
  },
  'github.merge_conflict': {
    message: 'GitHub reports that the branch cannot be merged (422).',
    remediation: 'Update the branch and resolve the conflicts.',
  },
  'github.unsupported': {
    message: 'Resolving a thread is not exposed by the GitHub REST API.',
    remediation: 'Resolve the thread from the GitHub interface.',
  },
  'github.auto_merge_unsupported': {
    message: 'GitHub does not expose auto-merge through the REST API in use.',
    remediation: 'Merge manually or enable auto-merge in GitHub.',
  },
  'github.remove_branch_unsupported': {
    message:
      'GitHub deletes the source branch according to the repository settings, not at merge time.',
    remediation: 'Configure automatic deletion in the GitHub repository settings.',
  },
  'github.device_flow_unavailable': {
    message: 'The built-in OAuth sign-in only covers github.com.',
  },
  'github.device_flow_missing': {
    message: 'No GitHub OAuth sign-in is in progress.',
  },
  'github.device_flow_expired': {
    message: 'The GitHub sign-in code has expired. Start the sign-in again.',
  },
  'github.device_flow_denied': {
    message: 'The GitHub sign-in was denied.',
  },
  'github.device_flow_disabled': {
    message: 'The device flow is not enabled for this GitHub OAuth app.',
  },
  'github.oauth_not_configured': {
    message: 'GitHub OAuth sign-in is not configured in this build.',
  },
  'github.oauth_configuration': {
    message: 'The GitHub OAuth configuration is invalid.',
  },
  'blame.binary': { message: 'Blame is not available for a binary file.' },
  'blame.failed': { message: 'Blame failed.' },
  'blame.too_large': { message: 'The file is too large for blame.' },
  'branch.integration_blocked': { message: 'The integration cannot start.', remediation: 'Resolve the reported condition, then run the preview again.' },
  'branch.invalid_name': { message: 'The branch name is invalid.' },
  'branch.not_merged': { message: 'The branch is not merged into HEAD.', remediation: 'Use the forced deletion with explicit confirmation.' },
  'branch.source_missing': { message: 'Source branch {source} does not exist.' },
  'branch.target_missing': { message: 'Target branch {target} does not exist.' },
  'clone.askpass_failed': { message: 'Could not prepare HTTPS authentication for the clone.' },
  'clone.destination_exists': { message: 'The destination already exists.', remediation: 'Choose a folder that does not exist to avoid overwriting files.' },
  'clone.destination_missing': { message: 'The clone finished without a readable worktree.' },
  'clone.host_key': { message: 'The server’s SSH host key is not verified.', remediation: 'Add the host fingerprint to known_hosts, or clone over HTTPS with the GitLab connection.' },
  'clone.https_auth': { message: 'HTTPS authentication for the repository failed.', remediation: 'Connect the GitLab instance to use its token, or choose SSH with a declared key.' },
  'clone.not_a_repository': { message: 'The cloned folder is not a worktree.' },
  'clone.ssh_auth': { message: 'The SSH server rejected the public key.', remediation: 'Load the key into the SSH agent, check that the public key is declared in GitLab, or use HTTPS.' },
  'commit.empty': { message: 'No staged change to commit.', remediation: 'Stage some files or explicitly allow an empty commit.' },
  'commit.empty_message': { message: 'The commit message is empty.', remediation: 'Enter a message or explicitly use --allow-empty-message.' },
  'commit.failed': { message: 'The commit failed.', remediation: 'Fix the reported cause (hook, identity, signature) and try again.' },
  'conflict.markers_remaining': { message: 'The resolution still contains conflict markers.' },
  'conflict.too_large': { message: 'The resolution exceeds the 8 MiB limit.' },
  'conflict.write_failed': { message: 'The resolution could not be written.' },
  'discard.stale': { message: 'The file changed since the diff was displayed.', remediation: 'Reload the diff and discard again.' },
  'discard.untracked': { message: 'An untracked file is never deleted by the application.', remediation: 'Add it to .gitignore or delete it explicitly in your file manager.' },
  'git.merge_not_fast_forward': { message: 'Fast-forward is impossible: the target has commits the source lacks.', remediation: 'Choose a merge commit, or rebase the source branch onto the target.' },
  'git.operation_failed': { message: 'The Git operation failed.', remediation: 'Read the output, check the repository state, then try again.' },
  'git.revision_missing': { message: 'The revision was not found.' },
  'history.failed': { message: 'The file history could not be read.' },
  'hooks.unresolved': { message: 'Could not resolve the Git hooks directory.', remediation: 'Check core.hooksPath and the repository state.' },
  'ignore.symlink': { message: 'The repository’s .gitignore is a symbolic link.', remediation: 'Edit the target file explicitly; the application does not write through a link.' },
  'index.mixed_selection': { message: 'A request cannot mix whole files and hunks.', remediation: 'Run the two actions separately to keep the index consistent.' },
  'index.newline_partial': { message: 'A hunk without a trailing newline cannot be partially staged.', remediation: 'Select the whole hunk or the whole file.' },
  'index.patch_conflict': { message: 'The patch no longer applies to the current content.', remediation: 'Refresh the status and try again; nothing was applied.' },
  'index.patch_too_large': { message: 'The patch exceeds the safety limit.', remediation: 'Stage the whole file or smaller hunks.' },
  'index.path_not_changed': { message: 'The selected path does not appear in the diff.', remediation: 'Stage the whole file to preserve the rename.' },
  'index.rename_unsupported': { message: 'Partial staging of a rename is not supported.', remediation: 'Stage the whole file to preserve the rename.' },
  'init.already_repository': { message: 'This folder already contains a Git repository.', remediation: 'Open that repository instead of initializing it.' },
  'init.destination_missing': { message: 'Repository creation finished without a readable folder.' },
  'init.destination_not_directory': { message: 'The destination exists but is not a folder.', remediation: 'Choose another location.' },
  'init.not_a_repository': { message: 'The created folder is not a Git repository.' },
  'init.parent_missing': { message: 'The parent folder does not exist.', remediation: 'Create the parent folder or choose another location.' },
  'operation.abort_failed': { message: 'The operation could not be aborted.', remediation: 'Inspect the repository state before doing anything else.' },
  'operation.in_progress': { message: 'A Git operation is already in progress.', remediation: 'Finish it (continue/abort) before starting another one.' },
  'operation.none': { message: 'No Git operation is in progress.' },
  'operation.skip_unsupported': { message: 'This operation cannot be skipped.' },
  'patch.apply_failed': { message: 'The patch passed verification but could not be applied.' },
  'patch.binary_unsupported': { message: 'Binary patches are not supported.', remediation: 'Copy the file explicitly or commit it: BeeBranch does not carry binaries in a patch.' },
  'patch.conflict': { message: 'The patch does not apply to the current state; the worktree is unchanged.' },
  'patch.create_failed': { message: 'The patch could not be generated.' },
  'patch.empty': { message: 'No change matches this source.' },
  'rebase.candidates_failed': { message: 'The list of commits to rebase could not be read.' },
  'rebase.message_failed': { message: 'The commit message could not be read.' },
  'rebase.nothing_to_do': { message: 'No commit can be rebased onto this base.' },
  'rebase.plan_invalid': { message: 'Invalid rebase plan ({what}): {reason}.' },
  'remote.add_failed': { message: 'The remote could not be added.' },
  'remote.prune_failed': { message: 'Pruning the remote failed.' },
  'remote.remove_failed': { message: 'The remote could not be removed.' },
  'remote.set_url_failed': { message: 'The remote URL could not be changed.' },
  'remote.url_has_credentials': { message: 'The remote URL must not contain a password.', remediation: 'Use a credential helper or an SSH key; no secret is stored in the URL.' },
  'repo.closed': { message: 'The repository session is closed.' },
  'search.content_failed': { message: 'The content search failed.' },
  'stash.apply_failed': { message: 'The stash could not be applied.', remediation: 'Resolve the repository state, then try again.' },
  'submodule.url_has_credentials': { message: 'The submodule URL must not contain a password.' },
  'tag.create_failed': { message: 'The tag could not be created.' },
  'tag.delete_failed': { message: 'The tag could not be deleted.' },
  'tag.identity_missing': { message: 'No Git identity is configured to sign the tag.' },
  'tag.push_failed': { message: 'Pushing the tag failed.' },
  'undo.file_unreadable': { message: 'An affected file could not be read.' },
  'undo.index_unmerged': { message: 'The index contains unresolved conflicts.' },
  'undo.locked': { message: 'A Git lock prevents the undo.', remediation: 'Wait for the Git process to finish, then try again.' },
  'undo.operation_in_progress': { message: 'A Git operation is in progress.', remediation: 'Finish or explicitly abort the operation before undoing.' },
  'undo.remote_missing': { message: 'The remote was not found.' },
  'undo.stash_not_exact': { message: 'The applied stash does not exactly match the expected state; it was not dropped.' },
  'undo.unsupported': { message: 'Aborting a bisect cannot be undone.' },
  'worktree.missing': { message: 'The worktree is no longer present on disk.' },
  'worktree.path_exists': { message: 'The new worktree path already exists.' },
  'worktree.unknown': { message: 'This worktree does not belong to this repository.' },
}

export default errors
