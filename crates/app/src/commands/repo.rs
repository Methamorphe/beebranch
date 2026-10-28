use std::sync::Arc;

use beebranch_core::{AppError, RepoId, RepoState};
use beebranch_git::clone::{CloneOptions, HttpsAuth};
use beebranch_git::init::{init as init_repository, InitOptions};
use beebranch_git::session::{ChangeSink, RepoChange, RepoSession, SessionOptions};
use beebranch_gitlab::normalize_url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::util::{begin_operation, finish_operation, new_operation_id};
use crate::error::{join_error, store_error};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfoDto {
    pub repo_id: String,
    pub name: String,
    pub worktree: String,
    pub git_dir: String,
    pub common_dir: String,
    pub bare: bool,
    pub linked_worktree: bool,
    pub submodule: bool,
    pub superproject: Option<String>,
    pub shallow: bool,
    pub git_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    pub repo: RepoInfoDto,
    pub state: RepoState,
    pub generation: u64,
    pub created: bool,
    pub locks: Vec<String>,
}

fn info(session: &RepoSession, state: &AppState) -> RepoInfoDto {
    let discovery = session.discovery();
    RepoInfoDto {
        repo_id: session.id().as_str().to_owned(),
        name: session
            .worktree()
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| session.worktree().display().to_string()),
        worktree: session.worktree().display().to_string(),
        git_dir: discovery.git_dir.display().to_string(),
        common_dir: discovery.common_dir.display().to_string(),
        bare: discovery.bare,
        linked_worktree: discovery.linked_worktree,
        submodule: discovery.submodule,
        superproject: discovery
            .superproject
            .as_ref()
            .map(|path| path.display().to_string()),
        shallow: discovery.shallow,
        git_version: state
            .capability
            .as_ref()
            .map(|capability| capability.version.to_string()),
    }
}

fn view(session: &RepoSession, state: &AppState, created: bool) -> RepoView {
    RepoView {
        repo: info(session, state),
        state: session.state(),
        generation: session.generation(),
        created,
        locks: session
            .locks()
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    }
}

async fn open_path(app: &AppHandle, state: &AppState, path: String) -> Result<RepoView, AppError> {
    let runner = state.runner()?.clone();
    let handle = app.clone();
    let sink: ChangeSink = Arc::new(move |change: RepoChange| {
        let _ = handle.emit("repo://changed", &change);
        if change
            .areas
            .contains(&beebranch_git::session::InvalidationArea::State)
        {
            let _ = handle.emit("repo://state-changed", &change);
        }
    });

    let registry = state.sessions.clone();
    let requested = path.clone();
    let (session, created) = tauri::async_runtime::spawn_blocking(move || {
        registry.open(
            &runner,
            &requested,
            SessionOptions {
                sink: Some(sink),
                ..SessionOptions::default()
            },
        )
    })
    .await
    .map_err(join_error)??;

    state
        .store
        .touch_recent_repo(
            session.id().as_str(),
            &session.worktree().display().to_string(),
            session
                .worktree()
                .file_name()
                .and_then(|name| name.to_str()),
        )
        .map_err(store_error)?;

    Ok(view(&session, state, created))
}

/// Open (or reuse) a repository worktree.
#[tauri::command]
pub async fn repo_open(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepoView, AppError> {
    open_path(&app, &state, path).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitRequest {
    pub destination: String,
    #[serde(default)]
    pub initial_branch: Option<String>,
}

/// Create a local repository, then open it in a new tab.
#[tauri::command]
pub async fn repo_init(
    app: AppHandle,
    state: State<'_, AppState>,
    request: InitRequest,
) -> Result<RepoView, AppError> {
    let runner = state.runner()?.clone();
    let operation_id = new_operation_id("init");
    begin_operation(&state, &operation_id, "init", "", &request.destination)?;
    let destination = request.destination.clone();
    let options = InitOptions {
        initial_branch: request.initial_branch.clone(),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        init_repository(&runner, &destination, &options)
    })
    .await
    .map_err(join_error)?;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    let path = result?;
    open_path(&app, &state, path.display().to_string()).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub url: String,
    pub destination: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub recurse_submodules: bool,
}

/// Use the active GitLab token only when the clone URL targets the same
/// HTTPS host. Other hosts never receive the token. A credential discovered in
/// the Git configuration is used when the keychain holds nothing for that host.
fn https_auth_for(state: &AppState, url: &str) -> Option<HttpsAuth> {
    let clone_url = normalize_url(url).ok()?;
    if let Some(instance) = state.gitlab_instance.lock().ok()?.clone() {
        if let Ok(instance_url) = normalize_url(&instance.base_url) {
            if clone_url.host.eq_ignore_ascii_case(&instance_url.host) {
                let account = format!("{}#{}", instance_url.host, instance.id);
                if let Some(token) = state.secrets.get(&account).ok().flatten() {
                    return Some(HttpsAuth {
                        username: "oauth2".to_owned(),
                        token,
                    });
                }
            }
        }
    }
    let credential = state.gitlab_credential.lock().ok()?.clone()?;
    if !clone_url.host.eq_ignore_ascii_case(&credential.host) {
        return None;
    }
    Some(HttpsAuth {
        username: credential.username,
        token: credential.password,
    })
}

/// Clone a repository, then open it in a new tab.
#[tauri::command]
pub async fn repo_clone(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CloneRequest,
) -> Result<RepoView, AppError> {
    let runner = state.runner()?.clone();
    let operation_id = new_operation_id("clone");
    begin_operation(&state, &operation_id, "clone", "", &request.destination)?;
    let url = request.url.clone();
    let destination = request.destination.clone();
    let https_auth = https_auth_for(&state, &request.url);
    let options = CloneOptions {
        branch: request.branch.clone(),
        depth: request.depth,
        recurse_submodules: request.recurse_submodules,
        https_auth,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        beebranch_git::clone::clone(&runner, &url, &destination, &options)
    })
    .await
    .map_err(join_error)?;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    let path = result?;
    open_path(&app, &state, path.display().to_string()).await
}

/// Close a repository session and stop its watcher and mutation queue.
#[tauri::command]
pub async fn repo_close(state: State<'_, AppState>, repo_id: String) -> Result<bool, AppError> {
    let registry = state.sessions.clone();
    let id = RepoId::from_raw(repo_id);
    tauri::async_runtime::spawn_blocking(move || registry.close(&id))
        .await
        .map_err(join_error)
}

/// List open sessions.
#[tauri::command]
pub fn repo_list_open(state: State<'_, AppState>) -> Vec<RepoInfoDto> {
    state
        .sessions
        .list()
        .iter()
        .map(|session| info(session, &state))
        .collect()
}

/// Recent repositories persisted in SQLite.
#[tauri::command]
pub fn repo_list_recent(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<beebranch_store::RecentRepo>, AppError> {
    state
        .store
        .list_recent_repos(limit.unwrap_or(20))
        .map_err(store_error)
}

#[tauri::command]
pub async fn repo_get_state(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<RepoView, AppError> {
    let session = state.session(&repo_id)?;
    let worker = session.clone();
    tauri::async_runtime::spawn_blocking(move || worker.refresh_state())
        .await
        .map_err(join_error)??;
    Ok(view(&session, &state, false))
}

#[tauri::command]
pub async fn repo_refresh(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<RepoView, AppError> {
    let session = state.session(&repo_id)?;
    let worker = session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        worker.refresh_state()?;
        worker.invalidate(vec![
            beebranch_git::session::InvalidationArea::Refs,
            beebranch_git::session::InvalidationArea::Index,
            beebranch_git::session::InvalidationArea::Worktree,
            beebranch_git::session::InvalidationArea::Head,
            beebranch_git::session::InvalidationArea::State,
        ]);
        Ok::<(), AppError>(())
    })
    .await
    .map_err(join_error)??;
    Ok(view(&session, &state, false))
}

/// Close a repository, enforcing the confirmation policy when an intermediate
/// Git operation or unresolved conflicts are visible.
#[tauri::command]
pub async fn repo_close_checked(
    state: State<'_, AppState>,
    repo_id: String,
    confirmation: Option<beebranch_core::Confirmation>,
) -> Result<bool, AppError> {
    let session = state.session(&repo_id)?;
    let repo_state = session.state();
    let needs_confirmation = repo_state.operation.is_some() || !repo_state.conflicts.is_empty();
    let journal_id = if needs_confirmation {
        confirmation
            .unwrap_or_default()
            .verify(beebranch_core::DestructiveAction::CloseTabInProgress, None)?;
        let id = crate::commands::util::new_operation_id("close-tab");
        crate::commands::util::begin_destructive(
            &state,
            &id,
            beebranch_core::DestructiveAction::CloseTabInProgress.code(),
            &repo_id,
            &session.worktree().display().to_string(),
        )?;
        Some(id)
    } else {
        None
    };
    let cancelled = state.cancel_repository(&repo_id);
    if cancelled > 0 {
        tracing::info!(
            repo_id,
            cancelled,
            "cancelling in-flight operations before close"
        );
    }
    let registry = state.sessions.clone();
    let id = RepoId::from_raw(repo_id);
    let closed = tauri::async_runtime::spawn_blocking(move || registry.close(&id))
        .await
        .map_err(join_error)?;
    if let Some(journal_id) = journal_id {
        crate::commands::util::finish_destructive(
            &state,
            &journal_id,
            "fermeture d'un onglet avec état intermédiaire",
            None,
        )?;
    }
    Ok(closed)
}
