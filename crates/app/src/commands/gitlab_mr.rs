//! GitLab merge requests, pipelines and repository ↔ project association.

use beebranch_core::{AppError, ErrorCategory};
use beebranch_git::sync;
use beebranch_gitlab::{
    normalize_remote, CreateMergeRequest, GitlabClient, GitlabMergeRequest, GitlabPipeline,
    GitlabProject, MergeRequestScope, MergeRequestsQuery, Paged, RemoteInfo,
};
use beebranch_store::{InstanceRow, ProjectRow, RepoLink};
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
    /// Reviewer names (GitHub logins, GitLab usernames).
    #[serde(default)]
    pub reviewers: Vec<String>,
    /// Assignee names (GitHub logins, GitLab usernames).
    #[serde(default)]
    pub assignees: Vec<String>,
    /// Label names applied at creation.
    #[serde(default)]
    pub labels: Vec<String>,
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

pub(crate) fn client(state: &AppState) -> Result<GitlabClient, AppError> {
    state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))?
        .clone()
        .ok_or_else(not_configured)
}

pub(crate) fn instance_id(state: &AppState) -> Result<String, AppError> {
    state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)
}

/// Resolve usernames to GitLab ids, refusing unknown ones.
///
/// Duplicates collapse to a single id so the request stays within the
/// provider's limits.
async fn resolve_user_ids(client: &GitlabClient, names: &[String]) -> Result<Vec<u64>, AppError> {
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let id = client
            .user_id(name)
            .await
            .map_err(gitlab_error)?
            .ok_or_else(|| {
                AppError::invalid_input(format!(
                    "L'utilisateur `{name}` est introuvable sur GitLab."
                ))
            })?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

pub(crate) fn auth_event(app: &AppHandle, error: &beebranch_gitlab::GitlabError, instance: &str) {
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

fn instance_row(state: &AppState) -> Result<InstanceRow, AppError> {
    state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .clone()
        .ok_or_else(not_configured)
}

fn instance_host(instance: &InstanceRow) -> Option<String> {
    url::Url::parse(&instance.base_url)
        .ok()?
        .host_str()
        .map(str::to_ascii_lowercase)
}

/// Path prefix the instance is mounted under (`https://host/gitlab`).
fn instance_prefix(instance: &InstanceRow) -> String {
    url::Url::parse(&instance.base_url)
        .ok()
        .map(|url| url.path().trim_matches('/').to_owned())
        .unwrap_or_default()
}

/// Project paths worth requesting for one remote: the raw path, then the path
/// without the instance prefix when the instance is mounted under one.
fn project_paths(remote_path: &str, prefix: &str) -> Vec<String> {
    let path = remote_path.trim_matches('/');
    let mut paths = vec![path.to_owned()];
    if !prefix.is_empty() {
        if let Some(stripped) = path
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('/'))
        {
            if !stripped.is_empty() {
                paths.push(stripped.to_owned());
            }
        }
    }
    paths
}

fn project_to_row(instance: &str, project: &GitlabProject) -> ProjectRow {
    ProjectRow {
        instance_id: instance.to_owned(),
        project_id: project.id,
        path_with_namespace: project.path_with_namespace.clone(),
        name: project.name.clone(),
        web_url: project.web_url.clone(),
        ssh_url: Some(project.ssh_url_to_repo.clone()),
        http_url: Some(project.http_url_to_repo.clone()),
        default_branch: project.default_branch.clone(),
        last_activity_at: project.last_activity_at.clone(),
        fetched_at: beebranch_core::now_unix(),
        etag: None,
    }
}

fn store_link(
    state: &AppState,
    repo_id: &str,
    instance: &str,
    project_id: u64,
) -> Result<RepoLink, AppError> {
    let link = RepoLink {
        repo_id: repo_id.to_owned(),
        instance_id: instance.to_owned(),
        project_id,
        match_kind: "url".to_owned(),
        verified_at: beebranch_core::now_unix(),
    };
    state.store.set_repo_link(&link).map_err(store_error)?;
    Ok(link)
}

/// Resolve and store the GitLab project that owns `remote_urls`.
///
/// Only remotes on the configured instance are considered, so a repository of
/// another forge never borrows a same-named GitLab project. Cached projects
/// are matched first; when none matches — typically after the project was
/// renamed — the exact remote path is resolved through the API and the cache
/// is refreshed before the association is stored. `None` means no remote points
/// at the instance, so the repository has no CI to report.
pub(crate) async fn ensure_repo_link(
    state: &AppState,
    repo_id: &str,
    remote_urls: &[String],
) -> Result<Option<RepoLink>, AppError> {
    if let Some(link) = state
        .store
        .repo_link_for(repo_id, "gitlab")
        .map_err(store_error)?
    {
        return Ok(Some(link));
    }
    let instance = instance_row(state)?;
    let Some(host) = instance_host(&instance) else {
        return Ok(None);
    };
    let remotes: Vec<RemoteInfo> = remote_urls
        .iter()
        .filter_map(|url| normalize_remote(url))
        .filter(|remote| remote.host.eq_ignore_ascii_case(&host))
        .collect();
    if remotes.is_empty() {
        return Ok(None);
    }
    let projects = state
        .store
        .list_projects(&instance.id, None, 1000)
        .map_err(store_error)?;
    if let Some(project) = match_project(&projects, &remotes) {
        return store_link(state, repo_id, &instance.id, project.project_id).map(Some);
    }
    let prefix = instance_prefix(&instance);
    let client = client(state)?;
    for remote in remotes {
        for path in project_paths(&remote.path, &prefix) {
            match client.project_by_path(&path).await {
                Ok(project) => {
                    state
                        .store
                        .upsert_projects(&[project_to_row(&instance.id, &project)])
                        .map_err(store_error)?;
                    return store_link(state, repo_id, &instance.id, project.id).map(Some);
                }
                // Missing or not readable by this token: try the next candidate.
                Err(error) if matches!(error.status(), Some(403) | Some(404)) => continue,
                Err(error) => return Err(gitlab_error(error)),
            }
        }
    }
    Ok(None)
}

/// Associate the current repository with a GitLab project using its remotes.
#[tauri::command]
pub async fn gitlab_repo_link(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<RepoLinkDto, AppError> {
    let _ = instance_id(&state)?;
    let session = state.session(&repo_id)?;
    let (refs, _) = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        move || session.refs()
    })
    .await
    .map_err(crate::error::join_error)??;
    let remote_urls: Vec<String> = refs
        .remote_urls
        .iter()
        .filter(|remote| remote.direction == "fetch")
        .map(|remote| remote.url.clone())
        .collect();
    if remote_urls
        .iter()
        .all(|url| normalize_remote(url).is_none())
    {
        return Err(AppError::new(
            "gitlab.no_remote",
            ErrorCategory::Input,
            "Aucun remote Git exploitable n'est configuré.",
        )
        .with_remediation("Ajoutez un remote SSH ou HTTPS vers l'instance GitLab."));
    }
    // An explicit association may rely on a host alias (for example an SSH
    // config entry), so cached projects are matched against every remote
    // before the instance-host-restricted automatic resolution runs.
    let instance = instance_row(&state)?;
    let remotes: Vec<RemoteInfo> = remote_urls
        .iter()
        .filter_map(|url| normalize_remote(url))
        .collect();
    let projects = state
        .store
        .list_projects(&instance.id, None, 1000)
        .map_err(store_error)?;
    let link = match match_project(&projects, &remotes) {
        Some(project) => store_link(&state, &repo_id, &instance.id, project.project_id)?,
        None => ensure_repo_link(&state, &repo_id, &remote_urls)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    "gitlab.project_not_found",
                    ErrorCategory::Input,
                    "Aucun projet GitLab ne correspond aux remotes du dépôt.",
                )
                .with_remediation("Vérifiez l'URL du remote ou effectuez une association manuelle.")
            })?,
    };
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
    let reviewer_ids = resolve_user_ids(&client, &input.reviewers).await?;
    let assignee_ids = resolve_user_ids(&client, &input.assignees).await?;
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
        reviewer_ids,
        assignee_ids,
        labels: input.labels,
    };
    client
        .create_merge_request(&payload)
        .await
        .map_err(|error| {
            auth_event(&app, &error, &instance);
            gitlab_error(error)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use beebranch_store::Store;

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

    fn project() -> ProjectRow {
        ProjectRow {
            instance_id: "gl_test".to_owned(),
            project_id: 307,
            path_with_namespace: "op/opteeam-api-2026".to_owned(),
            name: "opteeam-api-2026".to_owned(),
            web_url: "https://gitlab.example.test/op/opteeam-api-2026".to_owned(),
            ssh_url: Some("git@gitlab.example.test:op/opteeam-api-2026.git".to_owned()),
            http_url: Some("https://gitlab.example.test/op/opteeam-api-2026.git".to_owned()),
            default_branch: Some("develop".to_owned()),
            last_activity_at: None,
            fetched_at: 0,
            etag: None,
        }
    }

    fn state_with(store: Store) -> AppState {
        store.upsert_instance(&instance()).expect("instance");
        crate::state::test_state(std::env::temp_dir(), store)
    }

    #[test]
    fn strips_the_instance_prefix_from_a_remote_path() {
        assert_eq!(
            project_paths("/op/api-2026/", ""),
            vec!["op/api-2026".to_owned()]
        );
        assert_eq!(
            project_paths("gitlab/op/api-2026", "gitlab"),
            vec!["gitlab/op/api-2026".to_owned(), "op/api-2026".to_owned()]
        );
        assert_eq!(
            project_paths("gitlab-only/op", "gitlab"),
            vec!["gitlab-only/op".to_owned()]
        );
    }

    #[tokio::test]
    async fn associates_a_remote_with_a_cached_project() {
        let state = state_with(Store::open_in_memory().expect("store"));
        state.store.upsert_projects(&[project()]).expect("cache");
        *state.gitlab_instance.lock().expect("lock") = Some(instance());
        // No client is configured: reaching an association proves the cached
        // project matched without any API call.
        let link = ensure_repo_link(
            &state,
            "repo_1",
            &["https://gitlab.example.test/op/opteeam-api-2026.git".to_owned()],
        )
        .await
        .expect("link")
        .expect("associated");

        assert_eq!(link.project_id, 307);
        assert_eq!(link.match_kind, "url");
        assert_eq!(
            state
                .store
                .repo_link_for("repo_1", "gitlab")
                .expect("stored"),
            Some(link.clone())
        );

        // Idempotent: the stored association answers without remotes.
        let again = ensure_repo_link(&state, "repo_1", &[])
            .await
            .expect("again")
            .expect("associated");
        assert_eq!(again, link);
    }

    #[tokio::test]
    async fn a_remote_on_another_host_is_not_associated() {
        let state = state_with(Store::open_in_memory().expect("store"));
        *state.gitlab_instance.lock().expect("lock") = Some(instance());

        let link = ensure_repo_link(
            &state,
            "repo_1",
            &["https://github.com/team/beebranch.git".to_owned()],
        )
        .await
        .expect("no association");

        assert!(link.is_none());
        assert!(state
            .store
            .repo_link_for("repo_1", "gitlab")
            .expect("stored")
            .is_none());
    }
}
