//! Normalized models exchanged with the application and the frontend.
//!
//! The shapes intentionally mirror the GitLab DTOs so both forge panels share
//! the same UI types. GitHub-specific facts (repository full name on search
//! results) are exposed as optional fields.

use serde::{Deserialize, Serialize};

/// Identity returned by `GET /user`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub id: u64,
    /// Login handle (`login` on the wire).
    pub username: String,
    /// Display name; falls back to the login when the profile has none.
    pub name: String,
    pub avatar_url: Option<String>,
}

/// Repository subset used by the project picker and repository linking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProject {
    /// Numeric repository identifier used by the store and API lookups.
    pub id: u64,
    pub name: String,
    /// `owner/repo`, also used for matching Git remotes.
    pub path_with_namespace: String,
    pub web_url: String,
    pub ssh_url_to_repo: Option<String>,
    pub http_url_to_repo: Option<String>,
    pub default_branch: Option<String>,
    pub last_activity_at: Option<String>,
    pub description: Option<String>,
}

/// Bounded list of items with GitHub pagination metadata.
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

/// Minimal user reference attached to pull requests and comments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUserRef {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// Check run exposed as a CI pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPipeline {
    pub id: u64,
    /// Normalized status (`success`, `failed`, `running`, `pending`, ...).
    pub status: String,
    pub detailed_status: Option<String>,
    pub ref_name: Option<String>,
    pub sha: Option<String>,
    pub web_url: Option<String>,
}

/// Pull request subset used by lists, detail and creation flows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    /// Numeric repository id, resolved from the local cache when available.
    pub project_id: Option<u64>,
    /// Pull request number (`iid` in the shared UI contract).
    pub iid: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub work_in_progress: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub author: GithubUserRef,
    pub assignees: Vec<GithubUserRef>,
    pub reviewers: Vec<GithubUserRef>,
    pub labels: Vec<String>,
    pub detailed_merge_status: Option<String>,
    pub merge_status: Option<String>,
    pub has_conflicts: bool,
    pub sha: Option<String>,
    pub web_url: String,
    pub updated_at: Option<String>,
    pub user_notes_count: u32,
    /// GitHub REST never embeds checks in a pull request payload: the field
    /// stays `None` on lists and detail, and the frontend derives the CI badge
    /// from the check runs returned by the pipelines call.
    pub head_pipeline: Option<GithubPipeline>,
    /// `owner/repo`, present on cross-repository search results.
    #[serde(default)]
    pub repository_name: Option<String>,
}

/// Position of an inline review comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPosition {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
    pub position_type: String,
    pub new_path: Option<String>,
    pub old_path: Option<String>,
    pub new_line: Option<u32>,
    pub old_line: Option<u32>,
}

/// One note inside a discussion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubNote {
    pub id: u64,
    pub body: String,
    pub author: GithubUserRef,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub system: bool,
    /// REST cannot report thread resolution, so review comments stay
    /// `resolvable: false` and the UI never offers "Resolve".
    pub resolvable: bool,
    pub resolved: bool,
    pub position: Option<GithubPosition>,
}

/// Discussion thread (individual issue comment or grouped review thread).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiscussion {
    pub id: String,
    pub individual_note: bool,
    pub notes: Vec<GithubNote>,
}

/// Approvals state aggregated from pull request reviews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubApprovals {
    pub approvals_required: u32,
    pub approvals_left: u32,
    pub approved_by: Vec<GithubApproval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubApproval {
    pub user: GithubUserRef,
}

/// CI job summary (GitHub Actions job).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubJob {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    pub web_url: Option<String>,
    pub duration: Option<f64>,
    pub created_at: Option<String>,
    pub finished_at: Option<String>,
}

/// Merge parameters mapped onto `PUT /pulls/{number}/merge`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestMerge {
    pub sha: Option<String>,
    /// `merge`, `squash` or `rebase`.
    pub merge_method: Option<String>,
    pub squash: bool,
    /// Accepted for symmetry; GitHub deletes the branch according to
    /// repository settings, not per merge.
    pub should_remove_source_branch: bool,
    pub sha_must_match: bool,
    /// GitHub exposes auto-merge through GraphQL only; the app rejects it.
    pub merge_when_pipeline_succeeds: bool,
}

/// Bounded job log.
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

/// Diff anchors of a pull request version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let user = GithubUser {
            id: 7,
            username: "octocat".to_owned(),
            name: "Octo Cat".to_owned(),
            avatar_url: None,
        };
        let json = serde_json::to_value(&user).expect("serialize");
        assert_eq!(json["username"], "octocat");
        assert_eq!(json["avatarUrl"], serde_json::Value::Null);
        assert!(json.get("avatar_url").is_none());
    }

    #[test]
    fn paged_serializes_camel_case() {
        let page = Paged {
            items: vec![1u8],
            page: 2,
            per_page: 50,
            next_page: Some(3),
            total: Some(120),
            not_modified: false,
            from_cache: true,
        };
        let json = serde_json::to_value(page).expect("serialize");
        assert_eq!(json["perPage"], 50);
        assert_eq!(json["nextPage"], 3);
        assert_eq!(json["fromCache"], true);
    }
}
