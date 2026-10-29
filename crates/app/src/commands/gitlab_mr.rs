//! GitLab merge requests, pipelines and repository ↔ project association.

use beebranch_core::{AppError, ErrorCategory};
use beebranch_git::sync;
use beebranch_gitlab::{
    normalize_remote, CreateMergeRequest, GitlabClient, GitlabMergeRequest, GitlabPipeline,
    MergeRequestScope, MergeRequestsQuery, Paged, RemoteInfo,
};
use beebranch_store::{ProjectRow, RepoLink};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::gitlab::not_configured_public as not_configured;
use crate::error::{gitlab_error, store_error};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrPageInput {
    pub project_id: Option<u64>,
    pub scope: MergeRequestScope,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
    /// Use the repository linked project when `project_id` is absent.
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
    #[serde(default)]
    pub remove_source_branch: bool,
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub allow_collaboration: bool,
}

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

fn client(state: &AppState) -> Result<GitlabClient, AppError> {
    state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))?
        .clone()
        .ok_or_else(not_configured)
}

fn instance_id(state: &AppState) -> Result<String, AppError> {
    state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)
}

fn auth_event(app: &AppHandle, error: &beebranch_gitlab::GitlabError, instance: &str) {
    if error.code() == "auth.failed" {
        let _ = app.emit(
            "gitlab://auth-expired",
            serde_json::json!({ "instanceId": instance }),
        );
    }
}

fn project_row(state: &AppState, instance: &str, project_id: u64) -> Option<ProjectRow> {
    state
        .store
        .list_projects(instance, None, 1000)
        .ok()?
        .into_iter()
        .find(|project| project.project_id == project_id)
}

fn link_dto(state: &AppState, link: &RepoLink) -> RepoLinkDto {
    let project = project_row(state, &link.instance_id, link.project_id);
    RepoLinkDto {
        repo_id: link.repo_id.clone(),
        instance_id: link.instance_id.clone(),
        project_id: link.project_id,
        match_kind: link.match_kind.clone(),
        path_with_namespace: project
            .as_ref()
            .map(|project| project.path_with_namespace.clone())
            .unwrap_or_default(),
        name: project
            .as_ref()
            .map(|project| project.name.clone())
            .unwrap_or_default(),
        web_url: project.map(|project| project.web_url).unwrap_or_default(),
    }
}

fn match_project(projects: &[ProjectRow], remotes: &[RemoteInfo]) -> Option<ProjectRow> {
    for project in projects {
        for remote in remotes {
            if let Some(info) = normalize_remote(project.ssh_url.as_deref().unwrap_or(""))
                .or_else(|| normalize_remote(project.http_url.as_deref().unwrap_or("")))
            {
                if info.host.eq_ignore_ascii_case(&remote.host) && info.path == remote.path {
                    return Some(project.clone());
                }
            }
            let target = &project.path_with_namespace;
            if remote.path == *target || remote.path.ends_with(&format!("/{target}")) {
                return Some(project.clone());
            }
        }
    }
    None
}

/// Associate the current repository with a GitLab project using its remotes.
#[tauri::command]
pub async fn gitlab_repo_link(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<RepoLinkDto, AppError> {
    let instance = instance_id(&state)?;
    let session = state.session(&repo_id)?;
    let (refs, _) = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        move || session.refs()
    })
    .await
    .map_err(crate::error::join_error)??;
    let remotes: Vec<RemoteInfo> = refs
        .remote_urls
        .iter()
        .filter(|remote| remote.direction == "fetch")
        .filter_map(|remote| normalize_remote(&remote.url))
        .collect();
    if remotes.is_empty() {
        return Err(AppError::new(
            "gitlab.no_remote",
            ErrorCategory::Input,
            "Aucun remote Git exploitable n'est configuré.",
        )
        .with_remediation("Ajoutez un remote SSH ou HTTPS vers l'instance GitLab."));
    }
    let projects = state
        .store
        .list_projects(&instance, None, 1000)
        .map_err(store_error)?;
    let project = match_project(&projects, &remotes).ok_or_else(|| {
        AppError::new(
            "gitlab.project_not_found",
            ErrorCategory::Input,
            "Aucun projet GitLab ne correspond aux remotes du dépôt.",
        )
        .with_remediation("Vérifiez l'URL du remote ou effectuez une association manuelle.")
    })?;
    let link = RepoLink {
        repo_id: repo_id.clone(),
        instance_id: instance,
        project_id: project.project_id,
        match_kind: "url".to_owned(),
        verified_at: beebranch_core::now_unix(),
    };
    state.store.set_repo_link(&link).map_err(store_error)?;
    Ok(link_dto(&state, &link))
}

#[tauri::command]
pub fn gitlab_repo_link_get(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Option<RepoLinkDto>, AppError> {
    let link = state
        .store
        .repo_link_for(&repo_id, "gitlab")
        .map_err(store_error)?;
    Ok(link.map(|link| link_dto(&state, &link)))
}

#[tauri::command]
pub fn gitlab_repo_link_manual(
    state: State<'_, AppState>,
    repo_id: String,
    project_id: u64,
) -> Result<RepoLinkDto, AppError> {
    let instance = instance_id(&state)?;
    if project_row(&state, &instance, project_id).is_none() {
        return Err(AppError::not_found(
            "Le projet GitLab n'est pas dans le cache local.",
        ));
    }
    let link = RepoLink {
        repo_id,
        instance_id: instance,
        project_id,
        match_kind: "manual".to_owned(),
        verified_at: beebranch_core::now_unix(),
    };
    state.store.set_repo_link(&link).map_err(store_error)?;
    Ok(link_dto(&state, &link))
}

fn linked_project(state: &AppState, repo_id: &str) -> Option<u64> {
    state
        .store
        .repo_link_for(repo_id, "gitlab")
        .ok()
        .flatten()
        .map(|link| link.project_id)
}

#[tauri::command]
pub async fn gitlab_mr_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrPageInput,
) -> Result<Paged<GitlabMergeRequest>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let project_id = input.project_id.or_else(|| {
        input
            .repo_id
            .as_deref()
            .and_then(|repo_id| linked_project(&state, repo_id))
    });
    let query = MergeRequestsQuery {
        project_id,
        scope: input.scope,
        page: input.page.unwrap_or(1),
        per_page: input.per_page.unwrap_or(50),
    };
    let page = client.merge_requests(query).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        gitlab_error(error)
    })?;
    Ok(page)
}

#[tauri::command]
pub async fn gitlab_mr_get(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
) -> Result<GitlabMergeRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .merge_request(project_id, iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_mr_pipelines(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
) -> Result<Vec<GitlabPipeline>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    client
        .merge_request_pipelines(project_id, iid)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[tauri::command]
pub async fn gitlab_mr_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateMrInput,
) -> Result<GitlabMergeRequest, AppError> {
    if input.title.trim().is_empty() {
        return Err(AppError::invalid_input(
            "le titre de la merge request est requis".to_owned(),
        ));
    }
    if input.source_branch == input.target_branch {
        return Err(AppError::invalid_input(
            "les branches source et cible doivent être différentes".to_owned(),
        ));
    }
    let project_id = input
        .project_id
        .or_else(|| linked_project(&state, &input.repo_id))
        .ok_or_else(|| {
            AppError::new(
                "gitlab.project_not_linked",
                ErrorCategory::Input,
                "Aucun projet GitLab n'est associé au dépôt.",
            )
            .with_remediation("Associez le dépôt à un projet GitLab.")
        })?;
    let session = state.session(&input.repo_id)?;

    // A source branch must exist on the remote before GitLab can accept the MR.
    let (refs, _) = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        move || session.refs()
    })
    .await
    .map_err(crate::error::join_error)??;
    let remote = refs
        .entries
        .iter()
        .find(|entry| {
            entry.kind == beebranch_git::refs::RefKind::Branch && entry.name == input.source_branch
        })
        .and_then(|entry| entry.upstream.as_deref())
        .and_then(|upstream| upstream.strip_prefix("refs/remotes/"))
        .and_then(|rest| rest.split('/').next())
        .map(str::to_owned)
        .or_else(|| refs.remotes.first().cloned())
        .unwrap_or_else(|| "origin".to_owned());
    let pushed = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        let remote = remote.clone();
        let branch = input.source_branch.clone();
        move || sync::remote_branch_sha(session.runner(), session.worktree(), &remote, &branch)
    })
    .await
    .map_err(crate::error::join_error)?
    .is_some();
    if !pushed {
        return Err(AppError::new(
            "gitlab.branch_not_pushed",
            ErrorCategory::GitState,
            format!(
                "La branche {} n'est pas présente sur le remote {remote}.",
                input.source_branch
            ),
        )
        .with_remediation("Poussez la branche avant de créer la merge request."));
    }

    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let payload = CreateMergeRequest {
        project_id,
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        title: input.title,
        description: input.description,
        draft: input.draft,
        remove_source_branch: input.remove_source_branch,
        squash: input.squash,
        allow_collaboration: input.allow_collaboration,
    };
    client
        .create_merge_request(&payload)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}
