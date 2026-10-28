//! Index commands: fingerprints, staging, unstaging, discard and ignore.

use beebranch_core::{AppError, Confirmation, DestructiveAction};
use beebranch_git::index::{self as patch, Fingerprint, IndexResult, PathSelection};
use beebranch_git::session::InvalidationArea;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::util::{
    begin_destructive, finish_destructive, new_operation_id, run_mutation, MutationResult,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRequest {
    pub repo_id: String,
    pub selections: Vec<PathSelection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRequest {
    pub repo_id: String,
    pub selections: Vec<PathSelection>,
    pub expected: Vec<Fingerprint>,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRequest {
    pub repo_id: String,
    pub pattern: String,
}

#[tauri::command]
pub async fn file_fingerprints(
    state: State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<Vec<Fingerprint>, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || patch::fingerprints(session.worktree(), &paths))
        .await
        .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn index_stage(
    state: State<'_, AppState>,
    request: StageRequest,
) -> Result<MutationResult<IndexResult>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let result = patch::stage(runner, worktree, &request.selections)?;
        Ok((
            result,
            vec![InvalidationArea::Index, InvalidationArea::Worktree],
        ))
    })
    .await
}

#[tauri::command]
pub async fn index_unstage(
    state: State<'_, AppState>,
    request: StageRequest,
) -> Result<MutationResult<IndexResult>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let result = patch::unstage(runner, worktree, &request.selections)?;
        Ok((
            result,
            vec![InvalidationArea::Index, InvalidationArea::Worktree],
        ))
    })
    .await
}

#[tauri::command]
pub async fn index_discard(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DiscardRequest,
) -> Result<MutationResult<IndexResult>, AppError> {
    let action = if request
        .selections
        .iter()
        .any(|selection| !selection.hunks.is_empty())
    {
        DestructiveAction::DiscardHunk
    } else {
        DestructiveAction::DiscardFile
    };
    request.confirmation.verify(action, None)?;

    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("discard");
    let paths: Vec<String> = request
        .selections
        .iter()
        .map(|selection| selection.path.clone())
        .collect();
    let detail = format!(
        "{} · {} fichier(s) · {} hunk(s)",
        action.code(),
        paths.len(),
        request
            .selections
            .iter()
            .map(|selection| selection.hunks.len())
            .sum::<usize>()
    );
    begin_destructive(
        &state,
        &operation_id,
        action.code(),
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;

    let result = run_mutation(session.clone(), {
        let selections = request.selections.clone();
        let expected = request.expected.clone();
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let result = patch::discard(runner, worktree, &selections, &expected)?;
            Ok((result, vec![InvalidationArea::Worktree]))
        }
    })
    .await;

    match &result {
        Ok(_) => {
            finish_destructive(&state, &operation_id, &detail, None)?;
            crate::commands::util::emit_operation(
                &app,
                "destructive://done",
                serde_json::json!({ "operationId": operation_id, "action": action.code(), "detail": detail }),
            );
        }
        Err(error) => {
            finish_destructive(&state, &operation_id, &detail, Some(error))?;
        }
    }
    result
}

#[tauri::command]
pub async fn index_ignore(
    state: State<'_, AppState>,
    request: IgnoreRequest,
) -> Result<MutationResult<String>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |_runner, discovery| {
        let worktree = discovery.worktree()?;
        let pattern = patch::add_ignore_pattern(worktree, &request.pattern)?;
        Ok((pattern, vec![InvalidationArea::Worktree]))
    })
    .await
}
