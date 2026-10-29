//! Local multi-repository workspaces (P3-T05).
//!
//! A workspace is a bounded list of local paths. Multi-repository actions run
//! in isolation per repository: a failure never cancels the others, and each
//! result carries its own outcome. Sessions opened only for the action are
//! closed afterwards so memory stays bounded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use beebranch_core::{AppError, Confirmation, DestructiveAction, HeadState, RepoState};
use beebranch_git::session::{InvalidationArea, RepoSession, SessionOptions, SessionRegistry};
use beebranch_git::sync::{self, PullStrategy, SyncKind};
use beebranch_git::{discover, GitRunner, OperationContext};
use beebranch_store::{Store, WorkspaceRepoRow, WorkspaceRow, WORKSPACE_REPO_LIMIT};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{join_error, store_error};
use crate::state::AppState;

const SYNC_WORKERS: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub repos: Vec<WorkspaceRepoDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoDto {
    pub path: String,
    pub name: Option<String>,
    pub added_at: i64,
}

fn workspace_dto(store: &Store, row: &WorkspaceRow) -> Result<WorkspaceDto, AppError> {
    let repos = store
        .workspace_repos(&row.id)
        .map_err(store_error)?
        .into_iter()
        .map(|repo| WorkspaceRepoDto {
            path: repo.path,
            name: repo.name,
            added_at: repo.added_at,
        })
        .collect();
    Ok(WorkspaceDto {
        id: row.id.clone(),
        name: row.name.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        repos,
    })
}

#[tauri::command]
pub async fn workspace_list(state: State<'_, AppState>) -> Result<Vec<WorkspaceDto>, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .list_workspaces()
            .map_err(store_error)?
            .iter()
            .map(|row| workspace_dto(&store, row))
            .collect()
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNameRequest {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenameRequest {
    pub workspace_id: String,
    pub name: String,
}

#[tauri::command]
pub async fn workspace_create(
    state: State<'_, AppState>,
    request: WorkspaceNameRequest,
) -> Result<WorkspaceDto, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let row = store.create_workspace(&request.name).map_err(store_error)?;
        workspace_dto(&store, &row)
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdRequest {
    pub workspace_id: String,
}

#[tauri::command]
pub async fn workspace_rename(
    state: State<'_, AppState>,
    request: WorkspaceRenameRequest,
) -> Result<WorkspaceDto, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let row = store
            .rename_workspace(&request.workspace_id, &request.name)
            .map_err(store_error)?;
        workspace_dto(&store, &row)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn workspace_delete(
    state: State<'_, AppState>,
    request: WorkspaceIdRequest,
) -> Result<bool, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .delete_workspace(&request.workspace_id)
            .map_err(store_error)
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoRequest {
    pub workspace_id: String,
    pub path: String,
}

#[tauri::command]
pub async fn workspace_add_repo(
    state: State<'_, AppState>,
    request: WorkspaceRepoRequest,
) -> Result<WorkspaceDto, AppError> {
    let runner = state.runner()?.clone();
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let requested = PathBuf::from(&request.path);
        let discovery = discover::discover(&runner, &requested)?;
        let worktree = discovery.worktree()?.to_path_buf();
        let canonical = std::fs::canonicalize(&worktree).unwrap_or(worktree);
        let path = canonical.display().to_string();
        let name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let repos = store
            .workspace_repos(&request.workspace_id)
            .map_err(store_error)?;
        if repos.len() >= WORKSPACE_REPO_LIMIT && !repos.iter().any(|repo| repo.path == path) {
            return Err(AppError::invalid_input(format!(
                "Un workspace est limité à {WORKSPACE_REPO_LIMIT} dépôts."
            )));
        }
        store
            .add_workspace_repo(&request.workspace_id, &path, name.as_deref())
            .map_err(store_error)?;
        let row = store
            .list_workspaces()
            .map_err(store_error)?
            .into_iter()
            .find(|row| row.id == request.workspace_id)
            .ok_or_else(|| AppError::not_found("Workspace introuvable."))?;
        workspace_dto(&store, &row)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn workspace_remove_repo(
    state: State<'_, AppState>,
    request: WorkspaceRepoRequest,
) -> Result<WorkspaceDto, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .remove_workspace_repo(&request.workspace_id, &request.path)
            .map_err(store_error)?;
        let row = store
            .list_workspaces()
            .map_err(store_error)?
            .into_iter()
            .find(|row| row.id == request.workspace_id)
            .ok_or_else(|| AppError::not_found("Workspace introuvable."))?;
        workspace_dto(&store, &row)
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoStatus {
    pub path: String,
    pub name: Option<String>,
    pub available: bool,
    pub repo_id: Option<String>,
    pub state: Option<RepoState>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn workspace_status(
    state: State<'_, AppState>,
    request: WorkspaceIdRequest,
) -> Result<Vec<WorkspaceRepoStatus>, AppError> {
    let runner = state.runner()?.clone();
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repos = store
            .workspace_repos(&request.workspace_id)
            .map_err(store_error)?;
        Ok::<_, AppError>(
            repos
                .into_iter()
                .map(|repo| status_one(&runner, repo))
                .collect(),
        )
    })
    .await
    .map_err(join_error)?
}

fn status_one(runner: &GitRunner, repo: WorkspaceRepoRow) -> WorkspaceRepoStatus {
    let result = (|| {
        let discovery = discover::discover(runner, &repo.path)?;
        let worktree = discovery.worktree()?;
        let detected = beebranch_git::state::detect(runner, &discovery, Some(1))?;
        let repo_id = beebranch_core::RepoId::from_path(worktree)
            .as_str()
            .to_owned();
        Ok::<_, AppError>((repo_id, detected.state))
    })();
    match result {
        Ok((repo_id, state)) => WorkspaceRepoStatus {
            path: repo.path,
            name: repo.name,
            available: true,
            repo_id: Some(repo_id),
            state: Some(state),
            error: None,
        },
        Err(error) => WorkspaceRepoStatus {
            path: repo.path,
            name: repo.name,
            available: false,
            repo_id: None,
            state: None,
            error: Some(format!(
                "{} {}",
                error.message,
                error.remediation.unwrap_or_default()
            )),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAction {
    Fetch,
    Pull,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncRequest {
    pub workspace_id: String,
    pub action: WorkspaceAction,
    #[serde(default)]
    pub confirmation: Confirmation,
    /// Paths to act on; omitted or empty means every repository.
    #[serde(default)]
    pub repo_paths: Option<Vec<String>>,
    /// Pull strategy; omitted keeps the automatic resolution.
    #[serde(default)]
    pub strategy: Option<PullStrategy>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncResult {
    pub path: String,
    pub name: Option<String>,
    pub repo_id: Option<String>,
    pub ok: bool,
    pub message: String,
    pub error_code: Option<String>,
    pub state: Option<RepoState>,
}

#[tauri::command]
pub async fn workspace_sync(
    state: State<'_, AppState>,
    request: WorkspaceSyncRequest,
) -> Result<Vec<WorkspaceSyncResult>, AppError> {
    if request.action == WorkspaceAction::Pull {
        // Pull modifies working trees; the policy is explicit.
        request
            .confirmation
            .verify(DestructiveAction::WorkspaceSync, None)?;
    }
    let runner = state.runner()?.clone();
    let registry = state.sessions.clone();
    let store = state.store.clone();
    let mut rows = store
        .workspace_repos(&request.workspace_id)
        .map_err(store_error)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(requested) = request.repo_paths.as_ref().filter(|list| !list.is_empty()) {
        let mut selected = Vec::with_capacity(requested.len());
        for path in requested {
            let found = rows
                .iter()
                .find(|row| same_path(&row.path, path))
                .cloned()
                .ok_or_else(|| {
                    AppError::invalid_input(format!(
                        "`{path}` n'appartient pas à ce workspace"
                    ))
                })?;
            selected.push(found);
        }
        rows = selected;
    }
    if rows.len() > WORKSPACE_REPO_LIMIT {
        return Err(AppError::internal("workspace dépasse sa borne"));
    }
    let strategy = request.strategy.unwrap_or(PullStrategy::Auto);
    tauri::async_runtime::spawn_blocking(move || {
        run_sync_workers(runner, registry, rows, request.action, strategy)
    })
    .await
    .map_err(join_error)
}

pub fn run_sync_workers(
    runner: GitRunner,
    registry: Arc<SessionRegistry>,
    rows: Vec<WorkspaceRepoRow>,
    action: WorkspaceAction,
    strategy: PullStrategy,
) -> Vec<WorkspaceSyncResult> {
    let total = rows.len();
    let rows = Arc::new(rows);
    let next = Arc::new(AtomicUsize::new(0));
    let results: Arc<Mutex<HashMap<usize, WorkspaceSyncResult>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut handles = Vec::new();
    for worker in 0..SYNC_WORKERS.min(total) {
        let runner = runner.clone();
        let registry = registry.clone();
        let rows = rows.clone();
        let next = next.clone();
        let results = results.clone();
        handles.push(std::thread::spawn(move || loop {
            let index = next.fetch_add(1, Ordering::SeqCst);
            if index >= rows.len() {
                break;
            }
            let result = run_one(&runner, &registry, &rows[index], action, index, worker, strategy);
            if let Ok(mut guard) = results.lock() {
                guard.insert(index, result);
            }
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }
    let mut guard = match results.lock() {
        Ok(guard) => guard,
        Err(_) => return Vec::new(),
    };
    let ordered: Vec<WorkspaceSyncResult> = (0..total)
        .filter_map(|index| guard.remove(&index))
        .collect();
    ordered
}

fn run_one(
    runner: &GitRunner,
    registry: &SessionRegistry,
    row: &WorkspaceRepoRow,
    action: WorkspaceAction,
    index: usize,
    worker: usize,
    strategy: PullStrategy,
) -> WorkspaceSyncResult {
    let result = (|| -> Result<WorkspaceSyncResult, AppError> {
        let (session, created) = registry.open(
            runner,
            &row.path,
            SessionOptions {
                debounce: Some(std::time::Duration::from_millis(250)),
                ..SessionOptions::default()
            },
        )?;
        let repo_id = session.id().as_str().to_owned();
        let outcome = run_repo_action(&session, action, index, worker, strategy);
        let state = session.refresh_state().ok();
        if created {
            registry.close(session.id());
        }
        match outcome {
            Ok(sync) => Ok(WorkspaceSyncResult {
                path: row.path.clone(),
                name: row.name.clone(),
                repo_id: Some(repo_id),
                ok: true,
                message: bounded_output(&sync.output),
                error_code: None,
                state,
            }),
            Err(error) => Ok(WorkspaceSyncResult {
                path: row.path.clone(),
                name: row.name.clone(),
                repo_id: Some(repo_id),
                ok: false,
                message: error.message.clone(),
                error_code: Some(error.code.to_owned()),
                state,
            }),
        }
    })();
    result.unwrap_or_else(|error| WorkspaceSyncResult {
        path: row.path.clone(),
        name: row.name.clone(),
        repo_id: None,
        ok: false,
        message: error.message,
        error_code: Some(error.code.to_owned()),
        state: None,
    })
}

fn run_repo_action(
    session: &RepoSession,
    action: WorkspaceAction,
    index: usize,
    worker: usize,
    strategy: PullStrategy,
) -> Result<sync::SyncOutcome, AppError> {
    let (remote, branch) = match action {
        WorkspaceAction::Fetch => {
            let (refs, _) = session.refs()?;
            let remote = refs.remotes.first().cloned().ok_or_else(|| {
                AppError::new(
                    "workspace.no_remote",
                    beebranch_core::ErrorCategory::GitState,
                    "Ce dépôt n'a aucun remote.",
                )
            })?;
            (remote, String::new())
        }
        WorkspaceAction::Pull => {
            let state = session.state();
            let upstream = match state.head {
                Some(HeadState::Branch { upstream, .. }) => upstream,
                _ => {
                    return Err(AppError::new(
                        "workspace.detached",
                        beebranch_core::ErrorCategory::GitState,
                        "Le pull exige une branche avec upstream.",
                    ))
                }
            };
            let upstream = upstream.ok_or_else(|| {
                AppError::new(
                    "workspace.no_upstream",
                    beebranch_core::ErrorCategory::GitState,
                    "La branche n'a pas d'upstream.",
                )
            })?;
            let (remote, rest) = upstream
                .split_once('/')
                .ok_or_else(|| AppError::invalid_input(format!("upstream invalide: {upstream}")))?;
            let upstream_branch = rest.to_owned();
            (remote.to_owned(), upstream_branch)
        }
    };
    let operation_id = format!("workspace_{index}_{worker}");
    let (remote_for_job, branch_for_job) = (remote.clone(), branch.clone());
    let action_for_job = action;
    let slot: Arc<Mutex<Option<sync::SyncOutcome>>> = Arc::new(Mutex::new(None));
    let writer = slot.clone();
    session.mutate(move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let context = OperationContext::new(&operation_id, "workspace sync");
        let outcome = match action_for_job {
            WorkspaceAction::Fetch => {
                let command =
                    sync::spawn_fetch(runner, worktree, &remote_for_job, &context, |_| {})?;
                sync::finish(command, SyncKind::Fetch, || None)?
            }
            WorkspaceAction::Pull => {
                let command = sync::spawn_pull(
                    runner,
                    worktree,
                    &remote_for_job,
                    &branch_for_job,
                    strategy,
                    &context,
                    |_| {},
                )?;
                sync::finish(command, SyncKind::Pull, || None)?
            }
        };
        if let Ok(mut slot) = writer.lock() {
            *slot = Some(outcome);
        }
        Ok(InvalidationArea::ALL.to_vec())
    })?;
    let outcome = slot
        .lock()
        .map_err(|_| AppError::internal("verrou de résultat workspace"))?
        .take()
        .ok_or_else(|| AppError::internal("la synchronisation n'a produit aucun résultat"))?;
    Ok(outcome)
}

/// Whether two workspace paths designate the same directory.
///
/// Rows keep the canonical form Git reported (`\\?\C:\…` on Windows), while a
/// caller usually sends the path it opened: both are canonicalised before the
/// comparison so the two spellings meet.
fn same_path(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let canonical = |value: &str| std::fs::canonicalize(value).ok();
    match (canonical(left), canonical(right)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn bounded_output(output: &str) -> String {
    let redacted = beebranch_git::redact(output);
    let mut text: String = redacted.chars().take(500).collect();
    if redacted.chars().count() > 500 {
        text.push('…');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_bounded_and_redacted() {
        let text = bounded_output(&format!("token glpat-secret {}", "x".repeat(600)));
        assert!(text.chars().count() <= 501);
        assert!(!text.contains("glpat-"));
    }
}
