//! GitHub REST v3 client (github.com and GitHub Enterprise Server).
//!
//! This crate must never spawn Git or access repositories directly. Models are
//! normalized to the same shapes as the GitLab DTOs so both forge panels can
//! share one frontend contract.

pub mod client;
pub mod error;
pub mod models;
pub mod pipeline;
pub mod remote;
pub mod url;

pub use client::{
    CreatePullRequest, GithubClient, GithubConfig, JobsPage, PullRequestScope, PullRequestsQuery,
    RepoRef, RepositoriesQuery, DEFAULT_CACHE_TTL, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT,
    MAX_PER_PAGE,
};
pub use error::{GithubError, MAX_DETAIL_CHARS};
pub use models::{
    GithubApprovals, GithubDiffRefs, GithubDiscussion, GithubJob, GithubNote, GithubPipeline,
    GithubPosition, GithubProject, GithubPullRequest, GithubUser, GithubUserRef, JobLog, Paged,
    PullRequestMerge,
};
pub use pipeline::normalize_status;
pub use remote::{matches_project, normalize_remote, RemoteInfo};
pub use url::{normalize_url, NormalizedUrl};
