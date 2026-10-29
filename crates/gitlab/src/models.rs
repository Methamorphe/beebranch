//! Wire models for the GitLab REST v4 endpoints used by P0-T07.
//!
//! GitLab sends `snake_case` keys; the application exchanges `camelCase`
//! payloads with the frontend. Each model declares both directions.

use serde::{Deserialize, Serialize};

/// Identity returned by `GET /user`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabUser {
    /// Numeric GitLab identifier.
    pub id: u64,
    /// Login handle.
    pub username: String,
    /// Display name.
    pub name: String,
    /// Avatar URL when the instance exposes one.
    pub avatar_url: Option<String>,
}

/// Project subset requested with `simple=true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabProject {
    /// Numeric identifier used for API calls.
    pub id: u64,
    /// Display name.
    pub name: String,
    /// Namespace-qualified path, used for display and matching.
    pub path_with_namespace: String,
    /// Browser URL.
    pub web_url: String,
    /// SSH clone URL.
    pub ssh_url_to_repo: String,
    /// HTTPS clone URL (never contains a token).
    pub http_url_to_repo: String,
    /// Default branch, absent for an empty repository.
    pub default_branch: Option<String>,
    /// ISO-8601 timestamp of the last activity.
    pub last_activity_at: Option<String>,
    /// Optional project description.
    pub description: Option<String>,
}

/// Bounded list of items with GitLab pagination metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paged<T> {
    /// Items collected across pages.
    pub items: Vec<T>,
    /// First page included in this response.
    pub page: u32,
    /// Page size requested.
    pub per_page: u32,
    /// Next page to request, or `None` when the listing is complete.
    pub next_page: Option<u32>,
    /// Total item count when GitLab exposes `X-Total`.
    pub total: Option<u64>,
    /// True when every page was revalidated with `304 Not Modified`.
    pub not_modified: bool,
    /// True when every page was served from the response cache.
    pub from_cache: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_deserializes_snake_case_and_serializes_camel_case() {
        let user: GitlabUser = serde_json::from_str(
            r#"{"id":7,"username":"octocat","name":"Octo Cat","avatar_url":"https://gl/avatar.png"}"#,
        )
        .expect("deserialize user");

        assert_eq!(user.avatar_url.as_deref(), Some("https://gl/avatar.png"));

        let json = serde_json::to_value(&user).expect("serialize user");
        assert_eq!(json["avatarUrl"], "https://gl/avatar.png");
        assert!(json.get("avatar_url").is_none());
    }

    #[test]
    fn project_handles_empty_repositories() {
        let project: GitlabProject = serde_json::from_str(
            r#"{
                "id": 12,
                "name": "Bee",
                "path_with_namespace": "team/bee",
                "web_url": "https://gitlab.example.com/team/bee",
                "ssh_url_to_repo": "git@gitlab.example.com:team/bee.git",
                "http_url_to_repo": "https://gitlab.example.com/team/bee.git",
                "default_branch": null,
                "last_activity_at": "2026-01-02T03:04:05.000Z",
                "description": null
            }"#,
        )
        .expect("deserialize project");

        assert_eq!(project.default_branch, None);
        assert_eq!(project.description, None);
        assert_eq!(project.path_with_namespace, "team/bee");
    }

    #[test]
    fn paged_serializes_camel_case() {
        let page = Paged {
            items: vec![1u8, 2],
            page: 2,
            per_page: 100,
            next_page: Some(3),
            total: Some(250),
            not_modified: true,
            from_cache: true,
        };

        let json = serde_json::to_value(page).expect("serialize page");

        assert_eq!(json["perPage"], 100);
        assert_eq!(json["nextPage"], 3);
        assert_eq!(json["notModified"], true);
        assert_eq!(json["fromCache"], true);
        assert!(json.get("per_page").is_none());
    }
}

/// Minimal GitLab user reference attached to merge requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabUserRef {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// Pipeline summary exposed by a merge request or the pipelines endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabPipeline {
    pub id: u64,
    /// Raw GitLab status (`success`, `failed`, `running`, ...).
    pub status: String,
    #[serde(default)]
    pub detailed_status: Option<String>,
    #[serde(default, rename(serialize = "refName", deserialize = "ref"))]
    pub ref_name: Option<String>,
    pub sha: Option<String>,
    pub web_url: Option<String>,
}

/// Merge request subset used by the P1 list, detail and creation flows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabMergeRequest {
    /// Numeric project id, present on project and global endpoints.
    #[serde(default)]
    pub project_id: Option<u64>,
    pub iid: u64,
    pub title: String,
    /// Markdown description; GitLab always returns it (possibly empty).
    #[serde(default)]
    pub description: String,
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub work_in_progress: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub author: GitlabUserRef,
    #[serde(default)]
    pub assignees: Vec<GitlabUserRef>,
    #[serde(default)]
    pub reviewers: Vec<GitlabUserRef>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub detailed_merge_status: Option<String>,
    #[serde(default)]
    pub merge_status: Option<String>,
    #[serde(default)]
    pub has_conflicts: bool,
    #[serde(default)]
    pub sha: Option<String>,
    pub web_url: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub user_notes_count: u32,
    #[serde(default)]
    pub head_pipeline: Option<GitlabPipeline>,
}

impl GitlabMergeRequest {
    /// True when the MR is explicitly a draft (new or legacy field).
    pub fn is_draft(&self) -> bool {
        self.draft || self.work_in_progress || self.title.starts_with("Draft:")
    }
}

/// One file of a merge request, as the changes endpoint reports it.
///
/// `patch` holds hunk text only; it is empty for binary files and for diffs
/// GitLab considers too large.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabFilePatch {
    pub old_path: String,
    pub new_path: String,
    pub new_file: bool,
    pub deleted_file: bool,
    pub renamed_file: bool,
    pub patch: String,
}

/// Merge request list scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeRequestScope {
    CreatedByMe,
    AssignedToMe,
    ReviewsForMe,
    All,
}

impl MergeRequestScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CreatedByMe => "created_by_me",
            Self::AssignedToMe => "assigned_to_me",
            Self::ReviewsForMe => "reviews_for_me",
            Self::All => "all",
        }
    }
}

/// Merge request list request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestsQuery {
    /// Project id; `None` lists merge requests across accessible projects.
    pub project_id: Option<u64>,
    pub scope: MergeRequestScope,
    pub page: u32,
    pub per_page: u32,
}

impl Default for MergeRequestsQuery {
    fn default() -> Self {
        Self {
            project_id: None,
            scope: MergeRequestScope::CreatedByMe,
            page: 1,
            per_page: 50,
        }
    }
}

impl MergeRequestsQuery {
    pub fn project(mut self, project_id: u64) -> Self {
        self.project_id = Some(project_id);
        self
    }

    pub fn with_scope(mut self, scope: MergeRequestScope) -> Self {
        self.scope = scope;
        self
    }

    pub fn with_page(mut self, page: u32) -> Self {
        self.page = page.max(1);
        self
    }
}

/// Merge request creation payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CreateMergeRequest {
    pub project_id: u64,
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Rendered as a `Draft:` title prefix; never sent as a raw API field.
    #[serde(default, skip_serializing)]
    pub draft: bool,
    #[serde(default)]
    pub remove_source_branch: bool,
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub allow_collaboration: bool,
    /// Reviewer user ids resolved by the caller.
    #[serde(default, skip_serializing)]
    pub reviewer_ids: Vec<u64>,
    /// Assignee user ids resolved by the caller.
    #[serde(default, skip_serializing)]
    pub assignee_ids: Vec<u64>,
    /// Label names; serialized as the comma-separated parameter GitLab expects.
    #[serde(default, skip_serializing)]
    pub labels: Vec<String>,
}

/// Fields an author may edit on an existing merge request.
///
/// `None` leaves a field unchanged; an empty description is meaningful.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
}

impl MergeRequestUpdate {
    /// Whether the update carries no change at all.
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.description.is_none()
    }
}

#[cfg(test)]
mod merge_request_tests {
    use super::*;

    #[test]
    fn parses_merge_request_with_pipeline() {
        let mr: GitlabMergeRequest = serde_json::from_str(
            r#"{
                "iid": 12,
                "title": "Draft: add graph",
                "state": "opened",
                "draft": true,
                "source_branch": "feature/graph",
                "target_branch": "main",
                "author": {"id": 1, "username": "alice", "name": "Alice", "avatar_url": null},
                "assignees": [],
                "reviewers": [],
                "labels": ["frontend"],
                "detailed_merge_status": "mergeable",
                "has_conflicts": false,
                "sha": "abc",
                "web_url": "https://gitlab.example.com/g/p/-/merge_requests/12",
                "updated_at": "2026-10-27T10:00:00Z",
                "user_notes_count": 2,
                "head_pipeline": {
                    "id": 99,
                    "status": "running",
                    "ref": "feature/graph",
                    "sha": "abc",
                    "web_url": null
                }
            }"#,
        )
        .expect("deserialize mr");
        assert_eq!(mr.iid, 12);
        assert!(mr.is_draft());
        assert_eq!(
            mr.head_pipeline.as_ref().map(|p| p.status.as_str()),
            Some("running")
        );
    }

    #[test]
    fn tolerates_unknown_pipeline_status() {
        let pipeline: GitlabPipeline =
            serde_json::from_str(r#"{"id":1,"status":"quantum","sha":null,"web_url":null}"#)
                .expect("deserialize pipeline");
        assert_eq!(pipeline.status, "quantum");
    }

    #[test]
    fn serializes_creation_payload_in_snake_case() {
        let payload = CreateMergeRequest {
            project_id: 7,
            source_branch: "feature".into(),
            target_branch: "main".into(),
            title: "Title".into(),
            description: "Body".into(),
            draft: true,
            remove_source_branch: true,
            squash: false,
            allow_collaboration: false,
            reviewer_ids: Vec::new(),
            assignee_ids: Vec::new(),
            labels: Vec::new(),
        };
        let json = serde_json::to_value(payload).expect("serialize");
        assert_eq!(json["source_branch"], "feature");
        assert_eq!(json["remove_source_branch"], true);
        assert!(json.get("sourceBranch").is_none());
    }
}

/// Position of an inline discussion note, anchored on MR `diff_refs` SHAs.
///
/// GitLab answers in `snake_case` while the frontend builds the inline-comment
/// payload in `camelCase`: deserialization accepts both spellings so the note
/// response and the Tauri command input share one type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabPosition {
    #[serde(alias = "baseSha")]
    pub base_sha: String,
    #[serde(alias = "startSha")]
    pub start_sha: String,
    #[serde(alias = "headSha")]
    pub head_sha: String,
    #[serde(alias = "positionType")]
    pub position_type: String,
    #[serde(default, alias = "newPath")]
    pub new_path: Option<String>,
    #[serde(default, alias = "oldPath")]
    pub old_path: Option<String>,
    #[serde(default, alias = "newLine")]
    pub new_line: Option<u32>,
    #[serde(default, alias = "oldLine")]
    pub old_line: Option<u32>,
}

/// One note inside a discussion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabNote {
    pub id: u64,
    pub body: String,
    pub author: GitlabUserRef,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub resolvable: bool,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub position: Option<GitlabPosition>,
}

/// Discussion thread (individual note or grouped thread).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabDiscussion {
    pub id: String,
    #[serde(default)]
    pub individual_note: bool,
    #[serde(default)]
    pub notes: Vec<GitlabNote>,
}

/// Approvals state for a merge request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabApprovals {
    #[serde(default)]
    pub approvals_required: u32,
    #[serde(default)]
    pub approvals_left: u32,
    #[serde(default)]
    pub approved_by: Vec<GitlabApproval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabApproval {
    pub user: GitlabUserRef,
}

/// CI job summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabJob {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub stage: String,
    pub status: String,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

/// Merge request merge parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestMerge {
    pub sha: Option<String>,
    /// `merge` or `rebase_merge`.
    pub merge_method: Option<String>,
    pub squash: bool,
    pub should_remove_source_branch: bool,
    pub sha_must_match: bool,
    /// Merge automatically when the head pipeline succeeds.
    #[serde(default)]
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
    /// Byte offset of this page in the trace.
    pub offset: usize,
    /// Offset to request for the next page when truncated.
    pub next_offset: Option<usize>,
}

/// Diff anchors of a merge request version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct GitlabDiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

#[cfg(test)]
mod position_tests {
    use super::*;

    #[test]
    fn accepts_the_frontend_camel_case_payload() {
        let position: GitlabPosition = serde_json::from_str(
            r#"{
                "baseSha": "a",
                "startSha": "b",
                "headSha": "c",
                "positionType": "text",
                "newPath": "src/lib.rs",
                "oldPath": "src/lib.rs",
                "newLine": 12
            }"#,
        )
        .expect("deserialize position");
        assert_eq!(position.base_sha, "a");
        assert_eq!(position.position_type, "text");
        assert_eq!(position.new_path.as_deref(), Some("src/lib.rs"));
        assert_eq!(position.new_line, Some(12));
        assert_eq!(position.old_line, None);
    }

    #[test]
    fn still_accepts_the_gitlab_snake_case_note_position() {
        let position: GitlabPosition = serde_json::from_str(
            r#"{
                "base_sha": "a",
                "start_sha": "b",
                "head_sha": "c",
                "position_type": "text",
                "new_path": "src/lib.rs",
                "old_line": 4
            }"#,
        )
        .expect("deserialize position");
        assert_eq!(position.new_path.as_deref(), Some("src/lib.rs"));
        assert_eq!(position.old_line, Some(4));
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let position = GitlabPosition {
            base_sha: "a".into(),
            start_sha: "b".into(),
            head_sha: "c".into(),
            position_type: "text".into(),
            new_path: Some("src/lib.rs".into()),
            old_path: None,
            new_line: Some(12),
            old_line: None,
        };
        let json = serde_json::to_value(position).expect("serialize");
        assert_eq!(json["newPath"], "src/lib.rs");
        assert_eq!(json["newLine"], 12);
        assert!(json.get("new_path").is_none());
    }
}
