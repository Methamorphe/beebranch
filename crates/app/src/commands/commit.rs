//! Commit and amend commands.

use beebranch_core::AppError;
use beebranch_git::commit::{self, CommitConfigView, CommitOptions, CommitOutcome};
use beebranch_git::session::InvalidationArea;
use beebranch_git::undo::{self, RestoreMode};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    announce_hooks, begin_operation, finish_operation, new_operation_id, operation_progress,
    run_undoable_mutation, MutationResult, UndoDraft, UndoMeta,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub repo_id: String,
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub keep_message: bool,
    #[serde(default)]
    pub allow_empty: bool,
    /// Skip every commit hook for this commit only.
    #[serde(default)]
    pub skip_hooks: bool,
}

#[tauri::command]
pub async fn commit_config(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<CommitConfigView, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit::read_commit_config(session.runner(), session.worktree())
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn commit_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: CommitRequest,
) -> Result<MutationResult<CommitOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id(if request.amend { "amend" } else { "commit" });
    begin_operation(
        &state,
        &operation_id,
        if request.amend { "amend" } else { "commit" },
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let hooks_path = state
        .store
        .preference("git.hooksPath")
        .ok()
        .flatten()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let sign = state
        .store
        .preference("git.signCommits")
        .ok()
        .flatten()
        .and_then(|value| match value.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        });
    let signing_key = state
        .store
        .preference("git.signingKey")
        .ok()
        .flatten()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let signing_format = state
        .store
        .preference("git.signingFormat")
        .ok()
        .flatten()
        .filter(|value| matches!(value.as_str(), "openpgp" | "ssh" | "x509"));
    let options = CommitOptions {
        message: request.message,
        amend: request.amend,
        keep_message: request.keep_message,
        allow_empty: request.allow_empty,
        skip_hooks: request.skip_hooks,
        sign,
        hooks_path,
        signing_key,
        signing_format,
    };
    let amend = options.amend;
    let store = state.store.clone();
    let progress_operation = operation_id.clone();
    let progress_repo = request.repo_id.clone();
    let result = run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: if amend { "commit.amend" } else { "commit" },
            label: if amend {
                "amend du commit".to_owned()
            } else {
                "commit".to_owned()
            },
            touched_refs: Vec::new(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            // Informational only: failing to list hooks must not block the
            // commit, Git runs them anyway.
            let hooks = beebranch_git::hooks::active(
                runner,
                worktree,
                beebranch_git::hooks::HookPoint::Commit,
            )
            .unwrap_or_default();
            announce_hooks(&app, &progress_operation, &progress_repo, &hooks);
            let outcome = commit::create_streaming(
                runner,
                worktree,
                &options,
                operation_progress(&app, &progress_operation, &progress_repo),
            )?;
            let short = outcome.sha.chars().take(10).collect::<String>();
            let label = if amend {
                format!("amend du commit {short}")
            } else {
                format!("commit {short}")
            };
            let builder = Box::new(
                move |before: &beebranch_git::undo::Fingerprint,
                      after: &beebranch_git::undo::Fingerprint| {
                    UndoDraft {
                        kind: if amend { "commit.amend" } else { "commit" }.to_owned(),
                        label,
                        undo: undo::restore_to(before, RestoreMode::Soft),
                        redo: Some(undo::restore_to(after, RestoreMode::Soft)),
                    }
                },
            );
            Ok((
                outcome,
                vec![
                    InvalidationArea::Head,
                    InvalidationArea::Refs,
                    InvalidationArea::Index,
                    InvalidationArea::Worktree,
                    InvalidationArea::State,
                ],
                builder,
            ))
        },
    )
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    result
}
