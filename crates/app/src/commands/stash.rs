//! Stash commands.

use beebranch_core::{AppError, Confirmation, DestructiveAction};
use beebranch_git::session::InvalidationArea;
use beebranch_git::stash::{self, StashEntry, StashOutcome};
use beebranch_git::undo::{Fingerprint, ReversibleAction};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    begin_destructive, finish_destructive, new_operation_id, run_mutation, run_undoable_mutation,
    MutationResult, UndoDraft, UndoMeta,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStashRequest {
    pub repo_id: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub include_untracked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRefRequest {
    pub repo_id: String,
    pub selector: String,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[tauri::command]
pub async fn stash_list(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<StashEntry>, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || stash::list(session.runner(), session.worktree()))
        .await
        .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn stash_create(
    state: State<'_, AppState>,
    request: CreateStashRequest,
) -> Result<MutationResult<String>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let message = if request.message.trim().is_empty() {
        "WIP".to_owned()
    } else {
        request.message.trim().to_owned()
    };
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "stash.create",
            label: format!("stash « {message} »"),
            touched_refs: vec!["refs/stash".to_owned()],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let message = if request.message.trim().is_empty() {
                let status = beebranch_git::status::read_status(runner, worktree, Some(0))?;
                let branch = status.branch.head.as_deref().unwrap_or("HEAD");
                format!("WIP \"{branch}\"")
            } else {
                message
            };
            let output = stash::create(runner, worktree, &message, request.include_untracked)?;
            let entry = stash::list(runner, worktree)?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::internal("le stash créé est introuvable dans la liste"))?;
            let label = format!("stash « {message} »");
            let builder = Box::new(
                move |before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "stash.create".to_owned(),
                    label,
                    undo: ReversibleAction::ApplyStash {
                        selector: entry.selector,
                        expected_sha: entry.sha,
                        drop: true,
                        expected_status_hash: Some(before.status_hash.clone()),
                    },
                    redo: None,
                },
            );
            Ok((
                output,
                vec![
                    InvalidationArea::Refs,
                    InvalidationArea::Index,
                    InvalidationArea::Worktree,
                ],
                builder,
            ))
        },
    )
    .await
}

#[tauri::command]
pub async fn stash_apply(
    state: State<'_, AppState>,
    request: StashRefRequest,
) -> Result<MutationResult<StashOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let outcome = stash::apply(runner, worktree, &request.selector)?;
        Ok((
            outcome,
            vec![
                InvalidationArea::Index,
                InvalidationArea::Worktree,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}

#[tauri::command]
pub async fn stash_pop(
    state: State<'_, AppState>,
    request: StashRefRequest,
) -> Result<MutationResult<StashOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let outcome = stash::pop(runner, worktree, &request.selector)?;
        Ok((
            outcome,
            vec![
                InvalidationArea::Refs,
                InvalidationArea::Index,
                InvalidationArea::Worktree,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}

#[tauri::command]
pub async fn stash_drop(
    state: State<'_, AppState>,
    request: StashRefRequest,
) -> Result<MutationResult<String>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::StashDrop, None)?;
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("stash-drop");
    begin_destructive(
        &state,
        &operation_id,
        DestructiveAction::StashDrop.code(),
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let selector = request.selector.clone();
    let result = run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let sha = stash::drop(runner, worktree, &selector)?;
        Ok((sha, vec![InvalidationArea::Refs]))
    })
    .await;
    let detail = match &result {
        Ok(result) => format!("{} · sha récupérable={}", request.selector, result.data),
        Err(_) => format!("{} · échec", request.selector),
    };
    finish_destructive(&state, &operation_id, &detail, result.as_ref().err())?;
    result
}
