//! Azure DevOps REST client (Services and Server).
//!
//! Authentication is a user-owned Personal Access Token sent as HTTP Basic.
//! BeeBranch is not registered with Microsoft. This crate must never spawn Git
//! or read a repository. Models use the same shapes as the GitLab DTOs so the
//! review panel can stay shared.

pub mod client;
pub mod error;
pub mod models;
pub mod pipeline;
pub mod remote;
pub mod url;

pub use client::{
    AzureClient, AzureConfig, CreatePullRequest, PullRequestScope, PullRequestsQuery, RepoRef,
    RepositoriesQuery, DEFAULT_CACHE_TTL, MAX_PER_PAGE,
};
pub use error::{AzureError, MAX_DETAIL_CHARS};
pub use models::{
    stable_id, AzureApprovals, AzureDiffRefs, AzureDiscussion, AzureFileChange, AzureJob,
    AzureNote, AzurePipeline, AzureProject, AzurePullRequest, AzureUser, AzureUserRef, JobLog,
    Paged,
};
pub use pipeline::normalize_build;
pub use remote::{belongs_to_instance, matches_project, normalize_remote, RemoteInfo};
pub use url::{normalize_url, NormalizedUrl};
