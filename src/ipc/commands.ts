import { call } from './client'
import type {
  AppInfo,
} from '../types/app'
import type {
  CommitDetail,
  DiffReport,
  FileContent,
  Generation,
  GitlabProject,
  GitlabSession,
  GraphPage,
  OperationRecord,
  Paged,
  RecentRepo,
  RefsSnapshot,
  RepoView,
  StatusReport,
  UndoEntry,
  UndoOutcome,
  UndoStatus,
  UpdateInfo,
  UpdateInstall,
  UpdateStatus,
  Workspace,
  WorkspaceRepoStatus,
  WorkspaceSyncResult,
} from '../types/git'

export function appInfo(): Promise<AppInfo> {
  return call<AppInfo>('app_info')
}

export function repoOpen(path: string): Promise<RepoView> {
  return call<RepoView>('repo_open', { path })
}

export type InitInput = {
  destination: string
  initialBranch?: string
}

export function repoInit(input: InitInput): Promise<RepoView> {
  return call<RepoView>('repo_init', { request: input })
}

export type CloneInput = {
  url: string
  destination: string
  branch?: string
  depth?: number
  recurseSubmodules?: boolean
}

export function repoClone(input: CloneInput): Promise<RepoView> {
  return call<RepoView>('repo_clone', { request: input })
}

export function repoClose(repoId: string): Promise<boolean> {
  return call<boolean>('repo_close', { repoId })
}

export function repoCloseChecked(
  repoId: string,
  confirmation?: { acknowledged: boolean; typed?: string },
): Promise<boolean> {
  return call<boolean>('repo_close_checked', { repoId, confirmation })
}

export function repoListOpen(): Promise<RepoView['repo'][]> {
  return call<RepoView['repo'][]>('repo_list_open')
}

export function repoListRecent(limit = 20): Promise<RecentRepo[]> {
  return call<RecentRepo[]>('repo_list_recent', { limit })
}

export function repoGetState(repoId: string): Promise<RepoView> {
  return call<RepoView>('repo_get_state', { repoId })
}

export function repoRefresh(repoId: string): Promise<RepoView> {
  return call<RepoView>('repo_refresh', { repoId })
}

export function statusGet(
  repoId: string,
  maxEntries?: number,
  includeIgnored = false,
): Promise<Generation<StatusReport>> {
  return call<Generation<StatusReport>>('status_get', {
    repoId,
    maxEntries,
    includeIgnored,
  })
}

export function refsGet(repoId: string): Promise<Generation<RefsSnapshot>> {
  return call<Generation<RefsSnapshot>>('refs_get', { repoId })
}

export function graphPage(
  repoId: string,
  request: { after?: string; limit?: number },
  revision?: string,
  allRefs?: boolean,
): Promise<GraphPage> {
  return call<GraphPage>('graph_page', { repoId, request, revision, allRefs })
}

export function commitGet(repoId: string, sha: string): Promise<Generation<CommitDetail>> {
  return call<Generation<CommitDetail>>('commit_get', { repoId, sha })
}

export type DiffRequest = {
  target: 'worktree' | 'index' | 'commit' | 'range'
  base?: string
  targetRef?: string
  path?: string
  contextLines?: number
  untracked?: boolean
  /** Enables hunk/line staging controls in the diff view. */
  allowActions?: boolean
}

export function diffGet(
  repoId: string,
  request: DiffRequest,
): Promise<Generation<DiffReport>> {
  return call<Generation<DiffReport>>('diff_get', { repoId, request })
}

/**
 * Read one text file for the in-app renderer.
 *
 * `revision` is `worktree` (default), `index`, `head`, or any Git revspec.
 */
export function fileContentGet(input: {
  repoId: string
  path: string
  revision?: string
  maxBytes?: number
}): Promise<FileContent> {
  return call<FileContent>('file_content_get', {
    repoId: input.repoId,
    request: {
      path: input.path,
      revision: input.revision,
      maxBytes: input.maxBytes,
    },
  })
}

export function recoveryList(): Promise<
  {
    operation: OperationRecord
    repoAvailable: boolean
    state?: unknown
    locks: string[]
    remediation: string
  }[]
> {
  return call('recovery_list')
}

export function diagnosticsExport(): Promise<string> {
  return call<string>('diagnostics_export')
}

export type GitlabConfigureInput = {
  baseUrl: string
  token: string
  caPem?: string
  displayName?: string
  allowInsecure?: boolean
}

export function gitlabConfigure(input: GitlabConfigureInput): Promise<GitlabSession> {
  return call<GitlabSession>('gitlab_configure', { input })
}

export function gitlabStatus(): Promise<GitlabSession> {
  return call<GitlabSession>('gitlab_status')
}

export function gitlabProjectsPage(input: {
  search?: string
  page?: number
  perPage?: number
}): Promise<Paged<GitlabProject>> {
  return call<Paged<GitlabProject>>('gitlab_projects_page', { input })
}

export function gitlabDisconnect(): Promise<boolean> {
  return call<boolean>('gitlab_disconnect')
}

import type {
  BranchComparison,
  BranchIntegrationOutcome,
  BranchIntegrationPreview,
  BranchPreflight,
  CommitConfigView,
  CommitOutcome,
  Confirmation,
  Fingerprint,
  GitlabMergeRequest,
  GitlabPipeline,
  HistoryOutcome,
  IndexResult,
  IntegrationMode,
  MutationResult,
  PathSelection,
  PullStrategy,
  RepoLink,
  SearchMode,
  SearchResult,
  StashEntry,
  StashOutcome,
  SyncOutcome,
  ToolDescriptor,
  ToolKind,
  ToolsReport,
} from '../types/git'

export function fileFingerprints(
  repoId: string,
  paths: string[],
): Promise<Fingerprint[]> {
  return call<Fingerprint[]>('file_fingerprints', { repoId, paths })
}

export function indexStage(
  repoId: string,
  selections: PathSelection[],
): Promise<MutationResult<IndexResult>> {
  return call<MutationResult<IndexResult>>('index_stage', {
    request: { repoId, selections },
  })
}

export function indexUnstage(
  repoId: string,
  selections: PathSelection[],
): Promise<MutationResult<IndexResult>> {
  return call<MutationResult<IndexResult>>('index_unstage', {
    request: { repoId, selections },
  })
}

export function indexDiscard(
  repoId: string,
  selections: PathSelection[],
  expected: Fingerprint[],
  confirmation: Confirmation,
): Promise<MutationResult<IndexResult>> {
  return call<MutationResult<IndexResult>>('index_discard', {
    request: { repoId, selections, expected, confirmation },
  })
}

export function indexIgnore(
  repoId: string,
  pattern: string,
): Promise<MutationResult<string>> {
  return call<MutationResult<string>>('index_ignore', {
    request: { repoId, pattern },
  })
}

export function commitConfig(repoId: string): Promise<CommitConfigView> {
  return call<CommitConfigView>('commit_config', { repoId })
}

export function commitCreate(input: {
  repoId: string
  message: string
  amend?: boolean
  keepMessage?: boolean
  allowEmpty?: boolean
}): Promise<MutationResult<CommitOutcome>> {
  return call<MutationResult<CommitOutcome>>('commit_create', {
    request: input,
  })
}

export function branchPreflight(
  repoId: string,
  name: string,
): Promise<BranchPreflight> {
  return call<BranchPreflight>('branch_preflight', { repoId, name })
}

export function branchCreate(input: {
  repoId: string
  name: string
  start?: string
  checkout?: boolean
}): Promise<MutationResult<BranchPreflight>> {
  return call<MutationResult<BranchPreflight>>('branch_create', { request: input })
}

export function branchCheckout(input: {
  repoId: string
  name?: string
  detachedAt?: string
}): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('branch_checkout', { request: input })
}

export function branchCheckoutAt(input: {
  repoId: string
  name: string
  start: string
}): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('branch_checkout_at', { request: input })
}

export function branchRename(input: {
  repoId: string
  old: string
  new: string
}): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('branch_rename', { request: input })
}

export function branchDelete(input: {
  repoId: string
  name: string
  confirmation: Confirmation
}): Promise<MutationResult<string>> {
  return call<MutationResult<string>>('branch_delete', { request: input })
}

export function branchDeleteMany(input: {
  repoId: string
  names: string[]
  confirmation: Confirmation
}): Promise<MutationResult<string[]>> {
  return call<MutationResult<string[]>>('branch_delete_many', { request: input })
}

export function branchDeleteRemote(input: {
  repoId: string
  remote: string
  branch: string
  confirmation: Confirmation
}): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('branch_delete_remote', { request: input })
}

export function branchUpstream(input: {
  repoId: string
  branch: string
  upstream?: string
}): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('branch_upstream', { request: input })
}

export function branchCompare(
  repoId: string,
  base: string,
  target: string,
): Promise<BranchComparison> {
  return call<BranchComparison>('branch_compare', { repoId, base, target })
}

export function branchIntegrationPreview(input: {
  repoId: string
  source: string
  target: string
  mode: IntegrationMode
}): Promise<BranchIntegrationPreview> {
  return call<BranchIntegrationPreview>('branch_integration_preview', {
    request: input,
  })
}

export function branchIntegrationStart(input: {
  repoId: string
  source: string
  target: string
  mode: IntegrationMode
  noFf?: boolean
  confirmation: Confirmation
}): Promise<MutationResult<BranchIntegrationOutcome>> {
  return call<MutationResult<BranchIntegrationOutcome>>(
    'branch_integration_start',
    { request: input },
  )
}

export function syncFetch(repoId: string, remote: string): Promise<MutationResult<SyncOutcome>> {
  return call<MutationResult<SyncOutcome>>('sync_fetch', {
    request: { repoId, remote },
  })
}

export function syncPull(input: {
  repoId: string
  remote: string
  branch: string
  strategy?: PullStrategy
}): Promise<MutationResult<SyncOutcome>> {
  return call<MutationResult<SyncOutcome>>('sync_pull', { request: input })
}

export function syncPush(input: {
  repoId: string
  remote: string
  branch: string
  setUpstream?: boolean
  force?: boolean
  confirmation?: Confirmation
}): Promise<MutationResult<SyncOutcome>> {
  return call<MutationResult<SyncOutcome>>('sync_push', { request: input })
}

export function operationCancel(operationId: string): Promise<boolean> {
  return call<boolean>('operation_cancel', { request: { operationId } })
}

export function historyMerge(input: {
  repoId: string
  target: string
  noFf?: boolean
}): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('history_merge', { request: input })
}

export function historyRebase(input: {
  repoId: string
  upstream: string
}): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('history_rebase', { request: input })
}

export function operationContinue(repoId: string): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('operation_continue', { request: { repoId } })
}

export function operationSkip(repoId: string): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('operation_skip', { request: { repoId } })
}

export function operationAbort(
  repoId: string,
  confirmation: Confirmation,
): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('operation_abort', {
    request: { repoId, confirmation },
  })
}

export function conflictMarkResolved(
  repoId: string,
  path: string,
): Promise<MutationResult<null>> {
  return call<MutationResult<null>>('conflict_mark_resolved', {
    request: { repoId, path },
  })
}

export function stashList(repoId: string): Promise<StashEntry[]> {
  return call<StashEntry[]>('stash_list', { repoId })
}

export function stashCreate(input: {
  repoId: string
  message?: string
  includeUntracked?: boolean
}): Promise<MutationResult<string>> {
  return call<MutationResult<string>>('stash_create', { request: input })
}

export function stashApply(
  repoId: string,
  selector: string,
): Promise<MutationResult<StashOutcome>> {
  return call<MutationResult<StashOutcome>>('stash_apply', {
    request: { repoId, selector },
  })
}

export function stashPop(
  repoId: string,
  selector: string,
): Promise<MutationResult<StashOutcome>> {
  return call<MutationResult<StashOutcome>>('stash_pop', {
    request: { repoId, selector },
  })
}

export function stashDrop(
  repoId: string,
  selector: string,
  confirmation: Confirmation,
): Promise<MutationResult<string>> {
  return call<MutationResult<string>>('stash_drop', {
    request: { repoId, selector, confirmation },
  })
}

export function searchCommits(input: {
  repoId: string
  text: string
  mode: SearchMode
  revision?: string
  allRefs?: boolean
  depth?: number
  path?: string
  since?: string
  until?: string
  author?: string
  request?: { after?: string; limit?: number }
  operationId: string
}): Promise<SearchResult> {
  return call<SearchResult>('search_commits', { request: input })
}

export function preferenceGet(key: string): Promise<string | null> {
  return call<string | null>('preference_get', { key })
}

export function preferenceSet(key: string, value: string): Promise<void> {
  return call<void>('preference_set', { input: { key, value } })
}

export function toolsDetect(): Promise<ToolsReport> {
  return call<ToolsReport>('tools_detect')
}

export function toolConfigure(input: {
  kind: ToolKind
  program: string
  args: string[]
}): Promise<ToolDescriptor> {
  return call<ToolDescriptor>('tool_configure', { input })
}

export function toolOpen(input: {
  repoId: string
  kind: ToolKind
  path?: string
  base?: string
}): Promise<void> {
  return call<void>('tool_open', { input })
}

export function openExternalUrl(url: string): Promise<void> {
  return call<void>('open_external_url', { input: { url } })
}

export function gitlabRepoLink(repoId: string): Promise<RepoLink> {
  return call<RepoLink>('gitlab_repo_link', { repoId })
}

export function gitlabRepoLinkGet(repoId: string): Promise<RepoLink | null> {
  return call<RepoLink | null>('gitlab_repo_link_get', { repoId })
}

export function gitlabRepoLinkManual(
  repoId: string,
  projectId: number,
): Promise<RepoLink> {
  return call<RepoLink>('gitlab_repo_link_manual', { repoId, projectId })
}

export function gitlabMrPage(input: {
  projectId?: number
  scope: 'createdByMe' | 'assignedToMe' | 'reviewsForMe' | 'all'
  page?: number
  perPage?: number
  repoId?: string
}): Promise<Paged<GitlabMergeRequest>> {
  return call<Paged<GitlabMergeRequest>>('gitlab_mr_page', { input })
}

export function gitlabMrGet(
  projectId: number,
  iid: number,
): Promise<GitlabMergeRequest> {
  return call<GitlabMergeRequest>('gitlab_mr_get', { projectId, iid })
}

export function gitlabMrPipelines(
  projectId: number,
  iid: number,
): Promise<GitlabPipeline[]> {
  return call<GitlabPipeline[]>('gitlab_mr_pipelines', { projectId, iid })
}

export function gitlabMrCreate(input: {
  repoId: string
  projectId?: number
  sourceBranch: string
  targetBranch: string
  title: string
  description?: string
  draft?: boolean
  removeSourceBranch?: boolean
  squash?: boolean
  allowCollaboration?: boolean
}): Promise<GitlabMergeRequest> {
  return call<GitlabMergeRequest>('gitlab_mr_create', { input })
}

export function operationJournal(limit = 100): Promise<OperationRecord[]> {
  return call<OperationRecord[]>('operation_journal', { limit })
}

export function undoStatus(repoId: string): Promise<UndoStatus> {
  return call<UndoStatus>('undo_status', { repoId })
}

export function undoList(repoId: string, limit = 50): Promise<UndoEntry[]> {
  return call<UndoEntry[]>('undo_list', { repoId, limit })
}

export function undoFailed(limit = 50): Promise<UndoEntry[]> {
  return call<UndoEntry[]>('undo_failed', { limit })
}

export function undoAcknowledge(id: string): Promise<boolean> {
  return call<boolean>('undo_acknowledge', { id })
}

export function undoApply(repoId: string): Promise<UndoOutcome> {
  return call<UndoOutcome>('undo_apply', { repoId })
}

export function redoApply(repoId: string): Promise<UndoOutcome> {
  return call<UndoOutcome>('redo_apply', { repoId })
}

export function updateStatus(): Promise<UpdateStatus> {
  return call<UpdateStatus>('update_status')
}

export function updateCheck(): Promise<UpdateInfo | null> {
  return call<UpdateInfo | null>('update_check')
}

export function updateInstall(): Promise<UpdateInstall> {
  return call<UpdateInstall>('update_install', {
    confirmation: { acknowledged: true },
  })
}

export function updateRollback(): Promise<UpdateInstall> {
  return call<UpdateInstall>('update_rollback', {
    confirmation: { acknowledged: true },
  })
}

export function workspaceList(): Promise<Workspace[]> {
  return call<Workspace[]>('workspace_list')
}

export function workspaceCreate(name: string): Promise<Workspace> {
  return call<Workspace>('workspace_create', { request: { name } })
}

export function workspaceRename(
  workspaceId: string,
  name: string,
): Promise<Workspace> {
  return call<Workspace>('workspace_rename', {
    request: { workspaceId, name },
  })
}

export function workspaceDelete(workspaceId: string): Promise<boolean> {
  return call<boolean>('workspace_delete', { request: { workspaceId } })
}

export function workspaceAddRepo(
  workspaceId: string,
  path: string,
): Promise<Workspace> {
  return call<Workspace>('workspace_add_repo', {
    request: { workspaceId, path },
  })
}

export function workspaceRemoveRepo(
  workspaceId: string,
  path: string,
): Promise<Workspace> {
  return call<Workspace>('workspace_remove_repo', {
    request: { workspaceId, path },
  })
}

export function workspaceStatus(
  workspaceId: string,
): Promise<WorkspaceRepoStatus[]> {
  return call<WorkspaceRepoStatus[]>('workspace_status', {
    request: { workspaceId },
  })
}

export function workspaceSync(
  workspaceId: string,
  action: 'fetch' | 'pull',
  confirmation?: Confirmation,
): Promise<WorkspaceSyncResult[]> {
  return call<WorkspaceSyncResult[]>('workspace_sync', {
    request: { workspaceId, action, confirmation },
  })
}

// --- P2 -------------------------------------------------------------------

import type {
  ApprovalsDto,
  BlameReport,
  ConflictView,
  ContentSearch,
  FileHistory,
  GitIdentity,
  GitlabDiffRefs,
  GitlabDiscussion,
  GitlabNote,
  GitlabPosition,
  JobLog,
  JobsDto,
  PatchApplyReport,
  PatchReport,
  PatchSource,
  PathSearch,
  ProfileGitlabState,
  ProfilesView,
  RebaseCandidates,
  RebaseStep,
  RemoteInfo,
  SubmoduleReport,
  TagInfo,
  TagPushReport,
  WorktreeReport,
} from '../types/git'

export function worktreeList(
  repoId: string,
  includeStatus = true,
): Promise<WorktreeReport> {
  return call<WorktreeReport>('worktree_list', {
    request: { repoId, includeStatus },
  })
}

export function worktreeAdd(input: {
  repoId: string
  path: string
  reference: string
  newBranch?: string
  detach?: boolean
}): Promise<{ data: WorktreeReport; generation: number }> {
  return call('worktree_add', { request: input })
}

export function worktreeRemove(input: {
  repoId: string
  path: string
  force?: boolean
  confirmation: { acknowledged: boolean; typed?: string }
}): Promise<{ data: WorktreeReport; generation: number }> {
  return call('worktree_remove', { request: input })
}

export function worktreeLock(input: {
  repoId: string
  path: string
  reason?: string
}): Promise<{ data: WorktreeReport; generation: number }> {
  return call('worktree_lock', { request: input })
}

export function worktreeUnlock(input: {
  repoId: string
  path: string
}): Promise<{ data: WorktreeReport; generation: number }> {
  return call('worktree_unlock', { request: input })
}

export function worktreePrune(
  repoId: string,
  dryRun = false,
): Promise<{ data: WorktreeReport; generation: number }> {
  return call('worktree_prune', { request: { repoId, dryRun } })
}

export function blameGet(input: {
  repoId: string
  path: string
  start?: number
  end?: number
  maxLines?: number
}): Promise<BlameReport> {
  return call<BlameReport>('blame_get', { request: input })
}

export function fileHistoryGet(input: {
  repoId: string
  path: string
  follow?: boolean
  maxEntries?: number
  revision?: string
}): Promise<FileHistory> {
  return call<FileHistory>('file_history_get', { request: input })
}

export function commitIdentity(repoId: string): Promise<GitIdentity> {
  return call<GitIdentity>('commit_identity', { repoId })
}

export function tagList(repoId: string): Promise<TagInfo[]> {
  return call<TagInfo[]>('tag_list', { repoId })
}

export function tagCreate(input: {
  repoId: string
  name: string
  message?: string
  target?: string
  force?: boolean
}): Promise<{ data: TagInfo; generation: number }> {
  return call('tag_create', { request: input })
}

export function tagDelete(input: {
  repoId: string
  name: string
  confirmation: { acknowledged: boolean; typed?: string }
}): Promise<{ data: TagInfo[]; generation: number }> {
  return call('tag_delete', { request: input })
}

export function tagPush(input: {
  repoId: string
  remote: string
  name: string
  confirmation: { acknowledged: boolean }
}): Promise<{ data: TagPushReport; generation: number }> {
  return call('tag_push', { request: input })
}

export function remoteList(repoId: string): Promise<RemoteInfo[]> {
  return call<RemoteInfo[]>('remote_list', { repoId })
}

export function remoteAdd(input: {
  repoId: string
  name: string
  url: string
}): Promise<{ data: RemoteInfo[]; generation: number }> {
  return call('remote_add', { request: input })
}

export function remoteSetUrl(input: {
  repoId: string
  name: string
  url: string
  push?: boolean
}): Promise<{ data: RemoteInfo[]; generation: number }> {
  return call('remote_set_url', { request: input })
}

export function remoteRemove(input: {
  repoId: string
  name: string
  confirmation: { acknowledged: boolean; typed?: string }
}): Promise<{ data: RemoteInfo[]; generation: number }> {
  return call('remote_remove', { request: input })
}

export function remotePrune(input: {
  repoId: string
  name: string
}): Promise<{ data: RemoteInfo[]; generation: number }> {
  return call('remote_prune', { request: input })
}

export function submoduleList(repoId: string): Promise<SubmoduleReport> {
  return call<SubmoduleReport>('submodule_list', { repoId })
}

export function submoduleAdd(input: {
  repoId: string
  url: string
  path: string
  branch?: string
}): Promise<{ data: SubmoduleReport; generation: number }> {
  return call('submodule_add', { request: input })
}

export function submoduleUpdate(input: {
  repoId: string
  path?: string
  init?: boolean
  recursive?: boolean
  remote?: boolean
}): Promise<{ data: SubmoduleReport; generation: number }> {
  return call('submodule_update', { request: input })
}

export function submoduleSync(input: {
  repoId: string
  path?: string
  recursive?: boolean
}): Promise<{ data: SubmoduleReport; generation: number }> {
  return call('submodule_sync', { request: input })
}

export function patchCreate(input: {
  repoId: string
  source: PatchSource
}): Promise<PatchReport> {
  return call<PatchReport>('patch_create', { request: input })
}

export function patchApply(input: {
  repoId: string
  text: string
  threeWay?: boolean
  stage?: boolean
}): Promise<{ data: PatchApplyReport; generation: number }> {
  return call('patch_apply', { request: input })
}

export function patchSave(path: string, text: string): Promise<string> {
  return call<string>('patch_save', { request: { path, text } })
}

export function profilesList(): Promise<ProfilesView> {
  return call<ProfilesView>('profiles_list')
}

export function profileCreate(input: {
  name: string
  userName: string
  userEmail: string
  defaultPull?: string
  gitlabInstanceId?: string
}): Promise<ProfilesView> {
  return call<ProfilesView>('profile_create', { input })
}

export function profileUpdate(
  id: string,
  input: {
    name: string
    userName: string
    userEmail: string
    defaultPull?: string
    gitlabInstanceId?: string
  },
): Promise<ProfilesView> {
  return call<ProfilesView>('profile_update', { request: { id, input } })
}

export function profileDelete(id: string): Promise<ProfilesView> {
  return call<ProfilesView>('profile_delete', { request: { id } })
}

export function profileSetActive(id: string): Promise<ProfilesView> {
  return call<ProfilesView>('profile_set_active', { request: { id } })
}

export function profileApplyIdentity(
  id: string,
  repoId?: string,
): Promise<{ profileId: string; name: string; email: string }> {
  return call('profile_apply_identity', { request: { id, repoId } })
}

export function profileGitlabActivate(id: string): Promise<ProfileGitlabState> {
  return call<ProfileGitlabState>('profile_gitlab_activate', { request: { id } })
}

export function rebaseCandidates(
  repoId: string,
  upstream: string,
): Promise<RebaseCandidates> {
  return call<RebaseCandidates>('rebase_candidates', { request: { repoId, upstream } })
}

export function rebaseInteractive(input: {
  repoId: string
  upstream: string
  steps: RebaseStep[]
}): Promise<MutationResult<HistoryOutcome>> {
  return call<MutationResult<HistoryOutcome>>('history_rebase_interactive', {
    request: input,
  })
}

export function historyCherryPick(
  repoId: string,
  shas: string[],
): Promise<{ data: unknown; generation: number }> {
  return call('history_cherry_pick', { request: { repoId, shas } })
}

export function historyRevert(
  repoId: string,
  shas: string[],
): Promise<{ data: unknown; generation: number }> {
  return call('history_revert', { request: { repoId, shas } })
}

export function conflictGet(repoId: string, path: string): Promise<ConflictView> {
  return call<ConflictView>('conflict_get', { request: { repoId, path } })
}

export function conflictSave(input: {
  repoId: string
  path: string
  content: string
  allowMarkers?: boolean
  markResolved?: boolean
}): Promise<{ data: ConflictView; generation: number }> {
  return call('conflict_save', { request: input })
}

export function searchPaths(
  repoId: string,
  text: string,
  limit = 200,
  offset = 0,
): Promise<PathSearch> {
  return call<PathSearch>('search_paths', {
    request: { repoId, text, limit, offset },
  })
}

export function searchContent(input: {
  repoId: string
  text: string
  path?: string
  limit?: number
  offset?: number
  operationId: string
}): Promise<ContentSearch> {
  return call<ContentSearch>('search_content', { request: input })
}

export function gitlabMrDiscussions(input: {
  projectId: number
  iid: number
  page?: number
  perPage?: number
}): Promise<{ items: GitlabDiscussion[]; nextPage?: number }> {
  return call('gitlab_mr_discussions', { input })
}

export function gitlabDiscussionCreate(input: {
  projectId: number
  iid: number
  body: string
  position?: GitlabPosition
  discussionId?: string
}): Promise<GitlabDiscussion> {
  return call<GitlabDiscussion>('gitlab_discussion_create', { input })
}

export function gitlabDiscussionReply(input: {
  projectId: number
  iid: number
  body: string
  discussionId: string
}): Promise<GitlabNote> {
  return call<GitlabNote>('gitlab_discussion_reply', { input })
}

export function gitlabDiscussionResolve(input: {
  projectId: number
  iid: number
  discussionId: string
  resolved: boolean
}): Promise<GitlabDiscussion> {
  return call<GitlabDiscussion>('gitlab_discussion_resolve', { input })
}

export function gitlabApprovals(input: {
  projectId: number
  iid: number
}): Promise<ApprovalsDto> {
  return call<ApprovalsDto>('gitlab_approvals', { input })
}

export function gitlabApprove(input: {
  projectId: number
  iid: number
}): Promise<ApprovalsDto> {
  return call<ApprovalsDto>('gitlab_approve', { input })
}

export function gitlabUnapprove(input: {
  projectId: number
  iid: number
}): Promise<ApprovalsDto> {
  return call<ApprovalsDto>('gitlab_unapprove', { input })
}

export function gitlabMergeMr(input: {
  projectId: number
  iid: number
  sha?: string
  mergeMethod?: string
  squash?: boolean
  removeSourceBranch?: boolean
  autoMerge?: boolean
  confirmation: { acknowledged: boolean }
}): Promise<unknown> {
  return call('gitlab_merge_mr', { input })
}

export function gitlabMrJobs(input: {
  projectId: number
  iid: number
  page?: number
  perPage?: number
}): Promise<JobsDto> {
  return call<JobsDto>('gitlab_mr_jobs', { input })
}

export function gitlabPipelineJobs(
  input: { projectId: number; iid: number; page?: number; perPage?: number },
  pipelineId: number,
): Promise<JobsDto> {
  return call<JobsDto>('gitlab_pipeline_jobs', { input, pipelineId })
}

export function gitlabJobLog(input: {
  projectId: number
  jobId: number
  maxBytes?: number
  offset?: number
}): Promise<JobLog> {
  return call<JobLog>('gitlab_job_log', { input })
}

export function gitlabMrDiffRefs(input: {
  projectId: number
  iid: number
}): Promise<GitlabDiffRefs> {
  return call<GitlabDiffRefs>('gitlab_mr_diff_refs', { input })
}
