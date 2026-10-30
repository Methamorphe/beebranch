/**
 * Provider-neutral review API.
 *
 * GitLab and GitHub expose different REST models; the backend normalizes both
 * to the same DTOs. This adapter is the single place where command names and
 * provider-specific capabilities differ, so the review panel and detail view
 * stay shared.
 */

import {
  gitlabApprove,
  gitlabApprovals,
  gitlabDiscussionCreate,
  gitlabDiscussionReply,
  gitlabDiscussionResolve,
  gitlabJobCancel,
  gitlabJobLog,
  gitlabJobRetry,
  gitlabMergeMr,
  gitlabMrCreate,
  gitlabMrDiff,
  gitlabMrDiffRefs,
  gitlabMrDiscussions,
  gitlabMrGet,
  gitlabMrJobs,
  gitlabMrPage,
  gitlabMrPipelines,
  gitlabPipelineJobs,
  gitlabProjectsPage,
  gitlabRepoLink,
  gitlabRepoLinkGet,
  gitlabRepoLinkManual,
  gitlabStatus,
  gitlabUnapprove,
  gitlabRequestChanges,
  gitlabMrSetDraft,
  gitlabMrSetState,
  gitlabMrUpdate,
  githubApprove,
  githubApprovals,
  githubCancelRun,
  githubDiscussionCreate,
  githubDiscussionReply,
  githubDiscussionResolve,
  githubJobLog,
  githubMergePr,
  githubPrChecks,
  githubPrChecksRollup,
  githubPrCreate,
  githubPrDiff,
  githubPrDiffRefs,
  githubPrDiscussions,
  githubPrGet,
  githubPrJobs,
  githubPrPage,
  githubProjectsPage,
  githubRepoLink,
  githubRepoLinkGet,
  githubRepoLinkManual,
  githubRerunFailed,
  githubRunJobs,
  githubStatus,
  githubUnapprove,
  githubRequestChanges,
  githubPrSetDraft,
  githubPrSetState,
  githubPrUpdate,
} from '../ipc/commands'
import type { MessageKey, TranslationParams } from '../i18n'
import type {
  ApprovalsDto,
  DiffReport,
  GitlabDiscussion,
  GitlabJob,
  GitlabMergeRequest,
  GitlabNote,
  GitlabPipeline,
  GitlabPosition,
  GitlabProject,
  GitlabSession,
  JobLog,
  Paged,
  RepoLink,
} from '../types/git'

export type ForgeId = 'gitlab' | 'github'

/**
 * A notice kept as a catalogue key instead of a rendered string, so it
 * follows the interface language when the user switches it.
 */
export type ForgeNotice = {
  key: MessageKey
  params?: TranslationParams
} | null

/**
 * Token creation page for the entered instance, with the scopes the connector
 * requires prefilled where the forge supports it. Falls back to the forge's
 * token list when the query is ignored (older selves of GitLab).
 */
export function tokenCreateUrl(forge: ForgeId, baseUrl: string): string {
  const fallback = forge === 'github' ? 'https://github.com' : 'https://gitlab.com'
  const base = (baseUrl.trim() || fallback).replace(/\/+$/, '')
  return forge === 'github'
    ? `${base}/settings/tokens/new?scopes=repo,read:user,checks:read&description=beebranch`
    : `${base}/-/user_settings/personal_access_tokens?name=beebranch&scopes=api,read_user,read_repository`
}
export type ForgeScope = 'createdByMe' | 'reviewsForMe' | 'assignedToMe' | 'project'
export type ForgeMergeRequest = GitlabMergeRequest & { repositoryName?: string }

export type ForgeCapabilities = {
  /** REST can toggle a thread's resolved state. */
  resolveThreads: boolean
  /** Auto-merge can be requested when merging. */
  autoMerge: boolean
  /** The merge call can delete the source branch. */
  removeSourceBranchOnMerge: boolean
  /** Creation accepts "delete source branch" and "squash" options. */
  createMergeOptions: boolean
  /** Inline comments can be anchored to a diff position. */
  inlineComments: boolean
  /** A comment may carry a ```suggestion``` block applied by the provider. */
  suggestions: boolean
  /** The API exposes required/remaining approval counts. */
  approvalQuota: boolean
  /** A review can ask for changes, with a body. */
  requestChanges: boolean
  /** The request can be closed and reopened. */
  closeReopen: boolean
  /** Title and description can be edited after creation. */
  editMetadata: boolean
  /** The draft state can be toggled on an existing request. */
  draftToggle: boolean
  /** An approval can carry an optional note. */
  approvalNote: boolean
  /** Jobs can be retried and cancelled from the request detail. */
  jobControl: boolean
  /** Jobs can be loaded for a chosen pipeline, not only the latest one. */
  pipelineSelection: boolean
  /** List badges can be filled without one request per row. */
  listChecks: boolean
  /** A whole run can be re-run or cancelled. */
  runControl: boolean
}

export type ForgeApi = {
  id: ForgeId
  /** Brand name, kept verbatim in every language, e.g. `GitLab`. */
  label: string
  /** Catalogue key of the full noun, e.g. `merge request` / `pull request`. */
  nounKey: MessageKey
  /** Short badge, e.g. `MR` / `PR`. */
  short: string
  /** Catalogue key of the list title, e.g. `Merge requests`. */
  titleKey: MessageKey
  scopes: Array<{ value: ForgeScope; labelKey: MessageKey }>
  capabilities: ForgeCapabilities
  status: () => Promise<GitlabSession>
  projectsPage: (input: {
    search?: string
    page?: number
    perPage?: number
  }) => Promise<Paged<GitlabProject>>
  link: (repoId: string) => Promise<RepoLink>
  linkGet: (repoId: string) => Promise<RepoLink | null>
  linkManual: (repoId: string, projectId: number) => Promise<RepoLink>
  mrPage: (input: {
    projectId?: number
    scope: ForgeScope
    page?: number
    perPage?: number
    repoId?: string
  }) => Promise<Paged<ForgeMergeRequest>>
  mrGet: (
    projectId: number,
    iid: number,
    repositoryName?: string,
  ) => Promise<ForgeMergeRequest>
  pipelines: (projectId: number, iid: number) => Promise<GitlabPipeline[]>
  mrCreate: (input: {
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
    reviewers?: string[]
    assignees?: string[]
    labels?: string[]
  }) => Promise<ForgeMergeRequest>
  discussions: (input: {
    projectId: number
    iid: number
    page?: number
    perPage?: number
  }) => Promise<{ items: GitlabDiscussion[]; nextPage?: number }>
  discussionCreate: (input: {
    projectId: number
    iid: number
    body: string
    position?: GitlabPosition
    discussionId?: string
  }) => Promise<GitlabDiscussion>
  discussionReply: (input: {
    projectId: number
    iid: number
    body: string
    discussionId: string
  }) => Promise<GitlabNote>
  discussionResolve: (input: {
    projectId: number
    iid: number
    discussionId: string
    resolved: boolean
  }) => Promise<GitlabDiscussion>
  approvals: (input: { projectId: number; iid: number }) => Promise<ApprovalsDto>
  approve: (input: {
    projectId: number
    iid: number
    note?: string
  }) => Promise<ApprovalsDto>
  unapprove: (input: { projectId: number; iid: number }) => Promise<ApprovalsDto>
  requestChanges: (input: {
    projectId: number
    iid: number
    body: string
  }) => Promise<ApprovalsDto>
  update: (input: {
    projectId: number
    iid: number
    title?: string
    description?: string
  }) => Promise<GitlabMergeRequest>
  setOpen: (input: {
    projectId: number
    iid: number
    open: boolean
  }) => Promise<GitlabMergeRequest>
  setDraft: (input: {
    projectId: number
    iid: number
    draft: boolean
  }) => Promise<GitlabMergeRequest>
  merge: (input: {
    projectId: number
    iid: number
    sha?: string
    mergeMethod?: string
    squash?: boolean
    removeSourceBranch?: boolean
    autoMerge?: boolean
    confirmation: { acknowledged: boolean }
  }) => Promise<unknown>
  jobs: (input: {
    projectId: number
    iid: number
    /** Load the jobs of this pipeline instead of the latest one. */
    pipelineId?: number
    page?: number
    perPage?: number
  }) => Promise<{ pipelineId?: number; items: GitlabJob[]; nextPage?: number }>
  /** Present when the provider lets a job be retried. */
  retryJob?: (input: { projectId: number; jobId: number }) => Promise<void>
  /** Present when the provider lets a running job be cancelled. */
  cancelJob?: (input: { projectId: number; jobId: number }) => Promise<void>
  /** Present when list badges can be batched instead of fanned out. */
  checkRollups?: (
    projectId: number,
    numbers: number[],
  ) => Promise<Array<{ iid: number; status?: string }>>
  /** Present when a finished run can re-run its failed jobs. */
  rerunFailed?: (input: { projectId: number; runId: number }) => Promise<void>
  /** Present when a running run can be cancelled. */
  cancelRun?: (input: { projectId: number; runId: number }) => Promise<void>
  jobLog: (input: {
    projectId: number
    jobId: number
    maxBytes?: number
    offset?: number
  }) => Promise<JobLog>
  diffRefs: (input: {
    projectId: number
    iid: number
  }) => Promise<{ baseSha: string; startSha: string; headSha: string }>
  /** File patches of the request, rebuilt into the local diff report. */
  diff: (projectId: number, iid: number) => Promise<DiffReport>
}

/** GitLab scopes use `all` for the project listing. */
function gitlabScope(scope: ForgeScope): 'createdByMe' | 'assignedToMe' | 'reviewsForMe' | 'all' {
  return scope === 'project' ? 'all' : scope
}

export const gitlabForge: ForgeApi = {
  id: 'gitlab',
  label: 'GitLab',
  nounKey: 'forge.gitlab.noun',
  short: 'MR',
  titleKey: 'forge.gitlab.title',
  scopes: [
    { value: 'createdByMe', labelKey: 'forge.scope.createdByMe' },
    { value: 'reviewsForMe', labelKey: 'forge.scope.reviewsForMe' },
    { value: 'assignedToMe', labelKey: 'forge.scope.assignedToMe' },
    { value: 'project', labelKey: 'forge.scope.project' },
  ],
  capabilities: {
    resolveThreads: true,
    autoMerge: true,
    removeSourceBranchOnMerge: true,
    createMergeOptions: true,
    inlineComments: true,
    suggestions: false,
    approvalQuota: true,
    requestChanges: false,
    closeReopen: true,
    editMetadata: true,
    draftToggle: true,
    approvalNote: true,
    jobControl: true,
    pipelineSelection: true,
    listChecks: false,
    runControl: false,
  },
  status: gitlabStatus,
  projectsPage: gitlabProjectsPage,
  link: gitlabRepoLink,
  linkGet: gitlabRepoLinkGet,
  linkManual: gitlabRepoLinkManual,
  mrPage: (input) =>
    gitlabMrPage({
      projectId: input.projectId,
      scope: gitlabScope(input.scope),
      page: input.page,
      perPage: input.perPage,
      repoId: input.repoId,
    }),
  mrGet: (projectId, iid) => gitlabMrGet(projectId, iid),
  pipelines: gitlabMrPipelines,
  mrCreate: gitlabMrCreate,
  discussions: gitlabMrDiscussions,
  discussionCreate: gitlabDiscussionCreate,
  discussionReply: gitlabDiscussionReply,
  discussionResolve: gitlabDiscussionResolve,
  approvals: gitlabApprovals,
  approve: gitlabApprove,
  unapprove: gitlabUnapprove,
  requestChanges: gitlabRequestChanges,
  update: (input) =>
    gitlabMrUpdate({
      projectId: input.projectId,
      iid: input.iid,
      title: input.title,
      description: input.description,
    }),
  setOpen: gitlabMrSetState,
  setDraft: gitlabMrSetDraft,
  merge: gitlabMergeMr,
  jobs: (input) =>
    input.pipelineId !== undefined
      ? gitlabPipelineJobs(
          {
            projectId: input.projectId,
            iid: input.iid,
            page: input.page,
            perPage: input.perPage,
          },
          input.pipelineId,
        )
      : gitlabMrJobs({
          projectId: input.projectId,
          iid: input.iid,
          page: input.page,
          perPage: input.perPage,
        }),
  retryJob: async ({ projectId, jobId }) => {
    await gitlabJobRetry({ projectId, jobId })
  },
  cancelJob: async ({ projectId, jobId }) => {
    await gitlabJobCancel({ projectId, jobId })
  },
  jobLog: gitlabJobLog,
  diffRefs: gitlabMrDiffRefs,
  diff: (projectId, iid) => gitlabMrDiff({ projectId, iid }),
}

export const githubForge: ForgeApi = {
  id: 'github',
  label: 'GitHub',
  nounKey: 'forge.github.noun',
  short: 'PR',
  titleKey: 'forge.github.title',
  scopes: [
    { value: 'createdByMe', labelKey: 'forge.scope.createdByMe' },
    { value: 'reviewsForMe', labelKey: 'forge.scope.reviewsForMe' },
    { value: 'assignedToMe', labelKey: 'forge.scope.assignedToMe' },
    { value: 'project', labelKey: 'forge.scope.project' },
  ],
  capabilities: {
    resolveThreads: false,
    autoMerge: false,
    removeSourceBranchOnMerge: false,
    createMergeOptions: false,
    inlineComments: true,
    suggestions: true,
    approvalQuota: false,
    requestChanges: true,
    closeReopen: true,
    editMetadata: true,
    draftToggle: true,
    approvalNote: true,
    jobControl: false,
    pipelineSelection: false,
    listChecks: true,
    runControl: true,
  },
  status: githubStatus,
  projectsPage: githubProjectsPage,
  link: githubRepoLink,
  linkGet: githubRepoLinkGet,
  linkManual: githubRepoLinkManual,
  mrPage: (input) =>
    githubPrPage({
      projectId: input.projectId,
      scope: gitlabScope(input.scope),
      page: input.page,
      perPage: input.perPage,
      repoId: input.repoId,
    }),
  mrGet: githubPrGet,
  pipelines: githubPrChecks,
  mrCreate: githubPrCreate,
  discussions: githubPrDiscussions,
  discussionCreate: githubDiscussionCreate,
  discussionReply: githubDiscussionReply,
  discussionResolve: githubDiscussionResolve,
  approvals: githubApprovals,
  approve: githubApprove,
  unapprove: githubUnapprove,
  requestChanges: githubRequestChanges,
  update: (input) =>
    githubPrUpdate({
      projectId: input.projectId,
      iid: input.iid,
      title: input.title,
      body: input.description,
    }),
  setOpen: githubPrSetState,
  setDraft: githubPrSetDraft,
  merge: githubMergePr,
  jobs: (input) =>
    input.pipelineId !== undefined
      ? githubRunJobs({
          projectId: input.projectId,
          runId: input.pipelineId,
          page: input.page,
          perPage: input.perPage,
        })
      : githubPrJobs({
          projectId: input.projectId,
          iid: input.iid,
          page: input.page,
          perPage: input.perPage,
        }),
  checkRollups: (projectId, numbers) =>
    githubPrChecksRollup({ projectId, numbers }),
  rerunFailed: async ({ projectId, runId }) => {
    await githubRerunFailed({ projectId, runId })
  },
  cancelRun: async ({ projectId, runId }) => {
    await githubCancelRun({ projectId, runId })
  },
  jobLog: githubJobLog,
  diffRefs: githubPrDiffRefs,
  diff: (projectId, iid) => githubPrDiff({ projectId, iid }),
}

export const forges: Record<ForgeId, ForgeApi> = {
  gitlab: gitlabForge,
  github: githubForge,
}
