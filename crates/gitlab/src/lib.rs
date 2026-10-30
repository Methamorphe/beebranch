//! GitLab self-hosted REST v4 client.
//!
//! P0-T07 introduces the HTTP client, authentication and project discovery.
//! This crate must never spawn Git or access repositories directly.

pub mod cache;
pub mod client;
pub mod device_flow;
pub mod error;
pub mod models;
pub mod pipeline;
pub mod remote;
pub mod url;

pub use cache::{CachedResponse, MemoryResponseCache, ResponseCache};
pub use client::{
    GitlabClient, GitlabConfig, ProjectsQuery, DEFAULT_CACHE_TTL, DEFAULT_MAX_PAGES,
    MAX_PAGES_LIMIT, MAX_PER_PAGE,
};
pub use error::{GitlabError, MAX_DETAIL_CHARS};
pub use models::{
    CreateMergeRequest, GitlabApproval, GitlabApprovals, GitlabDiffRefs, GitlabDiscussion,
    GitlabFilePatch, GitlabJob, GitlabMergeRequest, GitlabNote, GitlabPipeline, GitlabPosition,
    GitlabProject, GitlabUser, GitlabUserRef, JobLog, MergeRequestMerge, MergeRequestScope,
    MergeRequestUpdate, MergeRequestsQuery, Paged,
};
pub use pipeline::PipelineState;
pub use remote::{matches_project, normalize_remote, RemoteInfo};
pub use url::{normalize_url, NormalizedUrl};
