//! Azure DevOps pull requests, builds and repository linking.
//!
//! A link is stored for the Azure provider only. A GitLab link on the same
//! repository is left in place.

use beebranch_azure::{
    belongs_to_instance, matches_project, normalize_remote, normalize_url, AzureApprovals,
    AzureClient, AzureDiffRefs, AzureDiscussion, AzureJob, AzureNote, AzurePipeline,
    AzurePullRequest, CreatePullRequest, JobLog, Paged, PullRequestScope, PullRequestsQuery,
    RepoRef,
};
use beebranch_core::{AppError, Confirmation, ErrorCategory};
use beebranch_git::diff::{read_diff, DiffLimits, DiffReport, DiffTarget};
use beebranch_gitlab::MergeRequestScope;
use beebranch_store::{ProjectRow, RepoLink};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::azure::{auth_event, client, instance_id, not_configured};
use crate::commands::forge_diff::{report_from_patches, PatchInput};
use crate::error::{azure_error, store_error};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLinkDto {
    pub repo_id: String,
    pub instance_id: String,
    pub project_id: u64,
    pub match_kind: String,
    pub path_with_namespace: String,
    pub name: String,
    pub web_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrPageInput {
    pub project_id: Option<u64>,
    pub scope: MergeRequestScope,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
    pub repo_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMrInput {
    pub repo_id: String,
    #[serde(default)]
    pub project_id: Option<u64>,
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRef {
    project_id: u64,
    iid: u64,
    /// Accepted so the shared review query can send them; Azure returns one page.
    #[serde(default)]
    #[allow(dead_code)]
    page: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    per_page: Option<u32>,
    #[serde(default)]
    pipeline_id: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInput {
    project_id: u64,
    iid: u64,
    body: String,
    #[serde(default)]
    discussion_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteInput {
    project_id: u64,
    iid: u64,
    #[serde(default)]
    body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    project_id: u64,
    iid: u64,
    sha: Option<String>,
    merge_method: Option<String>,
    #[serde(default)]
    squash: bool,
    #[serde(default)]
    remove_source_branch: bool,
    #[serde(default)]
    auto_merge: bool,
    confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLogInput {
    project_id: u64,
    job_id: u64,
    #[serde(default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalsDto {
    available: bool,
    state: Option<AzureApprovals>,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsDto {
    pipeline_id: Option<u64>,
    items: Vec<AzureJob>,
    next_page: Option<u32>,
}

fn project_row(state: &AppState, instance: &str, project_id: u64) -> Option<ProjectRow> {
    state
        .store
        .list_projects(instance, None, 1000)
        .ok()?
        .into_iter()
        .find(|project| project.project_id == project_id)
}

fn link_dto(state: &AppState, link: RepoLink) -> RepoLinkDto {
    let project = project_row(state, &link.instance_id, link.project_id);
    RepoLinkDto {
        repo_id: link.repo_id,
        instance_id: link.instance_id,
        project_id: link.project_id,
        match_kind: link.match_kind,
        path_with_namespace: project
            .as_ref()
            .map(|row| row.path_with_namespace.clone())
            .unwrap_or_default(),
        name: project
            .as_ref()
            .map(|row| row.name.clone())
            .unwrap_or_default(),
        web_url: project.map(|row| row.web_url).unwrap_or_default(),
    }
}

fn azure_project(row: &ProjectRow, external_id: &str) -> beebranch_azure::AzureProject {
    let project_name = row
        .path_with_namespace
        .split_once('/')
        .map(|(project, _)| project.to_owned())
        .unwrap_or_else(|| row.name.clone());
    beebranch_azure::AzureProject {
        id: row.project_id,
        name: row.name.clone(),
        path_with_namespace: row.path_with_namespace.clone(),
        web_url: row.web_url.clone(),
        ssh_url_to_repo: row.ssh_url.clone(),
        http_url_to_repo: row.http_url.clone(),
        default_branch: row.default_branch.clone(),
        last_activity_at: row.last_activity_at.clone(),
        description: None,
        external_id: external_id.to_owned(),
        project_name,
    }
}

async fn resolve_repo(
    state: &AppState,
    api: &AzureClient,
    instance: &str,
    project_id: u64,
) -> Result<RepoRef, AppError> {
    let row = project_row(state, instance, project_id);
    if let Some(external) = state
        .store
        .external_id(instance, project_id)
        .map_err(store_error)?
    {
        let (project_name, name) = row
            .as_ref()
            .and_then(|row| row.path_with_namespace.split_once('/'))
            .map(|(project, name)| (project.to_owned(), name.to_owned()))
            .unwrap_or_else(|| ("project".to_owned(), "repo".to_owned()));
        if let Some(reference) = RepoRef::from_external(project_id, &external, &project_name, &name)
        {
            return Ok(reference);
        }
    }
    let Some(row) = row else {
        return Err(AppError::not_found(
            "Le dépôt Azure DevOps n'est pas dans le cache local.",
        ));
    };
    let Some((project, name)) = row.path_with_namespace.split_once('/') else {
        return Err(AppError::not_found(
            "Le chemin du dépôt Azure DevOps est illisible.",
        ));
    };
    let project = api
        .repository_by_name(project, name)
        .await
        .map_err(azure_error)?;
    state
        .store
        .set_external_id(instance, project_id, &project.external_id)
        .map_err(store_error)?;
    RepoRef::from_external(
        project_id,
        &project.external_id,
        &project.project_name,
        &project.name,
    )
    .ok_or_else(|| AppError::not_found("Identifiant Azure DevOps illisible."))
}

fn store_link(
    state: &AppState,
    repo_id: &str,
    instance: &str,
    project_id: u64,
    kind: &str,
) -> Result<RepoLink, AppError> {
    let link = RepoLink {
        repo_id: repo_id.to_owned(),
        instance_id: instance.to_owned(),
        project_id,
        match_kind: kind.to_owned(),
        verified_at: beebranch_core::now_unix(),
    };
    state.store.set_repo_link(&link).map_err(store_error)?;
    Ok(link)
}

/// Associate `remote_urls` with the connected organization, without touching
/// another provider's link.
pub(crate) async fn ensure_repo_link(
    state: &AppState,
    repo_id: &str,
    remote_urls: &[String],
) -> Result<Option<RepoLink>, AppError> {
    if let Some(link) = state
        .store
        .repo_link_for(repo_id, "azure")
        .map_err(store_error)?
    {
        return Ok(Some(link));
    }
    let instance = state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))?
        .clone()
        .ok_or_else(not_configured)?;
    let normalized = normalize_url(&instance.base_url).map_err(azure_error)?;
    let remotes: Vec<_> = remote_urls
        .iter()
        .filter_map(|url| normalize_remote(url))
        .filter(|remote| belongs_to_instance(remote, &normalized))
        .collect();
    if remotes.is_empty() {
        return Ok(None);
    }
    let projects = state
        .store
        .list_projects(&instance.id, None, 1000)
        .map_err(store_error)?;
    for project in &projects {
        let external = state
            .store
            .external_id(&instance.id, project.project_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        let candidate = azure_project(project, &external);
        if remotes
            .iter()
            .any(|remote| matches_project(remote, &candidate))
        {
            return store_link(state, repo_id, &instance.id, project.project_id, "url").map(Some);
        }
    }
    let api = client(state)?;
    for remote in remotes {
        match api
            .repository_by_name(&remote.project, &remote.repository)
            .await
        {
            Ok(project) => {
                let row = ProjectRow {
                    instance_id: instance.id.clone(),
                    project_id: project.id,
                    path_with_namespace: project.path_with_namespace.clone(),
                    name: project.name.clone(),
                    web_url: project.web_url.clone(),
                    ssh_url: project.ssh_url_to_repo.clone(),
                    http_url: project.http_url_to_repo.clone(),
                    default_branch: project.default_branch.clone(),
                    last_activity_at: project.last_activity_at.clone(),
                    fetched_at: beebranch_core::now_unix(),
                    etag: None,
                };
                state.store.upsert_projects(&[row]).map_err(store_error)?;
                state
                    .store
                    .set_external_id(&instance.id, project.id, &project.external_id)
                    .map_err(store_error)?;
                return store_link(state, repo_id, &instance.id, project.id, "url").map(Some);
            }
            Err(error) if matches!(error.status(), Some(403) | Some(404)) => continue,
            Err(error) => return Err(azure_error(error)),
        }
    }
    Ok(None)
}

async fn remote_urls(state: &AppState, repo_id: &str) -> Result<Vec<String>, AppError> {
    let session = state.session(repo_id)?;
    let (refs, _) = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        move || session.refs()
    })
    .await
    .map_err(crate::error::join_error)??;
    Ok(refs
        .remote_urls
        .into_iter()
        .filter(|remote| remote.direction == "fetch")
        .map(|remote| remote.url)
        .collect())
}

fn scope_of(scope: MergeRequestScope) -> PullRequestScope {
    match scope {
        MergeRequestScope::CreatedByMe => PullRequestScope::CreatedByMe,
        MergeRequestScope::AssignedToMe => PullRequestScope::AssignedToMe,
        MergeRequestScope::ReviewsForMe => PullRequestScope::ReviewsForMe,
        MergeRequestScope::All => PullRequestScope::All,
    }
}

#[tauri::command]
pub async fn azure_repo_link(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<RepoLinkDto, AppError> {
    let _ = instance_id(&state)?;
    let urls = remote_urls(&state, &repo_id).await?;
    let link = ensure_repo_link(&state, &repo_id, &urls)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "azure.not_found",
                ErrorCategory::Repo,
                "Aucun remote de ce dépôt ne pointe vers l'organisation Azure DevOps connectée.",
            )
        })?;
    Ok(link_dto(&state, link))
}

#[tauri::command]
pub fn azure_repo_link_get(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Option<RepoLinkDto>, AppError> {
    let link = state
        .store
        .repo_link_for(&repo_id, "azure")
        .map_err(store_error)?;
    Ok(link.map(|link| link_dto(&state, link)))
}

#[tauri::command]
pub fn azure_repo_link_manual(
    state: State<'_, AppState>,
    repo_id: String,
    project_id: u64,
) -> Result<RepoLinkDto, AppError> {
    let instance = instance_id(&state)?;
    if project_row(&state, &instance, project_id).is_none() {
        return Err(AppError::not_found(
            "Ce dépôt Azure DevOps n'est pas dans la liste chargée.",
        ));
    }
    let link = store_link(&state, &repo_id, &instance, project_id, "manual")?;
    Ok(link_dto(&state, link))
}

#[tauri::command]
pub async fn azure_pr_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrPageInput,
) -> Result<Paged<AzurePullRequest>, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let project_id = match input.project_id {
        Some(id) => id,
        None => {
            let repo_id = input.repo_id.as_deref().unwrap_or("");
            state
                .store
                .repo_link_for(repo_id, "azure")
                .map_err(store_error)?
                .map(|link| link.project_id)
                .ok_or_else(|| {
                    AppError::not_found("Ce dépôt n'est pas lié à un projet Azure DevOps.")
                })?
        }
    };
    let repo = resolve_repo(&state, &api, &instance, project_id).await?;
    if api.user_guid().is_none() {
        if let Some(guid) = state.store.external_id(&instance, 0).ok().flatten() {
            api.set_user_guid(&guid);
        }
    }
    let page = api
        .pull_requests(&PullRequestsQuery {
            repo,
            scope: scope_of(input.scope),
            page: input.page.unwrap_or(1),
            per_page: input.per_page.unwrap_or(30),
        })
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })?;
    Ok(page)
}

#[tauri::command]
pub async fn azure_pr_get(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
) -> Result<AzurePullRequest, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, project_id).await?;
    api.pull_request(&repo, iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })
}

#[tauri::command]
pub async fn azure_pr_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateMrInput,
) -> Result<AzurePullRequest, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let project_id = match input.project_id {
        Some(id) => id,
        None => state
            .store
            .repo_link_for(&input.repo_id, "azure")
            .map_err(store_error)?
            .map(|link| link.project_id)
            .ok_or_else(|| AppError::not_found("Liez d'abord le dépôt Azure DevOps."))?,
    };
    let repo = resolve_repo(&state, &api, &instance, project_id).await?;
    api.create_pull_request(
        &repo,
        &CreatePullRequest {
            title: input.title,
            source_branch: input.source_branch,
            target_branch: input.target_branch,
            description: input.description,
            draft: input.draft,
        },
    )
    .await
    .map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })
}

#[tauri::command]
pub async fn azure_pr_pipelines(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
) -> Result<Vec<AzurePipeline>, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, project_id).await?;
    let pull = api.pull_request(&repo, iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })?;
    let Some(sha) = pull.sha.as_deref() else {
        return Ok(Vec::new());
    };
    api.builds_for_sha(&repo, sha, 10).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })
}

#[tauri::command]
pub async fn azure_pr_discussions(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PullRef,
) -> Result<Paged<AzureDiscussion>, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    let items = api.discussions(&repo, input.iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })?;
    Ok(Paged {
        page: 1,
        per_page: items.len() as u32,
        next_page: None,
        total: Some(items.len() as u64),
        not_modified: false,
        from_cache: false,
        items,
    })
}

#[tauri::command]
pub async fn azure_discussion_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DiscussionInput,
) -> Result<AzureDiscussion, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    api.create_discussion(&repo, input.iid, &input.body)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })
}

#[tauri::command]
pub async fn azure_discussion_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    input: DiscussionInput,
) -> Result<AzureNote, AppError> {
    let thread = input.discussion_id.clone().ok_or_else(|| {
        AppError::invalid_input("La réponse Azure DevOps exige un fil de discussion.")
    })?;
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    api.reply(&repo, input.iid, &thread, &input.body)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })
}

#[tauri::command]
pub async fn azure_approvals(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PullRef,
) -> Result<ApprovalsDto, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    match api.reviewers(&repo, input.iid).await {
        Ok(state) => Ok(ApprovalsDto {
            available: true,
            state: Some(state),
            reason: None,
        }),
        Err(error) => {
            auth_event(&app, &error, &instance);
            Err(azure_error(error))
        }
    }
}

async fn vote(
    app: &AppHandle,
    state: &AppState,
    input: VoteInput,
    value: i32,
) -> Result<ApprovalsDto, AppError> {
    let api = client(state)?;
    let instance = instance_id(state)?;
    if api.user_guid().is_none() {
        let user = api.validate().await.map_err(|error| {
            auth_event(app, &error, &instance);
            azure_error(error)
        })?;
        let _ = state.store.set_external_id(&instance, 0, &user.guid);
    }
    let repo = resolve_repo(state, &api, &instance, input.project_id).await?;
    if value < 0 && input.body.trim().is_empty() {
        return Err(AppError::invalid_input(
            "Un refus Azure DevOps doit expliquer ce qui bloque.",
        ));
    }
    if value < 0 && !input.body.trim().is_empty() {
        let _ = api
            .create_discussion(&repo, input.iid, input.body.trim())
            .await;
    }
    let approvals = api
        .set_vote(&repo, input.iid, value)
        .await
        .map_err(|error| {
            auth_event(app, &error, &instance);
            azure_error(error)
        })?;
    Ok(ApprovalsDto {
        available: true,
        state: Some(approvals),
        reason: None,
    })
}

#[tauri::command]
pub async fn azure_approve(
    app: AppHandle,
    state: State<'_, AppState>,
    input: VoteInput,
) -> Result<ApprovalsDto, AppError> {
    vote(&app, &state, input, 10).await
}

#[tauri::command]
pub async fn azure_unapprove(
    app: AppHandle,
    state: State<'_, AppState>,
    input: VoteInput,
) -> Result<ApprovalsDto, AppError> {
    vote(&app, &state, input, 0).await
}

#[tauri::command]
pub async fn azure_request_changes(
    app: AppHandle,
    state: State<'_, AppState>,
    input: VoteInput,
) -> Result<ApprovalsDto, AppError> {
    vote(&app, &state, input, -10).await
}

#[tauri::command]
pub async fn azure_merge_pr(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MergeInput,
) -> Result<AzurePullRequest, AppError> {
    if !input.confirmation.acknowledged {
        return Err(AppError::new(
            "confirmation.required",
            ErrorCategory::Input,
            "La complétion de la pull request doit être confirmée.",
        ));
    }
    if input.auto_merge {
        return Err(AppError::new(
            "azure.unsupported",
            ErrorCategory::Input,
            "Azure DevOps ne reçoit pas de fusion automatique depuis BeeBranch.",
        ));
    }
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    let pull = api
        .pull_request(&repo, input.iid)
        .await
        .map_err(azure_error)?;
    let sha = input.sha.or(pull.sha).ok_or_else(|| {
        AppError::invalid_input("La pull request n'a pas de commit source à compléter.")
    })?;
    let strategy = if input.squash {
        "squash"
    } else {
        input.merge_method.as_deref().unwrap_or("merge")
    };
    api.complete_pull_request(&repo, input.iid, &sha, strategy, input.remove_source_branch)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })
}

#[tauri::command]
pub async fn azure_pr_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PullRef,
) -> Result<JobsDto, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    let build_id = if let Some(id) = input.pipeline_id {
        id
    } else {
        let pull = api.pull_request(&repo, input.iid).await.map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })?;
        let Some(sha) = pull.sha else {
            return Ok(JobsDto {
                pipeline_id: None,
                items: Vec::new(),
                next_page: None,
            });
        };
        let builds = api.builds_for_sha(&repo, &sha, 1).await.map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })?;
        let Some(build) = builds.first() else {
            return Ok(JobsDto {
                pipeline_id: None,
                items: Vec::new(),
                next_page: None,
            });
        };
        build.id
    };
    let items = api.build_jobs(&repo, build_id).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })?;
    Ok(JobsDto {
        pipeline_id: Some(build_id),
        items,
        next_page: None,
    })
}

#[tauri::command]
pub async fn azure_job_log(
    app: AppHandle,
    state: State<'_, AppState>,
    input: JobLogInput,
) -> Result<JobLog, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    api.build_log(
        &repo,
        input.job_id,
        input.max_bytes.unwrap_or(256 * 1024),
        input.offset.unwrap_or(0),
    )
    .await
    .map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })
}

#[tauri::command]
pub async fn azure_pr_diff_refs(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PullRef,
) -> Result<AzureDiffRefs, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    api.diff_refs(&repo, input.iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })
}

#[tauri::command]
pub async fn azure_pr_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PullRef,
) -> Result<DiffReport, AppError> {
    let api = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo(&state, &api, &instance, input.project_id).await?;
    let refs = api.diff_refs(&repo, input.iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })?;
    if let Some(local) = local_diff(&state, &instance, input.project_id, &refs).await {
        return Ok(local);
    }
    let files = api
        .file_changes(&repo, &refs.base_sha, &refs.head_sha)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            azure_error(error)
        })?;
    let patches = files
        .into_iter()
        .map(|file| PatchInput {
            old_path: file.old_path,
            new_path: file.new_path,
            status: file.status,
            patch: None,
        })
        .collect();
    report_from_patches(patches)
}

async fn local_diff(
    state: &AppState,
    instance: &str,
    project_id: u64,
    refs: &AzureDiffRefs,
) -> Option<DiffReport> {
    let repo_id = state
        .store
        .repo_id_for_project(instance, project_id)
        .ok()
        .flatten()?;
    let session = state.session(&repo_id).ok()?;
    let runner = state.runner.as_ref()?;
    let target = DiffTarget::Range {
        base: refs.base_sha.clone(),
        target: Some(refs.head_sha.clone()),
    };
    let limits = DiffLimits {
        max_bytes: 2 * 1024 * 1024,
        ..DiffLimits::default()
    };
    tauri::async_runtime::spawn_blocking({
        let runner = runner.clone();
        let path = session.worktree().to_path_buf();
        move || read_diff(&runner, &path, &target, &[], limits)
    })
    .await
    .ok()
    .and_then(Result::ok)
}

/// Builds attached to one commit, for the toolbar indicator.
pub(crate) async fn builds_for_commit(
    state: &AppState,
    project_id: u64,
    sha: &str,
    limit: u32,
) -> Result<Vec<AzurePipeline>, AppError> {
    let api = client(state)?;
    let instance = instance_id(state)?;
    let repo = resolve_repo(state, &api, &instance, project_id).await?;
    api.builds_for_sha(&repo, sha, limit)
        .await
        .map_err(azure_error)
}

pub(crate) async fn builds_page(
    state: &AppState,
    project_id: u64,
    page: u32,
    per_page: u32,
) -> Result<Paged<AzurePipeline>, AppError> {
    let api = client(state)?;
    let instance = instance_id(state)?;
    let repo = resolve_repo(state, &api, &instance, project_id).await?;
    api.builds_page(&repo, page, per_page)
        .await
        .map_err(azure_error)
}

pub(crate) async fn jobs_for_build(
    state: &AppState,
    project_id: u64,
    build_id: u64,
) -> Result<Vec<AzureJob>, AppError> {
    let api = client(state)?;
    let instance = instance_id(state)?;
    let repo = resolve_repo(state, &api, &instance, project_id).await?;
    api.build_jobs(&repo, build_id).await.map_err(azure_error)
}
