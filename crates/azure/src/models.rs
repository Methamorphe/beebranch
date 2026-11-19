//! Normalized models exchanged with the application and the frontend.
//!
//! Field names mirror the GitLab DTOs consumed by the review panel. Azure
//! repository identifiers are GUIDs: [`stable_id`] folds one into the `u64`
//! the store and the UI already use, and [`AzureProject::external_id`] keeps
//! the original `{project}/{repository}` pair for API calls.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Stable positive identifier for a GUID or another Azure key.
///
/// The value fits in an SQLite `INTEGER`. It is not reversible; callers keep
/// the original key beside it.
pub fn stable_id(key: &str) -> u64 {
    let digest = Sha256::digest(key.trim().to_ascii_lowercase().as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(bytes) & (i64::MAX as u64)
}

/// Pack a build id and a log id into the numeric job id the UI already sends
/// back. Log ids at or above one million are clamped; Azure log ids are small.
pub fn pack_job(build_id: u64, log_id: u64) -> u64 {
    build_id
        .saturating_mul(1_000_000)
        .saturating_add(log_id.min(999_999))
}

/// Inverse of [`pack_job`].
pub fn unpack_job(id: u64) -> (u64, u64) {
    (id / 1_000_000, id % 1_000_000)
}

/// Identity returned by `connectionData`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureUser {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
    /// Azure identity GUID. Never shown; used to vote on a pull request.
    #[serde(skip)]
    pub guid: String,
}

/// Repository shown in the project picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureProject {
    pub id: u64,
    pub name: String,
    /// `{project}/{repository}`.
    pub path_with_namespace: String,
    pub web_url: String,
    pub ssh_url_to_repo: Option<String>,
    pub http_url_to_repo: Option<String>,
    pub default_branch: Option<String>,
    pub last_activity_at: Option<String>,
    pub description: Option<String>,
    /// `{projectGuid}/{repositoryGuid}`.
    #[serde(skip)]
    pub external_id: String,
    #[serde(skip)]
    pub project_name: String,
}

/// Bounded page. Azure continuation tokens are consumed inside the client;
/// the UI still sees page numbers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paged<T> {
    pub items: Vec<T>,
    pub page: u32,
    pub per_page: u32,
    pub next_page: Option<u32>,
    pub total: Option<u64>,
    pub not_modified: bool,
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureUserRef {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipeline {
    pub id: u64,
    pub status: String,
    pub detailed_status: Option<String>,
    pub ref_name: Option<String>,
    pub sha: Option<String>,
    pub web_url: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzurePullRequest {
    pub project_id: Option<u64>,
    pub iid: u64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub state: String,
    pub draft: bool,
    pub work_in_progress: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub author: AzureUserRef,
    pub assignees: Vec<AzureUserRef>,
    pub reviewers: Vec<AzureUserRef>,
    pub labels: Vec<String>,
    pub detailed_merge_status: Option<String>,
    pub merge_status: Option<String>,
    pub has_conflicts: bool,
    pub sha: Option<String>,
    pub web_url: String,
    pub updated_at: Option<String>,
    pub user_notes_count: u32,
    pub head_pipeline: Option<AzurePipeline>,
    #[serde(default)]
    pub repository_name: Option<String>,
    /// Target commit, kept so completion and the diff can reuse it.
    #[serde(skip)]
    pub target_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureNote {
    pub id: u64,
    pub body: String,
    pub author: AzureUserRef,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub system: bool,
    pub resolvable: bool,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureDiscussion {
    pub id: String,
    pub individual_note: bool,
    pub notes: Vec<AzureNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureApproval {
    pub user: AzureUserRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureApprovals {
    pub approvals_required: u32,
    pub approvals_left: u32,
    pub approved_by: Vec<AzureApproval>,
    #[serde(default)]
    pub changes_requested_by: Vec<AzureApproval>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureJob {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    pub web_url: Option<String>,
    pub duration: Option<f64>,
    pub created_at: Option<String>,
    pub finished_at: Option<String>,
    #[serde(default)]
    pub steps: Vec<AzureJobStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureJobStep {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub text: String,
    pub truncated: bool,
    pub bytes: usize,
    pub source_url: String,
    pub offset: usize,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureDiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

/// One file changed by a pull request. Azure does not return hunk text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzureFileChange {
    pub old_path: String,
    pub new_path: String,
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_id_is_positive_and_stable() {
        let first = stable_id("11111111-2222-3333-4444-555555555555");
        let second = stable_id("11111111-2222-3333-4444-555555555555");
        assert_eq!(first, second);
        assert!(first <= i64::MAX as u64);
        assert_ne!(first, stable_id("ffffffff-2222-3333-4444-555555555555"));
    }

    #[test]
    fn job_ids_round_trip() {
        assert_eq!(unpack_job(pack_job(42, 7)), (42, 7));
    }
}
