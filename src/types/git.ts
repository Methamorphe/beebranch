export type AppError = {
  code: string
  category: string
  message: string
  detail?: string
  remediation?: string
  retryable: boolean
  operationId?: string
}

export type HeadState =
  | { kind: 'branch'; name: string; upstream?: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'unborn'; branch?: string }

export type InProgressOperation =
  | { kind: 'merge' }
  | { kind: 'rebase'; variant: 'merge' | 'apply' }
  | { kind: 'cherryPick' }
  | { kind: 'revert' }
  | { kind: 'sequencer'; sequencer: 'cherryPick' | 'revert' }
  | { kind: 'bisect' }

export type RepoState = {
  head?: HeadState
  operation?: InProgressOperation
  conflicts: { files: string[] }
  worktree: {
    staged: number
    unstaged: number
    untracked: number
    conflicted: number
  }
  sequencer?: 'cherryPick' | 'revert'
}

export type RepoInfo = {
  repoId: string
  name: string
  worktree: string
  gitDir: string
  commonDir: string
  bare: boolean
  linkedWorktree: boolean
  submodule: boolean
  superproject?: string
  shallow: boolean
  gitVersion?: string
}

export type RepoView = {
  repo: RepoInfo
  state: RepoState
  generation: number
  created: boolean
  locks: string[]
}

export type RecentRepo = {
  repoId: string
  path: string
  name?: string
  lastOpenedAt: number
}

export type Generation<T> = {
  data: T
  generation: number
}

export type StatusEntry = {
  kind: 'ordinary' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored'
  path: string
  origPath?: string
  index: string
  worktree: string
  submodule?: string
  similarity?: number
  stages?: {
    base?: string
    ours?: string
    theirs?: string
  }
}

export type StatusReport = {
  branch: {
    oid?: string
    head?: string
    detached: boolean
    unborn: boolean
    upstream?: string
    ahead: number
    behind: number
  }
  entries: StatusEntry[]
  ignored: string[]
  counts: {
    staged: number
    unstaged: number
    untracked: number
    conflicted: number
  }
  truncated: boolean
}

export type RefEntry = {
  fullName: string
  name: string
  kind: 'branch' | 'remoteBranch' | 'tag' | 'other'
  targetOid: string
  objectType: string
  upstream?: string
  isHead: boolean
  remote?: string
  symref?: string
}

export type RefsSnapshot = {
  head?: { fullName: string; name: string; oid?: string }
  entries: RefEntry[]
  remotes: string[]
  remoteUrls?: { name: string; url: string; direction: string }[]
}

export type CommitIdentity = {
  name: string
  email: string
  timestamp: number
}

export type CommitSummary = {
  sha: string
  parents: string[]
  author: CommitIdentity
  committer: CommitIdentity
  refs: string[]
  subject: string
}

/** One vertical lane segment inside a row. `fromTop`/`toBottom` tell where the
 * segment starts and stops, so a lane can open below a commit or end on it. */
export type LaneSpan = {
  lane: number
  fromTop: boolean
  toBottom: boolean
}

export type GraphRow = {
  nodeLane: number
  laneCount: number
  rails: LaneSpan[]
  /** Lanes whose line ends on this commit: the corner is rounded above the
   * centerline, so the branch joins the node from above. */
  arrivals: number[]
  /** Lanes opened below the commit for its 2nd..nth parents. */
  departures: number[]
  overflow: boolean
  /** Stash selector when the row stands for a stash entry (`stash@{0}`). */
  stash?: string
}

export type GraphPage = {
  commits: CommitSummary[]
  rows: GraphRow[]
  next?: string
  generation: number
  truncated: boolean
}

export type CommitFile = {
  path: string
  oldPath?: string
  status: string
  additions?: number
  deletions?: number
  binary: boolean
  /** Revision holding the new side when it is not the commit itself (stash untracked files). */
  revision?: string
}

export type CommitDetail = {
  summary: CommitSummary
  message: string
  files: CommitFile[]
  filesTruncated: boolean
  messageTruncated: boolean
  /** Set when the commit is a stash entry. */
  stash?: { selector: string; untracked?: string }
  /** Signature verification code from Git (`G`, `B`, `U`, `N`, …). */
  signature?: string
}

export type DiffLineKind = 'context' | 'added' | 'removed'

export type DiffLine = {
  kind: DiffLineKind
  oldLineno?: number
  newLineno?: number
  content: string
  noNewline: boolean
}

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  section: string
  lines: DiffLine[]
}

export type FileDiff = {
  oldPath: string
  newPath: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
  binary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
  truncated: boolean
  fingerprint?: string
}

export type DiffReport = {
  files: FileDiff[]
  truncated: boolean
}

export type FileContent = {
  path: string
  revision: string
  /** `null` when the path is absent at that revision or the bytes are binary. */
  content: string | null
  bytes: number
  truncated: boolean
  binary: boolean
  /** SHA-256 of the returned bytes; the editor sends it back to detect external edits. */
  sha256?: string
}

export type FileWriteReport = {
  path: string
  bytes: number
  sha256: string
}

export type OperationRecord = {
  id: string
  kind: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  repoId?: string
  repoPath?: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  detail?: string
  errorCode?: string
}

export type RecoveryItem = {
  operation: OperationRecord
  repoAvailable: boolean
  state?: RepoState
  locks: string[]
  remediation: string
}

export type IntegrationMode = 'merge' | 'rebase'

/**
 * How a merge may move the target branch. The backend passes the matching Git
 * flag explicitly (`--ff`, `--ff-only`, `--no-ff`), so the choice never depends
 * on the repository's `merge.ff` configuration.
 */
export type MergeFastForward = 'auto' | 'only' | 'never'

export type BranchIntegrationPreview = {
  source: string
  target: string
  sourceSha: string
  targetSha: string
  sourceSubject?: string
  targetSubject?: string
  mode: IntegrationMode
  ahead: number
  behind: number
  fastForward: boolean
  currentBranch?: string
  requiresCheckout: boolean
  worktreeDirty: boolean
  stashRequired: boolean
  checkedOutElsewhere?: string
  operation?: InProgressOperation
  blockedReason?: string
  applicable: boolean
}

export type AutoStashOutcome = {
  selector: string
  sha: string
  popped: boolean
  conflicts: string[]
}

export type BranchIntegrationOutcome = {
  preview: BranchIntegrationPreview
  checkedOutTarget: boolean
  originalBranch?: string
  autoStash?: AutoStashOutcome
  outcome: HistoryOutcome
}

export type UpdateStatus = {
  currentVersion: string
  endpoint?: string
  rollbackEndpoint?: string
  signatureRequired: boolean
  platform: string
}

export type UpdateInfo = {
  currentVersion: string
  version: string
  publishedAt?: string
  notes?: string
  downloadUrl: string
  rollback: boolean
}

export type UpdateInstall = {
  previousVersion: string
  installedVersion: string
  restarting: boolean
}

export type WorkspaceRepo = {
  path: string
  name?: string
  addedAt: number
}

export type Workspace = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  repos: WorkspaceRepo[]
}

export type WorkspaceRepoStatus = {
  path: string
  name?: string
  available: boolean
  repoId?: string
  state?: RepoState
  error?: string
}

export type WorkspaceSyncResult = {
  path: string
  name?: string
  repoId?: string
  ok: boolean
  message: string
  errorCode?: string
  state?: RepoState
}

export type UndoEntry = {
  id: string
  kind: string
  label: string
  state:
    | 'available'
    | 'consumed'
    | 'restoring'
    | 'restoreFailed'
    | 'restoreInterrupted'
    | 'evicted'
  step?: string
  command?: string
  detail?: string
  recoverySha?: string
  createdAt: number
  position: number
  undoLabel?: string
  redoLabel?: string
}

export type UndoStatus = {
  undo?: UndoEntry | null
  redo?: UndoEntry | null
  failed: UndoEntry[]
  recent: UndoEntry[]
}

export type UndoOutcome = {
  record: UndoEntry
  generation: number
  state: RepoState
  message: string
}

export type GitlabUser = {
  id: number
  username: string
  name: string
  avatarUrl?: string
}

export type GitlabProject = {
  id: number
  name: string
  pathWithNamespace: string
  webUrl: string
  sshUrlToRepo?: string
  httpUrlToRepo?: string
  defaultBranch?: string
  lastActivityAt?: string
  description?: string
}

export type GitlabSession = {
  connected: boolean
  instance?: {
    id: string
    baseUrl: string
    displayName?: string
  }
  user?: GitlabUser
  /** `keychain` for a token entered in the app, otherwise the Git-file origin. */
  credentialSource?: string
}

export type Paged<T> = {
  items: T[]
  page: number
  perPage: number
  nextPage?: number
  total?: number
  notModified: boolean
  fromCache: boolean
}

export type ChangeEvent = {
  repoId: string
  generation: number
  areas: string[]
}

export type HunkSelection = {
  hunk: number
  lines?: number[]
}

export type PathSelection = {
  path: string
  hunks: HunkSelection[]
}

export type Fingerprint = {
  path: string
  sha256?: string
}

export type IndexResult = {
  files: string[]
  hunks: number
  patchBytes: number
}

export type MutationResult<T> = {
  data: T
  generation: number
  state: RepoState
}

export type Confirmation = {
  acknowledged: boolean
  typed?: string
}

export type CommitConfigView = {
  name: string
  email: string
  signing: boolean
  signingKey?: string
  signingFormat?: string
}

export type CommitOutcome = {
  sha: string
  output: string
  signed: boolean
  config: CommitConfigView
}

export type BranchPreflight = {
  name: string
  exists: boolean
  current: boolean
  merged: boolean
  upstream?: string
  ahead: number
  behind: number
  worktreeDirty: boolean
  sha?: string
}

export type BranchComparison = {
  ahead: number
  behind: number
}

export type PullStrategy = 'auto' | 'ffOnly' | 'rebase' | 'merge'

export type SyncKind = 'fetch' | 'pull' | 'push'

export type SyncOutcome = {
  kind: SyncKind
  output: string
  cancelled: boolean
  remoteSha?: string
  headBefore?: string | null
  headAfter?: string | null
  behindUpstream?: number | null
}

export type RemoteFetchOutcome = {
  remote: string
  outcome?: SyncOutcome
  error?: { code: string; message: string }
}

export type HistoryOutcome = {
  state: RepoState
  output: string
  conflicted: boolean
}

export type StashEntry = {
  selector: string
  sha: string
  timestamp: number
  message: string
}

export type StashOutcome = {
  output: string
  applied: boolean
  conflicts: string[]
}

export type SearchMode = 'message' | 'author' | 'sha'

export type SearchResult = {
  commits: CommitSummary[]
  next?: string
  generation: number
  depth: number
  truncated: boolean
  mode: SearchMode
}

export type ToolKind = 'editor' | 'terminal' | 'diff' | 'merge'

export type ToolDescriptor = {
  id: string
  label: string
  program: string
  args: string[]
  kind: ToolKind
}

export type ToolsReport = {
  editors: ToolDescriptor[]
  terminals: ToolDescriptor[]
  diffTools: ToolDescriptor[]
  mergeTools: ToolDescriptor[]
  configured: ToolDescriptor[]
}

export type GitlabUserRef = {
  id: number
  username: string
  name: string
  avatarUrl?: string
}

export type GitlabPipeline = {
  id: number
  status: string
  detailedStatus?: string
  refName?: string
  sha?: string
  webUrl?: string
}

export type GitlabMergeRequest = {
  projectId?: number
  iid: number
  title: string
  /** Markdown description: GitLab `description`, GitHub `body`. */
  description?: string
  state: string
  draft: boolean
  workInProgress: boolean
  sourceBranch: string
  targetBranch: string
  author: GitlabUserRef
  assignees: GitlabUserRef[]
  reviewers: GitlabUserRef[]
  labels: string[]
  detailedMergeStatus?: string
  mergeStatus?: string
  hasConflicts: boolean
  sha?: string
  webUrl: string
  updatedAt?: string
  userNotesCount: number
  headPipeline?: GitlabPipeline
}

export type PipelineState =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'neutral'
  | 'unknown'

export type RepoLink = {
  repoId: string
  instanceId: string
  projectId: number
  matchKind: string
  pathWithNamespace: string
  name: string
  webUrl: string
}

export type OperationProgress = {
  operationId: string
  repoId: string
  stream: 'stdout' | 'stderr' | 'meta'
  line: string
}

export type OperationStarted = {
  operationId: string
  repoId: string
  pid?: number
}

// --- P2 -------------------------------------------------------------------

export type WorktreeEntry = {
  path: string
  head?: string
  branch?: string
  bare: boolean
  detached: boolean
  locked?: string
  prunable?: string
  main: boolean
  changedFiles?: number
  dirty?: boolean
}

export type WorktreeReport = {
  mainWorktree: string
  entries: WorktreeEntry[]
}

export type WorktreePruneEntry = {
  path: string
  reason: string
}

export type WorktreePruneReport = {
  dryRun: boolean
  removed: WorktreePruneEntry[]
  report: WorktreeReport
}

export type BlameLine = {
  line: number
  sha: string
  author: string
  authorMail: string
  authorTime: number
  summary: string
  content: string
  previous?: string
  groupStart: boolean
}

export type BlameReport = {
  path: string
  lines: BlameLine[]
  truncated: boolean
  firstLine: number
  lastLine: number
  totalLines?: number
}

export type FileHistoryEntry = {
  sha: string
  author: string
  authorMail: string
  authorTime: number
  subject: string
  status: string
  previousPath?: string
}

export type FileHistory = {
  path: string
  follow: boolean
  entries: FileHistoryEntry[]
  truncated: boolean
}

export type GitIdentity = {
  name?: string
  email?: string
}

export type TagInfo = {
  name: string
  oid: string
  objectType: string
  annotated: boolean
  targetOid?: string
  message?: string
  tagger?: string
  taggerEmail?: string
  taggerTime?: number
}

export type RemoteInfo = {
  name: string
  fetchUrl?: string
  pushUrl?: string
}

export type TagPushReport = {
  remote: string
  reference: string
  stdout: string
  stderr: string
}

export type SubmoduleState = 'upToDate' | 'modified' | 'notInitialized' | 'conflict'

export type SubmoduleEntry = {
  path: string
  sha: string
  state: SubmoduleState
  describe?: string
  nested: boolean
}

export type SubmoduleReport = {
  entries: SubmoduleEntry[]
  truncated: boolean
}

export type PatchSource =
  | { kind: 'worktree'; paths: string[] }
  | { kind: 'index'; paths: string[] }
  | { kind: 'commit'; sha: string; paths: string[] }
  | { kind: 'range'; base: string; target: string; paths: string[] }

export type PatchReport = {
  source: string
  text: string
  files: string[]
  bytes: number
  truncated: boolean
  binary: boolean
}

export type PatchApplyReport = {
  files: string[]
  threeWay: boolean
  staged: boolean
  stderr: string
}

export type Profile = {
  id: string
  name: string
  userName: string
  userEmail: string
  defaultPull: string
  gitlabInstanceId?: string
  createdAt: number
}

export type ProfilesView = {
  profiles: Profile[]
  activeId?: string
}

export type ProfileGitlabState = {
  profileId: string
  instanceId: string
  activated: boolean
}

export type IdentityApplied = {
  profileId: string
  name: string
  email: string
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' | 'edit'

export type RebaseStep = {
  sha: string
  action: RebaseAction
  message?: string
}

export type RebaseCandidates = {
  upstream: string
  candidates: CommitSummary[]
}

export type SquashPreview = {
  commits: CommitSummary[]
  /** Commit the squashed range is replayed onto. */
  upstream: string
  /** Combined messages, oldest first. */
  message: string
}

export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none'

export type ConflictSide = {
  content: string
  bytes: number
  truncated: boolean
}

export type ConflictView = {
  path: string
  base?: ConflictSide
  ours?: ConflictSide
  theirs?: ConflictSide
  working?: ConflictSide
  binary: boolean
  tooLarge: boolean
  eol: LineEnding
  hasMarkers: boolean
  markerLines: number[]
  resolved: boolean
}

export type PathMatch = { path: string }

export type PathSearch = {
  items: PathMatch[]
  truncated: boolean
  limit: number
  next?: number
}

export type ContentMatch = {
  path: string
  line: number
  text: string
}

export type ContentSearch = {
  items: ContentMatch[]
  truncated: boolean
  limit: number
  path?: string
  next?: number
}

export type GitlabPosition = {
  baseSha: string
  startSha: string
  headSha: string
  positionType: string
  newPath?: string
  oldPath?: string
  newLine?: number
  oldLine?: number
}

export type GitlabNote = {
  id: number
  body: string
  author: GitlabUserRef
  createdAt?: string
  updatedAt?: string
  system: boolean
  resolvable: boolean
  resolved: boolean
  position?: GitlabPosition
}

export type GitlabDiscussion = {
  id: string
  individualNote: boolean
  notes: GitlabNote[]
}

export type GitlabMergeRequestMerge = {
  sha?: string
  mergeMethod?: string
  squash: boolean
  removeSourceBranch: boolean
  autoMerge: boolean
  confirmation: { acknowledged: boolean }
}

export type GitlabApprovals = {
  approvalsRequired: number
  approvalsLeft: number
  approvedBy: { user: GitlabUserRef }[]
  /** Reviewers whose latest decisive review asks for changes (GitHub). */
  changesRequestedBy?: { user: GitlabUserRef }[]
}

export type ApprovalsDto = {
  available: boolean
  state?: GitlabApprovals
  reason?: string
}

export type GitlabJob = {
  id: number
  name: string
  stage: string
  status: string
  webUrl?: string
  duration?: number
  createdAt?: string
  finishedAt?: string
}

export type JobsDto = {
  pipelineId?: number
  items: GitlabJob[]
  nextPage?: number
  perPage: number
  total?: number
}

export type JobLog = {
  text: string
  truncated: boolean
  bytes: number
  sourceUrl: string
  offset: number
  nextOffset?: number
}

export type GitlabDiffRefs = {
  baseSha: string
  startSha: string
  headSha: string
}

// --- GitHub ---------------------------------------------------------------
// The backend normalizes GitHub payloads to the same shapes as GitLab so the
// review panel and detail extras are shared. Only provider-specific facts
// (repository full name on search results) are added.

export type GithubUser = GitlabUser
export type GithubProject = GitlabProject
export type GithubSession = GitlabSession
export type GithubUserRef = GitlabUserRef
export type GithubPipeline = GitlabPipeline
export type GithubMergeRequest = GitlabMergeRequest & { repositoryName?: string }
export type GithubNote = GitlabNote
export type GithubDiscussion = GitlabDiscussion
export type GithubPosition = GitlabPosition
export type GithubApprovals = GitlabApprovals
export type GithubJob = GitlabJob
export type GithubDiffRefs = GitlabDiffRefs
