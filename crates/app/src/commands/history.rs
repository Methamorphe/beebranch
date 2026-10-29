//! Merge, rebase, conflict resolution and abort/continue commands.

use beebranch_core::{AppError, Confirmation, DestructiveAction};
use beebranch_git::history::{self, HistoryOutcome, MergeFastForward};
use beebranch_git::session::InvalidationArea;
use beebranch_git::undo::{self, Fingerprint, RestoreMode, ReversibleAction};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    begin_destructive, begin_operation, finish_destructive, finish_operation, new_operation_id,
    run_mutation, run_undoable_mutation, MutationResult, UndoDraft, UndoMeta,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub repo_id: String,
    pub target: String,
    /// Merge behaviour: `auto` (`--ff`), `only` (`--ff-only`) or `never`
    /// (`--no-ff`).
    #[serde(default)]
    pub fast_forward: MergeFastForward,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseRequest {
    pub repo_id: String,
    pub upstream: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    pub repo_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortRequest {
    pub repo_id: String,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub repo_id: String,
    pub path: String,
}

/// Build the inverse of a merge/rebase/cherry-pick/revert.
///
/// A conflicted start is undone by Git's typed `--abort` (no redo). A
/// completed operation is undone by a verified `reset --hard` to the captured
/// fingerprint, then the index tree.
fn history_builder(
    kind: &'static str,
    label: String,
    outcome: &HistoryOutcome,
    mode: RestoreMode,
) -> crate::commands::util::UndoBuilder {
    let operation = outcome.state.operation.clone();
    Box::new(
        move |before: &Fingerprint, after: &Fingerprint| match operation {
            Some(operation) => UndoDraft {
                kind: kind.to_owned(),
                label,
                undo: ReversibleAction::AbortOperation { operation },
                redo: None,
            },
            None => UndoDraft {
                kind: kind.to_owned(),
                label,
                undo: undo::restore_to(before, mode),
                redo: Some(undo::restore_to(after, mode)),
            },
        },
    )
}

fn history_meta(kind: &'static str, label: String) -> UndoMeta {
    UndoMeta {
        kind,
        label,
        touched_refs: Vec::new(),
        affected_files: Vec::new(),
    }
}

fn history_areas() -> Vec<InvalidationArea> {
    vec![
        InvalidationArea::Refs,
        InvalidationArea::Head,
        InvalidationArea::Index,
        InvalidationArea::Worktree,
        InvalidationArea::State,
    ]
}

#[tauri::command]
pub async fn history_merge(
    state: State<'_, AppState>,
    request: MergeRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let target = request.target.clone();
    run_undoable_mutation(
        session,
        store,
        history_meta("merge", format!("merge de {target}")),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::merge(runner, worktree, &target, request.fast_forward)?;
            let builder = history_builder(
                "merge",
                format!("merge de {target}"),
                &outcome,
                RestoreMode::Hard,
            );
            Ok((outcome, history_areas(), builder))
        },
    )
    .await
}

#[tauri::command]
pub async fn history_rebase(
    state: State<'_, AppState>,
    request: RebaseRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let upstream = request.upstream.clone();
    run_undoable_mutation(
        session,
        store,
        history_meta("rebase", format!("rebase sur {upstream}")),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::rebase(runner, worktree, &upstream)?;
            let builder = history_builder(
                "rebase",
                format!("rebase sur {upstream}"),
                &outcome,
                RestoreMode::Hard,
            );
            Ok((outcome, history_areas(), builder))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetRequest {
    pub repo_id: String,
    pub revision: String,
    pub mode: history::ReversibleResetMode,
}

/// Soft/mixed reset. `--hard` is refused: it is not reversible.
#[tauri::command]
pub async fn history_reset(
    state: State<'_, AppState>,
    request: ResetRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let revision = request.revision.clone();
    let kind = match request.mode {
        history::ReversibleResetMode::Soft => "reset.soft",
        history::ReversibleResetMode::Mixed => "reset.mixed",
    };
    let mode = match request.mode {
        history::ReversibleResetMode::Soft => RestoreMode::Soft,
        history::ReversibleResetMode::Mixed => RestoreMode::Mixed,
    };
    let label = format!("reset {revision}");
    run_undoable_mutation(
        session,
        store,
        history_meta(kind, label.clone()),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::reset(runner, worktree, &revision, request.mode)?;
            let builder = Box::new(move |before: &Fingerprint, after: &Fingerprint| UndoDraft {
                kind: kind.to_owned(),
                label: label.clone(),
                undo: undo::restore_to(before, mode),
                redo: Some(undo::restore_to(after, mode)),
            });
            Ok((outcome, history_areas(), builder))
        },
    )
    .await
}

#[tauri::command]
pub async fn operation_continue(
    state: State<'_, AppState>,
    request: OperationRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let outcome = history::continue_operation(runner, worktree)?;
        Ok((outcome, history_areas()))
    })
    .await
}

#[tauri::command]
pub async fn operation_skip(
    state: State<'_, AppState>,
    request: OperationRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let outcome = history::skip_operation(runner, worktree)?;
        Ok((outcome, history_areas()))
    })
    .await
}

#[tauri::command]
pub async fn operation_abort(
    state: State<'_, AppState>,
    request: AbortRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::AbortOperation, Some("abort"))?;
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("abort");
    begin_destructive(
        &state,
        &operation_id,
        DestructiveAction::AbortOperation.code(),
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let result = run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let outcome = history::abort_operation(runner, worktree)?;
        Ok((outcome, history_areas()))
    })
    .await;
    finish_destructive(
        &state,
        &operation_id,
        "abort d'une opération Git",
        result.as_ref().err(),
    )?;
    result
}

#[tauri::command]
pub async fn conflict_mark_resolved(
    state: State<'_, AppState>,
    request: ResolveRequest,
) -> Result<MutationResult<()>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        history::mark_resolved(runner, worktree, &request.path)?;
        Ok((
            (),
            vec![InvalidationArea::Index, InvalidationArea::Worktree],
        ))
    })
    .await
}

// --- P2: interactive rebase, cherry-pick, revert, conflicts ----------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCandidatesRequest {
    pub repo_id: String,
    pub upstream: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCandidates {
    pub upstream: String,
    pub candidates: Vec<beebranch_git::log::CommitSummary>,
}

#[tauri::command]
pub async fn rebase_candidates(
    state: State<'_, AppState>,
    request: RebaseCandidatesRequest,
) -> Result<RebaseCandidates, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = history::rebase_candidates_detail(
            session.runner(),
            session.worktree(),
            &request.upstream,
        )?;
        Ok(RebaseCandidates {
            upstream: request.upstream,
            candidates,
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRebaseRequest {
    pub repo_id: String,
    pub upstream: String,
    pub steps: Vec<history::RebaseStep>,
}

#[tauri::command]
pub async fn history_rebase_interactive(
    state: State<'_, AppState>,
    request: InteractiveRebaseRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let upstream = request.upstream.clone();
    run_undoable_mutation(
        session,
        store,
        history_meta(
            "rebase.interactive",
            format!("rebase interactif sur {upstream}"),
        ),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::rebase_interactive(runner, worktree, &upstream, &request.steps)?;
            let builder = history_builder(
                "rebase.interactive",
                format!("rebase interactif sur {upstream}"),
                &outcome,
                RestoreMode::Hard,
            );
            Ok((outcome, history_areas(), builder))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceRequest {
    pub repo_id: String,
    pub shas: Vec<String>,
}

#[tauri::command]
pub async fn history_cherry_pick(
    state: State<'_, AppState>,
    request: SequenceRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    if request.shas.len() > 500 {
        return Err(AppError::invalid_input(
            "La sélection dépasse 500 commits.".to_owned(),
        ));
    }
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("cherry-pick");
    begin_operation(
        &state,
        &operation_id,
        "cherry-pick",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let store = state.store.clone();
    let label = format!("cherry-pick de {} commit(s)", request.shas.len());
    let result = run_undoable_mutation(
        session,
        store,
        history_meta("cherry-pick", label.clone()),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::cherry_pick(runner, worktree, &request.shas)?;
            let builder =
                history_builder("cherry-pick", label.clone(), &outcome, RestoreMode::Hard);
            Ok((outcome, history_areas(), builder))
        },
    )
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    result
}

#[tauri::command]
pub async fn history_revert(
    state: State<'_, AppState>,
    request: SequenceRequest,
) -> Result<MutationResult<HistoryOutcome>, AppError> {
    if request.shas.len() > 500 {
        return Err(AppError::invalid_input(
            "La sélection dépasse 500 commits.".to_owned(),
        ));
    }
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("revert");
    begin_operation(
        &state,
        &operation_id,
        "revert",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let store = state.store.clone();
    let label = format!("revert de {} commit(s)", request.shas.len());
    let result = run_undoable_mutation(
        session,
        store,
        history_meta("revert", label.clone()),
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let outcome = history::revert(runner, worktree, &request.shas)?;
            let builder = history_builder("revert", label.clone(), &outcome, RestoreMode::Hard);
            Ok((outcome, history_areas(), builder))
        },
    )
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRequest {
    pub repo_id: String,
    pub path: String,
}

#[tauri::command]
pub async fn conflict_get(
    state: State<'_, AppState>,
    request: ConflictRequest,
) -> Result<beebranch_git::conflict::ConflictView, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        beebranch_git::conflict::read(session.runner(), session.worktree(), &request.path)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSaveRequest {
    pub repo_id: String,
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub allow_markers: bool,
    #[serde(default = "default_mark_resolved")]
    pub mark_resolved: bool,
}

fn default_mark_resolved() -> bool {
    true
}

#[tauri::command]
pub async fn conflict_save(
    state: State<'_, AppState>,
    request: ConflictSaveRequest,
) -> Result<MutationResult<beebranch_git::conflict::ConflictView>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let view = beebranch_git::conflict::save(
            runner,
            worktree,
            &request.path,
            &request.content,
            request.allow_markers,
            request.mark_resolved,
        )?;
        Ok((
            view,
            vec![
                InvalidationArea::Worktree,
                InvalidationArea::Index,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}
