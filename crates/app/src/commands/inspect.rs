//! File history and blame commands (P2-T05).

use beebranch_core::AppError;
use beebranch_git::blame::{self, BlameReport, FileHistory};
use serde::Deserialize;
use tauri::State;

use crate::error::join_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameRequest {
    pub repo_id: String,
    pub path: String,
    pub start: Option<u32>,
    pub end: Option<u32>,
    pub max_lines: Option<u32>,
}

#[tauri::command]
pub async fn blame_get(
    state: State<'_, AppState>,
    request: BlameRequest,
) -> Result<BlameReport, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        blame::blame(
            session.runner(),
            session.worktree(),
            &request.path,
            request.start,
            request.end,
            request.max_lines,
        )
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryRequest {
    pub repo_id: String,
    pub path: String,
    #[serde(default = "default_follow")]
    pub follow: bool,
    pub max_entries: Option<u32>,
    pub revision: Option<String>,
}

fn default_follow() -> bool {
    true
}

#[tauri::command]
pub async fn file_history_get(
    state: State<'_, AppState>,
    request: FileHistoryRequest,
) -> Result<FileHistory, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        blame::history(
            session.runner(),
            session.worktree(),
            &request.path,
            request.follow,
            request.max_entries,
            request.revision.as_deref(),
        )
    })
    .await
    .map_err(join_error)?
}

/// Read the effective Git identity for the repository, used by the commit
/// form before committing.
#[tauri::command]
pub async fn commit_identity(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<CommitIdentity, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let runner = session.runner();
        let worktree = session.worktree();
        let read = |key: &str| -> Option<String> {
            let spec =
                beebranch_git::CommandSpec::new(beebranch_git::GitSubcommand::Config, worktree)
                    .arg("--get")
                    .arg(key);
            runner
                .run(&spec)
                .ok()
                .filter(|outcome| outcome.success())
                .map(|outcome| outcome.stdout.text_lossy().trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        Ok(CommitIdentity {
            name: read("user.name"),
            email: read("user.email"),
        })
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}
