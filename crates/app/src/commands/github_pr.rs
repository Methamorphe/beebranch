//! GitHub pull requests, checks and repository ↔ project association.

use std::collections::HashMap;

use beebranch_core::{AppError, ErrorCategory};
use beebranch_git::sync;
use beebranch_github::{
    normalize_remote, CreatePullRequest, GithubClient, GithubPipeline, GithubPullRequest, Paged,
    PullRequestScope, PullRequestsQuery, RemoteInfo, RepoRef,
};
use beebranch_store::{ProjectRow, RepoLink};
use tauri::{AppHandle, Emitter, State};

use crate::commands::github::not_configured_public as not_configured;
use crate::commands::gitlab_mr::{CreateMrInput, MrPageInput, RepoLinkDto};
use crate::error::{github_error, store_error};
use crate::state::AppState;

const PROVIDER: &str = "github";

pub(crate) fn client(state: &AppState) -> Result<GithubClient, AppError> {
    state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))?
        .clone()
        .ok_or_else(not_configured)
}

pub(crate) fn instance_id(state: &AppState) -> Result<String, AppError> {
    state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)
}

pub(crate) fn auth_event(app: &AppHandle, error: &beebranch_github::GithubError, instance: &str) {
    if error.code() == "auth.failed" {
        let _ = app.emit(
            "github://auth-expired",
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

fn github_project(row: &ProjectRow) -> beebranch_github::GithubProject {
    beebranch_github::GithubProject {
        id: row.project_id,
        name: row.name.clone(),
        path_with_namespace: row.path_with_namespace.clone(),
        web_url: row.web_url.clone(),
        ssh_url_to_repo: row.ssh_url.clone(),
        http_url_to_repo: row.http_url.clone(),
        default_branch: row.default_branch.clone(),
        last_activity_at: row.last_activity_at.clone(),
        description: None,
    }
}

fn match_project(projects: &[ProjectRow], remotes: &[RemoteInfo]) -> Option<ProjectRow> {
    for project in projects {
        for remote in remotes {
            if beebranch_github::matches_project(remote, &github_project(project)) {
                return Some(project.clone());
            }
        }
    }
    None
}

fn repo_ref_from_row(row: &ProjectRow) -> Option<RepoRef> {
    RepoRef::from_full_name(row.project_id, &row.path_with_namespace)
}

pub(crate) async fn resolve_repo_ref(
    state: &AppState,
    client: &GithubClient,
    instance: &str,
    project_id: u64,
) -> Result<RepoRef, AppError> {
    if let Some(row) = project_row(state, instance, project_id) {
        if let Some(reference) = repo_ref_from_row(&row) {
            return Ok(reference);
        }
    }
    let project = client.repository(project_id).await.map_err(github_error)?;
    RepoRef::from_full_name(project.id, &project.path_with_namespace)
        .ok_or_else(|| AppError::not_found("Le chemin du dépôt GitHub est illisible."))
}

fn resolve_project_ids(state: &AppState, instance: &str, items: &mut [GithubPullRequest]) {
    let projects = state
        .store
        .list_projects(instance, None, 1000)
        .unwrap_or_default();
    let by_path: HashMap<String, u64> = projects
        .iter()
        .map(|project| {
            (
                project.path_with_namespace.to_ascii_lowercase(),
                project.project_id,
            )
        })
        .collect();
    for item in items.iter_mut() {
        if item.project_id.is_some() {
            continue;
        }
        if let Some(name) = item.repository_name.as_ref() {
            item.project_id = by_path.get(&name.to_ascii_lowercase()).copied();
        }
    }
}

fn scope_of(input: &MrPageInput) -> PullRequestScope {
    match input.scope {
        beebranch_gitlab::MergeRequestScope::CreatedByMe => PullRequestScope::CreatedByMe,
        beebranch_gitlab::MergeRequestScope::AssignedToMe => PullRequestScope::AssignedToMe,
        beebranch_gitlab::MergeRequestScope::ReviewsForMe => PullRequestScope::ReviewsForMe,
        beebranch_gitlab::MergeRequestScope::All => PullRequestScope::All,
    }
}

fn linked_project(state: &AppState, repo_id: &str) -> Option<u64> {
    state
        .store
        .repo_link_for(repo_id, PROVIDER)
        .ok()
        .flatten()
        .map(|link| link.project_id)
}

/// Associate the current repository with a GitHub project using its remotes.
#[tauri::command]
pub async fn github_repo_link(
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
            "github.no_remote",
            ErrorCategory::Input,
            "Aucun remote Git exploitable n'est configuré.",
        )
        .with_remediation("Ajoutez un remote SSH ou HTTPS vers GitHub."));
    }
    let projects = state
        .store
        .list_projects(&instance, None, 1000)
        .map_err(store_error)?;
    let project = match_project(&projects, &remotes).ok_or_else(|| {
        AppError::new(
            "github.project_not_found",
            ErrorCategory::Input,
            "Aucun dépôt GitHub ne correspond aux remotes du dépôt.",
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
pub fn github_repo_link_get(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Option<RepoLinkDto>, AppError> {
    let link = state
        .store
        .repo_link_for(&repo_id, PROVIDER)
        .map_err(store_error)?;
    Ok(link.map(|link| link_dto(&state, &link)))
}

#[tauri::command]
pub fn github_repo_link_manual(
    state: State<'_, AppState>,
    repo_id: String,
    project_id: u64,
) -> Result<RepoLinkDto, AppError> {
    let instance = instance_id(&state)?;
    if project_row(&state, &instance, project_id).is_none() {
        return Err(AppError::not_found(
            "Le dépôt GitHub n'est pas dans le cache local.",
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

#[tauri::command]
pub async fn github_pr_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MrPageInput,
) -> Result<Paged<GithubPullRequest>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let project_id = input.project_id.or_else(|| {
        input
            .repo_id
            .as_deref()
            .and_then(|repo_id| linked_project(&state, repo_id))
    });
    let repo = match project_id {
        Some(id) => Some(resolve_repo_ref(&state, &client, &instance, id).await?),
        None => None,
    };
    let query = PullRequestsQuery {
        repo,
        scope: scope_of(&input),
        page: input.page.unwrap_or(1),
        per_page: input.per_page.unwrap_or(50),
    };
    let mut page = client.pull_requests(query).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })?;
    resolve_project_ids(&state, &instance, &mut page.items);
    Ok(page)
}

#[tauri::command]
pub async fn github_pr_get(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
    repository_name: Option<String>,
) -> Result<GithubPullRequest, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;

    // Search results may reference a repository that was never cached (the
    // project list only fetched the first pages). Resolve it by full name,
    // cache it, and return the numeric id so detail refreshes work.
    if project_id == 0 {
        let name = repository_name.ok_or_else(|| {
            AppError::invalid_input(
                "Le dépôt de cette pull request est inconnu ; associez le dépôt ou rechargez la liste."
                    .to_owned(),
            )
        })?;
        let reference = RepoRef::from_full_name(0, &name)
            .ok_or_else(|| AppError::invalid_input("Le nom du dépôt GitHub est invalide."))?;
        let project = client
            .repository_by_name(&reference.owner, &reference.name)
            .await
            .map_err(|error| {
                auth_event(&app, &error, &instance);
                github_error(error)
            })?;
        state
            .store
            .upsert_projects(&[ProjectRow {
                instance_id: instance.clone(),
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
            }])
            .map_err(store_error)?;
        let repo = RepoRef::from_full_name(project.id, &project.path_with_namespace)
            .ok_or_else(|| AppError::not_found("Le chemin du dépôt GitHub est illisible."))?;
        return client.pull_request(&repo, iid).await.map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        });
    }

    let repo = resolve_repo_ref(&state, &client, &instance, project_id).await?;
    client.pull_request(&repo, iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })
}

#[tauri::command]
pub async fn github_pr_checks(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: u64,
    iid: u64,
) -> Result<Vec<GithubPipeline>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, project_id).await?;
    let pull = client.pull_request(&repo, iid).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })?;
    let Some(sha) = pull.sha.as_deref() else {
        return Ok(Vec::new());
    };
    client.check_runs(&repo, sha).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        github_error(error)
    })
}

#[tauri::command]
pub async fn github_pr_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateMrInput,
) -> Result<GithubPullRequest, AppError> {
    if input.title.trim().is_empty() {
        return Err(AppError::invalid_input(
            "le titre de la pull request est requis".to_owned(),
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
                "github.project_not_linked",
                ErrorCategory::Input,
                "Aucun dépôt GitHub n'est associé au dépôt.",
            )
            .with_remediation("Associez le dépôt à un projet GitHub.")
        })?;
    let instance = instance_id(&state)?;
    let session = state.session(&input.repo_id)?;

    // A source branch must exist on the remote before GitHub can accept the PR.
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
            "github.branch_not_pushed",
            ErrorCategory::GitState,
            format!(
                "La branche {} n'est pas présente sur le remote {remote}.",
                input.source_branch
            ),
        )
        .with_remediation("Poussez la branche avant de créer la pull request."));
    }

    let client = client(&state)?;
    let repo = resolve_repo_ref(&state, &client, &instance, project_id).await?;
    let payload = CreatePullRequest {
        title: input.title,
        head: input.source_branch,
        base: input.target_branch,
        body: input.description,
        draft: input.draft,
        maintainer_can_modify: input.allow_collaboration,
    };
    client
        .create_pull_request(&repo, &payload)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            github_error(error)
        })
}
