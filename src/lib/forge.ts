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
  gitlabJobLog,
  gitlabMergeMr,
  gitlabMrCreate,
  gitlabMrDiffRefs,
  gitlabMrDiscussions,
  gitlabMrGet,
  gitlabMrJobs,
  gitlabMrPage,
  gitlabMrPipelines,
  gitlabProjectsPage,
  gitlabRepoLink,
  gitlabRepoLinkGet,
  gitlabRepoLinkManual,
  gitlabStatus,
  gitlabUnapprove,
  githubApprove,
  githubApprovals,
  githubDiscussionCreate,
  githubDiscussionReply,
  githubDiscussionResolve,
  githubJobLog,
  githubMergePr,
  githubPrChecks,
  githubPrCreate,
  githubPrDiffRefs,
  githubPrDiscussions,
  githubPrGet,
  githubPrJobs,
  githubPrPage,
  githubProjectsPage,
  githubRepoLink,
  githubRepoLinkGet,
  githubRepoLinkManual,
  githubStatus,
  githubUnapprove,
} from '../ipc/commands'
import type {
  ApprovalsDto,
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
  /** The API exposes required/remaining approval counts. */
  approvalQuota: boolean
}

export type ForgeApi = {
  id: ForgeId
  label: string
  /** Full noun, e.g. `merge request` / `pull request`. */
  noun: string
  /** Short badge, e.g. `MR` / `PR`. */
  short: string
  title: string
  scopes: Array<{ value: ForgeScope; label: string }>
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
  approve: (input: { projectId: number; iid: number }) => Promise<ApprovalsDto>
  unapprove: (input: { projectId: number; iid: number }) => Promise<ApprovalsDto>
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
    page?: number
    perPage?: number
  }) => Promise<{ pipelineId?: number; items: GitlabJob[] }>
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
}

/** GitLab scopes use `all` for the project listing. */
function gitlabScope(scope: ForgeScope): 'createdByMe' | 'assignedToMe' | 'reviewsForMe' | 'all' {
  return scope === 'project' ? 'all' : scope
}

export const gitlabForge: ForgeApi = {
  id: 'gitlab',
  label: 'GitLab',
  noun: 'merge request',
  short: 'MR',
  title: 'Merge requests',
  scopes: [
    { value: 'createdByMe', label: 'Mes MR' },
    { value: 'reviewsForMe', label: 'À relire' },
    { value: 'assignedToMe', label: 'Assignées' },
    { value: 'project', label: 'Projet' },
  ],
  capabilities: {
    resolveThreads: true,
    autoMerge: true,
    removeSourceBranchOnMerge: true,
    createMergeOptions: true,
    inlineComments: true,
    approvalQuota: true,
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
  merge: gitlabMergeMr,
  jobs: gitlabMrJobs,
  jobLog: gitlabJobLog,
  diffRefs: gitlabMrDiffRefs,
}

export const githubForge: ForgeApi = {
  id: 'github',
  label: 'GitHub',
  noun: 'pull request',
  short: 'PR',
  title: 'Pull requests',
  scopes: [
    { value: 'createdByMe', label: 'Mes PR' },
    { value: 'reviewsForMe', label: 'À relire' },
    { value: 'assignedToMe', label: 'Assignées' },
    { value: 'project', label: 'Projet' },
  ],
  capabilities: {
    resolveThreads: false,
    autoMerge: false,
    removeSourceBranchOnMerge: false,
    createMergeOptions: false,
    inlineComments: true,
    approvalQuota: false,
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
  merge: githubMergePr,
  jobs: githubPrJobs,
  jobLog: githubJobLog,
  diffRefs: githubPrDiffRefs,
}

export const forges: Record<ForgeId, ForgeApi> = {
  gitlab: gitlabForge,
  github: githubForge,
}
