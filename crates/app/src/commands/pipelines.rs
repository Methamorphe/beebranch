//! Repository CI overview: the pipelines of the commit checked out in the
//! active repository, for the toolbar indicator and its detail panel.
//!
//! Provider selection is explicit: a repository only reports CI once it is
//! linked to a GitLab project or a GitHub repository, and only for the forge
//! an instance is connected to. When both links exist, the forge host matching
//! a Git remote wins; GitLab is the deterministic tie-breaker.

use beebranch_core::{AppError, HeadState};
use beebranch_github::{GithubClient, GithubJob, GithubPipeline, RepoRef};
use beebranch_gitlab::{GitlabClient, GitlabJob, GitlabPipeline};
use beebranch_store::RepoLink;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::github_pr::{
    auth_event as github_auth_event, client as github_client,
    ensure_repo_link as ensure_github_link, instance_id as github_instance_id, resolve_repo_ref,
};
use crate::commands::gitlab_mr::{
    auth_event as gitlab_auth_event, client as gitlab_client,
    ensure_repo_link as ensure_gitlab_link, instance_id as gitlab_instance_id,
};
use crate::error::{github_error, gitlab_error, store_error};
use crate::state::AppState;

/// Pipelines fetched for one commit; enough to show every workflow that ran.
const PIPELINES_PER_COMMIT: u32 = 20;
/// Pipelines listed for the whole repository: the panel is a recent view.
const RECENT_PIPELINES: u32 = 20;
/// Pipelines per page of the repository history.
const HISTORY_PIPELINES: u32 = 30;
/// Jobs fetched for one pipeline; the detail panel is a summary, not a log.
const JOBS_PER_PIPELINE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Gitlab,
    Github,
}

impl Provider {
    fn id(self) -> &'static str {
        match self {
            Self::Gitlab => "gitlab",
            Self::Github => "github",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSummaryDto {
    pub id: u64,
    /// Normalized state (`success`, `failed`, `running`, `pending`, ...).
    pub status: String,
    /// Workflow name (GitHub) or detailed status (GitLab).
    pub detailed_status: Option<String>,
    pub ref_name: Option<String>,
    pub sha: Option<String>,
    pub web_url: Option<String>,
    /// `push`, `merge_request_event`, ... (GitLab only).
    pub source: Option<String>,
    /// ISO-8601 timestamp of the last update, when the forge reports it.
    pub updated_at: Option<String>,
}

/// One page of the project's pipelines, newest first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineHistoryDto {
    /// `gitlab` or `github`; empty when the repository is not linked.
    pub provider: String,
    pub project_id: u64,
    pub project_path: String,
    pub items: Vec<PipelineSummaryDto>,
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineOverviewDto {
    /// `gitlab` or `github`.
    pub provider: String,
    pub project_id: u64,
    pub project_path: String,
    pub project_name: String,
    pub project_web_url: String,
    /// Branch checked out locally; `None` on a detached HEAD.
    pub branch: Option<String>,
    pub sha: Option<String>,
    /// Pipelines attached to that commit, newest first.
    pub pipelines: Vec<PipelineSummaryDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineJobStepDto {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineJobDto {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    pub web_url: Option<String>,
    pub duration: Option<f64>,
    pub created_at: Option<String>,
    pub finished_at: Option<String>,
    /// GitHub Actions steps. Empty for GitLab, which stops at the job.
    #[serde(default)]
    pub steps: Vec<PipelineJobStepDto>,
}

impl From<GitlabPipeline> for PipelineSummaryDto {
    fn from(pipeline: GitlabPipeline) -> Self {
        Self {
            id: pipeline.id,
            status: pipeline.status,
            detailed_status: pipeline.detailed_status,
            ref_name: pipeline.ref_name,
            sha: pipeline.sha,
            web_url: pipeline.web_url,
            source: pipeline.source,
            updated_at: pipeline.updated_at,
        }
    }
}

impl From<GithubPipeline> for PipelineSummaryDto {
    fn from(pipeline: GithubPipeline) -> Self {
        Self {
            id: pipeline.id,
            status: pipeline.status,
            detailed_status: pipeline.detailed_status,
            ref_name: pipeline.ref_name,
            sha: pipeline.sha,
            web_url: pipeline.web_url,
            source: None,
            updated_at: pipeline.updated_at,
        }
    }
}

impl From<GitlabJob> for PipelineJobDto {
    fn from(job: GitlabJob) -> Self {
        Self {
            id: job.id,
            name: job.name,
            stage: job.stage,
            status: job.status,
            web_url: job.web_url,
            duration: job.duration,
            created_at: job.created_at,
            finished_at: job.finished_at,
            steps: Vec::new(),
        }
    }
}

impl From<GithubJob> for PipelineJobDto {
    fn from(job: GithubJob) -> Self {
        Self {
            id: job.id,
            name: job.name,
            stage: job.stage,
            status: job.status,
            web_url: job.web_url,
            duration: job.duration,
            created_at: job.created_at,
            finished_at: job.finished_at,
            steps: job
                .steps
                .into_iter()
                .map(|step| PipelineJobStepDto {
                    name: step.name,
                    status: step.status,
                    conclusion: step.conclusion,
                })
                .collect(),
        }
    }
}

/// Repository facts shared by both provider queries.
struct RepoContext {
    branch: Option<String>,
    sha: Option<String>,
    /// Fetch remotes, used to pick between two forges and to associate one.
    remote_urls: Vec<String>,
}

/// Project metadata of a linked forge repository.
struct LinkedProject {
    project_id: u64,
    path: String,
    name: String,
    web_url: String,
    host: String,
}

fn project_row(
    state: &AppState,
    instance: &str,
    project_id: u64,
) -> Option<beebranch_store::ProjectRow> {
    state
        .store
        .list_projects(instance, None, 1000)
        .ok()?
        .into_iter()
        .find(|project| project.project_id == project_id)
}

fn linked_project(state: &AppState, link: &RepoLink) -> LinkedProject {
    let row = project_row(state, &link.instance_id, link.project_id);
    let web_url = row
        .as_ref()
        .map(|row| row.web_url.clone())
        .unwrap_or_default();
    let host = beebranch_github::normalize_remote(&web_url)
        .map(|remote| remote.host)
        .unwrap_or_default();
    LinkedProject {
        project_id: link.project_id,
        path: row
            .as_ref()
            .map(|row| row.path_with_namespace.clone())
            .unwrap_or_default(),
        name: row.map(|row| row.name).unwrap_or_default(),
        web_url,
        host,
    }
}

/// Pick the forge that owns this repository's CI.
///
/// Both links may exist; the remote host decides. Equal or ambiguous matches
/// resolve to GitLab so the choice never depends on map ordering.
fn choose_provider(
    gitlab: Option<&LinkedProject>,
    github: Option<&LinkedProject>,
    remote_hosts: &[String],
) -> Option<Provider> {
    match (gitlab, github) {
        (Some(_), None) => Some(Provider::Gitlab),
        (None, Some(_)) => Some(Provider::Github),
        (Some(gitlab), Some(github)) => {
            let gitlab_matches = !gitlab.host.is_empty()
                && remote_hosts
                    .iter()
                    .any(|host| host.eq_ignore_ascii_case(&gitlab.host));
            let github_matches = !github.host.is_empty()
                && remote_hosts
                    .iter()
                    .any(|host| host.eq_ignore_ascii_case(&github.host));
            if github_matches && !gitlab_matches {
                Some(Provider::Github)
            } else {
                Some(Provider::Gitlab)
            }
        }
        (None, None) => None,
    }
}

/// HEAD branch, its commit and the fetch remote hosts.
async fn repo_context(state: &AppState, repo_id: &str) -> Result<RepoContext, AppError> {
    let session = state.session(repo_id)?;
    let snapshot = session.state();
    let (refs, _) = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        move || session.refs()
    })
    .await
    .map_err(crate::error::join_error)??;

    let (branch, mut sha) = match snapshot.head {
        Some(HeadState::Branch { name, .. }) => (Some(name), None),
        Some(HeadState::Detached { sha }) => (None, Some(sha)),
        _ => (None, None),
    };
    if sha.is_none() {
        sha = refs.head.as_ref().and_then(|head| head.oid.clone());
    }

    let remote_urls = refs
        .remote_urls
        .iter()
        .filter(|remote| remote.direction == "fetch")
        .map(|remote| remote.url.clone())
        .collect();

    Ok(RepoContext {
        branch,
        sha,
        remote_urls,
    })
}

/// Hosts of the repository remotes, for [`choose_provider`].
fn remote_hosts(remote_urls: &[String]) -> Vec<String> {
    let mut hosts = Vec::new();
    for url in remote_urls {
        if let Some(info) = beebranch_gitlab::normalize_remote(url) {
            if !hosts.contains(&info.host) {
                hosts.push(info.host);
            }
        }
    }
    hosts
}

fn gitlab_ready(state: &AppState) -> bool {
    state
        .gitlab
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false)
}

fn github_ready(state: &AppState) -> bool {
    state
        .github
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false)
}

/// Linked project and provider for a repository, if CI can be reported.
///
/// A repository whose remote points at a connected forge is associated on the
/// spot when it has no link yet: the pipeline indicator must not depend on the
/// user opening the forge panel first.
async fn resolve_provider(
    state: &AppState,
    repo_id: &str,
    context: &RepoContext,
) -> Result<Option<(Provider, LinkedProject)>, AppError> {
    let gitlab_link = if gitlab_ready(state) {
        match state
            .store
            .repo_link_for(repo_id, "gitlab")
            .map_err(store_error)?
        {
            Some(link) => Some(link),
            None => ensure_gitlab_link(state, repo_id, &context.remote_urls).await?,
        }
    } else {
        None
    };
    let github_link = if github_ready(state) {
        match state
            .store
            .repo_link_for(repo_id, "github")
            .map_err(store_error)?
        {
            Some(link) => Some(link),
            None => ensure_github_link(state, repo_id, &context.remote_urls).await?,
        }
    } else {
        None
    };
    let gitlab = gitlab_link.as_ref().map(|link| linked_project(state, link));
    let github = github_link.as_ref().map(|link| linked_project(state, link));

    let hosts = remote_hosts(&context.remote_urls);
    let chosen = choose_provider(gitlab.as_ref(), github.as_ref(), &hosts);
    let project = match chosen {
        Some(Provider::Gitlab) => gitlab,
        Some(Provider::Github) => github,
        None => None,
    };
    Ok(chosen.zip(project))
}

/// CI state of the commit checked out in `repo_id`.
///
/// `None` means the repository is not linked to a connected forge: the caller
/// hides the indicator instead of reporting an empty pipeline list.
#[tauri::command]
pub async fn pipeline_overview(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Option<PipelineOverviewDto>, AppError> {
    let context = repo_context(&state, &repo_id).await?;
    let Some((provider, project)) = resolve_provider(&state, &repo_id, &context).await? else {
        return Ok(None);
    };

    let pipelines = match (&context.sha, provider) {
        (None, _) => Vec::new(),
        (Some(sha), Provider::Gitlab) => {
            let client: GitlabClient = gitlab_client(&state)?;
            let instance = gitlab_instance_id(&state)?;
            client
                .pipelines_for_sha(project.project_id, sha, PIPELINES_PER_COMMIT)
                .await
                .map_err(|error| {
                    gitlab_auth_event(&app, &error, &instance);
                    gitlab_error(error)
                })?
                .into_iter()
                .map(PipelineSummaryDto::from)
                .collect()
        }
        (Some(sha), Provider::Github) => {
            let client: GithubClient = github_client(&state)?;
            let instance = github_instance_id(&state)?;
            let repo = resolve_repo_ref(&state, &client, &instance, project.project_id).await?;
            client
                .workflow_runs_for_sha(&repo, sha, PIPELINES_PER_COMMIT)
                .await
                .map_err(|error| {
                    github_auth_event(&app, &error, &instance);
                    github_error(error)
                })?
                .into_iter()
                .map(PipelineSummaryDto::from)
                .collect()
        }
    };

    Ok(Some(PipelineOverviewDto {
        provider: provider.id().to_owned(),
        project_id: project.project_id,
        project_path: project.path,
        project_name: project.name,
        project_web_url: project.web_url,
        branch: context.branch,
        sha: context.sha,
        pipelines,
    }))
}

/// Jobs of one pipeline; `pipeline_id` is a GitLab pipeline id or a GitHub
/// Actions run id, exactly as returned by [`pipeline_overview`].
#[tauri::command]
pub async fn pipeline_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    pipeline_id: u64,
) -> Result<Vec<PipelineJobDto>, AppError> {
    let context = repo_context(&state, &repo_id).await?;
    let Some((provider, project)) = resolve_provider(&state, &repo_id, &context).await? else {
        return Ok(Vec::new());
    };

    match provider {
        Provider::Gitlab => {
            let client: GitlabClient = gitlab_client(&state)?;
            let instance = gitlab_instance_id(&state)?;
            let page = client
                .pipeline_jobs(project.project_id, pipeline_id, 1, JOBS_PER_PIPELINE)
                .await
                .map_err(|error| {
                    gitlab_auth_event(&app, &error, &instance);
                    gitlab_error(error)
                })?;
            Ok(page.items.into_iter().map(PipelineJobDto::from).collect())
        }
        Provider::Github => {
            let client: GithubClient = github_client(&state)?;
            let instance = github_instance_id(&state)?;
            let repo: RepoRef =
                resolve_repo_ref(&state, &client, &instance, project.project_id).await?;
            let page = client
                .run_jobs(&repo, pipeline_id, 1, JOBS_PER_PIPELINE)
                .await
                .map_err(|error| {
                    github_auth_event(&app, &error, &instance);
                    github_error(error)
                })?;
            Ok(page.items.into_iter().map(PipelineJobDto::from).collect())
        }
    }
}

/// Recent pipelines of the linked project across every ref.
///
/// The toolbar indicator stays scoped to the checked-out commit; this list is
/// what the panel shows when the user wants the whole repository's CI, so it
/// does not filter by the current HEAD.
#[tauri::command]
pub async fn pipeline_recent(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<PipelineSummaryDto>, AppError> {
    let context = repo_context(&state, &repo_id).await?;
    let Some((provider, project)) = resolve_provider(&state, &repo_id, &context).await? else {
        return Ok(Vec::new());
    };

    match provider {
        Provider::Gitlab => {
            let client: GitlabClient = gitlab_client(&state)?;
            let instance = gitlab_instance_id(&state)?;
            client
                .pipelines(project.project_id, RECENT_PIPELINES)
                .await
                .map_err(|error| {
                    gitlab_auth_event(&app, &error, &instance);
                    gitlab_error(error)
                })
                .map(|items| items.into_iter().map(PipelineSummaryDto::from).collect())
        }
        Provider::Github => {
            let client: GithubClient = github_client(&state)?;
            let instance = github_instance_id(&state)?;
            let repo: RepoRef =
                resolve_repo_ref(&state, &client, &instance, project.project_id).await?;
            client
                .workflow_runs(&repo, RECENT_PIPELINES)
                .await
                .map_err(|error| {
                    github_auth_event(&app, &error, &instance);
                    github_error(error)
                })
                .map(|items| items.into_iter().map(PipelineSummaryDto::from).collect())
        }
    }
}

/// Pipelines of the linked project across every ref, one page at a time.
///
/// The history view is independent from the checked-out commit: it lists what
/// ran on every branch, tag and merge request, newest first.
#[tauri::command]
pub async fn pipeline_history(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    page: Option<u32>,
) -> Result<PipelineHistoryDto, AppError> {
    let context = repo_context(&state, &repo_id).await?;
    let Some((provider, project)) = resolve_provider(&state, &repo_id, &context).await? else {
        return Ok(PipelineHistoryDto {
            provider: String::new(),
            project_id: 0,
            project_path: String::new(),
            items: Vec::new(),
            next_page: None,
        });
    };

    let page = page.unwrap_or(1).max(1);
    match provider {
        Provider::Gitlab => {
            let client: GitlabClient = gitlab_client(&state)?;
            let instance = gitlab_instance_id(&state)?;
            let paged = client
                .pipelines_page(project.project_id, page, HISTORY_PIPELINES)
                .await
                .map_err(|error| {
                    gitlab_auth_event(&app, &error, &instance);
                    gitlab_error(error)
                })?;
            Ok(PipelineHistoryDto {
                provider: provider.id().to_owned(),
                project_id: project.project_id,
                project_path: project.path,
                items: paged
                    .items
                    .into_iter()
                    .map(PipelineSummaryDto::from)
                    .collect(),
                next_page: paged.next_page,
            })
        }
        Provider::Github => {
            let client: GithubClient = github_client(&state)?;
            let instance = github_instance_id(&state)?;
            let repo: RepoRef =
                resolve_repo_ref(&state, &client, &instance, project.project_id).await?;
            let paged = client
                .workflow_runs_page(&repo, page, HISTORY_PIPELINES)
                .await
                .map_err(|error| {
                    github_auth_event(&app, &error, &instance);
                    github_error(error)
                })?;
            Ok(PipelineHistoryDto {
                provider: provider.id().to_owned(),
                project_id: project.project_id,
                project_path: project.path,
                items: paged
                    .items
                    .into_iter()
                    .map(PipelineSummaryDto::from)
                    .collect(),
                next_page: paged.next_page,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use beebranch_gitlab::GitlabConfig;
    use beebranch_store::{InstanceRow, ProjectRow, Store};
    use std::time::Duration;

    fn instance() -> InstanceRow {
        InstanceRow {
            id: "gl_test".to_owned(),
            provider: "gitlab".to_owned(),
            base_url: "https://gitlab.example.test".to_owned(),
            api_url: "https://gitlab.example.test/api/v4".to_owned(),
            display_name: None,
            ca_bundle_id: None,
            created_at: 1,
        }
    }

    #[tokio::test]
    async fn a_linked_repository_resolves_without_a_remote_lookup() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_instance(&instance()).expect("instance");
        store
            .upsert_projects(&[ProjectRow {
                instance_id: "gl_test".to_owned(),
                project_id: 307,
                path_with_namespace: "team/repo".to_owned(),
                name: "repo".to_owned(),
                web_url: "https://gitlab.example.test/team/repo".to_owned(),
                ssh_url: Some("git@gitlab.example.test:team/repo.git".to_owned()),
                http_url: Some("https://gitlab.example.test/team/repo.git".to_owned()),
                default_branch: Some("main".to_owned()),
                last_activity_at: None,
                fetched_at: 0,
                etag: None,
            }])
            .expect("project");
        store
            .set_repo_link(&RepoLink {
                repo_id: "repo_1".to_owned(),
                instance_id: "gl_test".to_owned(),
                project_id: 307,
                match_kind: "url".to_owned(),
                verified_at: 1,
            })
            .expect("link");
        let state = crate::state::test_state(std::env::temp_dir(), store);
        *state.gitlab_instance.lock().expect("lock") = Some(instance());
        // The link exists: no request is made, so any valid client will do.
        *state.gitlab.lock().expect("lock") = Some(
            GitlabClient::new(GitlabConfig {
                base_url: "https://gitlab.example.test".to_owned(),
                token: "glpat-test".to_owned(),
                ca_bundle_pem: None,
                timeout: Duration::from_secs(1),
            })
            .expect("client"),
        );
        let context = RepoContext {
            branch: Some("release/test".to_owned()),
            sha: Some("ff0c46a".to_owned()),
            remote_urls: vec!["git@gitlab.example.test:team/repo.git".to_owned()],
        };

        let (provider, linked) = resolve_provider(&state, "repo_1", &context)
            .await
            .expect("provider")
            .expect("resolved");

        assert_eq!(provider, Provider::Gitlab);
        assert_eq!(linked.project_id, 307);
    }

    fn project(host: &str) -> LinkedProject {
        LinkedProject {
            project_id: 1,
            path: "team/repo".to_owned(),
            name: "repo".to_owned(),
            web_url: format!("https://{host}/team/repo"),
            host: host.to_owned(),
        }
    }

    #[test]
    fn single_link_wins_without_remote_matching() {
        let gitlab = project("gitlab.example.test");
        assert_eq!(
            choose_provider(Some(&gitlab), None, &[]),
            Some(Provider::Gitlab)
        );
        let github = project("github.com");
        assert_eq!(
            choose_provider(None, Some(&github), &[]),
            Some(Provider::Github)
        );
        assert_eq!(choose_provider(None, None, &[]), None);
    }

    #[test]
    fn remote_host_breaks_the_tie_between_two_links() {
        let gitlab = project("gitlab.example.test");
        let github = project("github.com");
        assert_eq!(
            choose_provider(Some(&gitlab), Some(&github), &["github.com".to_owned()]),
            Some(Provider::Github)
        );
        assert_eq!(
            choose_provider(
                Some(&gitlab),
                Some(&github),
                &["gitlab.example.test".to_owned()]
            ),
            Some(Provider::Gitlab)
        );
        // No match, or both matching, stays deterministic.
        assert_eq!(
            choose_provider(Some(&gitlab), Some(&github), &["example.org".to_owned()]),
            Some(Provider::Gitlab)
        );
        assert_eq!(
            choose_provider(
                Some(&gitlab),
                Some(&github),
                &["github.com".to_owned(), "gitlab.example.test".to_owned()]
            ),
            Some(Provider::Gitlab)
        );
    }
}
