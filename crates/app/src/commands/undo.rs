//! Undo/redo commands and restoration journaling.
//!
//! Every restoration is serialized in the repository mutation queue. Each
//! step is written to SQLite before it runs, so a crash leaves an explicit
//! `restoreInterrupted` record instead of a silent partial state.

use std::sync::Arc;

use beebranch_core::{AppError, ErrorCategory, RepoState};
use beebranch_git::session::InvalidationArea;
use beebranch_git::undo::{self, Fingerprint, ReversibleAction};
use beebranch_store::{Store, UndoRecord, UndoState};
use serde::Serialize;
use tauri::State;

use crate::error::store_error;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntryDto {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub state: String,
    pub step: Option<String>,
    pub command: Option<String>,
    pub detail: Option<String>,
    pub recovery_sha: Option<String>,
    pub created_at: i64,
    pub position: i64,
    /// Label shown by the undo button.
    pub undo_label: Option<String>,
    /// Label shown by the redo button.
    pub redo_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoStatusDto {
    pub undo: Option<UndoEntryDto>,
    pub redo: Option<UndoEntryDto>,
    pub failed: Vec<UndoEntryDto>,
    pub recent: Vec<UndoEntryDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcomeDto {
    pub record: UndoEntryDto,
    pub generation: u64,
    pub state: RepoState,
    pub message: String,
}

fn entry(record: &UndoRecord, direction: Option<&str>) -> UndoEntryDto {
    let undo_label =
        (record.state == UndoState::Available).then(|| format!("Annuler {}.", record.label));
    let redo_label =
        (record.state == UndoState::Consumed).then(|| format!("Rétablir {}.", record.label));
    UndoEntryDto {
        id: record.id.clone(),
        kind: record.kind.clone(),
        label: record.label.clone(),
        state: record.state.as_str().to_owned(),
        step: record.step.clone(),
        command: record.command.clone(),
        detail: record.detail.clone(),
        recovery_sha: record.recovery_sha.clone(),
        created_at: record.created_at,
        position: record.position,
        undo_label: if direction == Some("undo") {
            undo_label
        } else {
            None
        },
        redo_label: if direction == Some("redo") {
            redo_label
        } else {
            None
        },
    }
}

fn plain(record: &UndoRecord) -> UndoEntryDto {
    let mut value = entry(record, None);
    value.undo_label =
        (record.state == UndoState::Available).then(|| format!("Annuler {}.", record.label));
    value.redo_label =
        (record.state == UndoState::Consumed).then(|| format!("Rétablir {}.", record.label));
    value
}

#[tauri::command]
pub async fn undo_status(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<UndoStatusDto, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let undo_record = store
            .latest_undo(&repo_id, UndoState::Available)
            .map_err(store_error)?;
        let redo_record = store
            .latest_undo(&repo_id, UndoState::Consumed)
            .map_err(store_error)?;
        let recent = store.list_undo(&repo_id, 20).map_err(store_error)?;
        let failed = store
            .list_failed_undo(100)
            .map_err(store_error)?
            .into_iter()
            .filter(|record| record.repo_id == repo_id)
            .map(|record| plain(&record))
            .collect();
        Ok(UndoStatusDto {
            undo: undo_record
                .as_ref()
                .map(|record| entry(record, Some("undo"))),
            redo: redo_record
                .as_ref()
                .map(|record| entry(record, Some("redo"))),
            failed,
            recent: recent.iter().map(plain).collect(),
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn undo_list(
    state: State<'_, AppState>,
    repo_id: String,
    limit: Option<u32>,
) -> Result<Vec<UndoEntryDto>, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store
            .list_undo(&repo_id, limit.unwrap_or(50))
            .map_err(store_error)?
            .iter()
            .map(plain)
            .collect())
    })
    .await
    .map_err(crate::error::join_error)?
}

/// Failed and crash-interrupted restorations across repositories.
#[tauri::command]
pub async fn undo_failed(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<UndoEntryDto>, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store
            .list_failed_undo(limit.unwrap_or(50))
            .map_err(store_error)?
            .iter()
            .map(plain)
            .collect())
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn undo_acknowledge(state: State<'_, AppState>, id: String) -> Result<bool, AppError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .set_undo_state(&id, UndoState::Evicted, None, None, None, None)
            .map_err(store_error)?;
        Ok(true)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn undo_apply(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<UndoOutcomeDto, AppError> {
    undo_now(&state, &repo_id).await
}

#[tauri::command]
pub async fn redo_apply(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<UndoOutcomeDto, AppError> {
    redo_now(&state, &repo_id).await
}

/// Undo the latest available operation. Public for integration tests and the
/// shell; IPC calls [`undo_apply`].
pub async fn undo_now(state: &AppState, repo_id: &str) -> Result<UndoOutcomeDto, AppError> {
    apply(state, repo_id, Direction::Undo).await
}

/// Redo the latest consumed operation.
pub async fn redo_now(state: &AppState, repo_id: &str) -> Result<UndoOutcomeDto, AppError> {
    apply(state, repo_id, Direction::Redo).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Undo,
    Redo,
}

async fn apply(
    state: &AppState,
    repo_id: &str,
    direction: Direction,
) -> Result<UndoOutcomeDto, AppError> {
    let session = state.session(repo_id)?;
    let store = state.store.clone();
    let repo_id = repo_id.to_owned();
    let selected = match direction {
        Direction::Undo => store
            .latest_undo(&repo_id, UndoState::Available)
            .map_err(store_error)?
            .ok_or_else(|| {
                AppError::new(
                    "undo.empty",
                    ErrorCategory::Input,
                    "Aucune opération annulable.",
                )
            })?,
        Direction::Redo => store
            .latest_undo(&repo_id, UndoState::Consumed)
            .map_err(store_error)?
            .ok_or_else(|| {
                AppError::new(
                    "redo.empty",
                    ErrorCategory::Input,
                    "Aucune opération à rétablir.",
                )
            })?,
    };
    let action_json = match direction {
        Direction::Undo => selected.undo_json.clone(),
        Direction::Redo => selected.redo_json.clone().ok_or_else(|| {
            AppError::new(
                "redo.unsupported",
                ErrorCategory::Input,
                "Cette opération n'est pas rétablissable.",
            )
        })?,
    };
    let action: ReversibleAction = serde_json::from_str(&action_json)
        .map_err(|error| AppError::internal(format!("action undo illisible: {error}")))?;
    let before: Fingerprint = serde_json::from_str(&selected.before_json)
        .map_err(|error| AppError::internal(format!("empreinte before illisible: {error}")))?;
    let after: Fingerprint = serde_json::from_str(&selected.after_json)
        .map_err(|error| AppError::internal(format!("empreinte after illisible: {error}")))?;
    let touched: Vec<String> =
        serde_json::from_str(&selected.touched_refs_json).unwrap_or_default();
    let affected: Vec<String> = before
        .affected_files
        .keys()
        .cloned()
        .chain(after.affected_files.keys().cloned())
        .collect();

    let (expected, target) = match direction {
        Direction::Undo => (after, before),
        Direction::Redo => (before, after),
    };
    let next_state = match direction {
        Direction::Undo => UndoState::Consumed,
        Direction::Redo => UndoState::Available,
    };
    let record_id = selected.id.clone();
    let label = selected.label.clone();
    let touched_for_job = touched.clone();
    let affected_for_job = affected.clone();

    let outcome = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        let store: Arc<Store> = store.clone();
        move || {
            let generation = session.mutate(move |runner, discovery| {
                undo::ensure_restorable(runner, discovery, &action)?;
                let current =
                    undo::capture(runner, discovery, &touched_for_job, &affected_for_job)?;
                Fingerprint::compare(&expected, &current).map_err(|reason| {
                    AppError::new(
                        "undo.precondition",
                        ErrorCategory::GitState,
                        "Le dépôt a changé depuis cette opération.",
                    )
                    .with_detail(reason)
                    .with_remediation("Aucune modification n'a été appliquée.")
                })?;
                store
                    .set_undo_state(
                        &record_id,
                        UndoState::Restoring,
                        None,
                        None,
                        None,
                        None,
                    )
                    .map_err(store_error)?;

                let journal = record_id.clone();
                let mut on_step = |step: &undo::RestoreStep| {
                    store
                        .set_undo_state(
                            &journal,
                            UndoState::Restoring,
                            Some(&step.step),
                            Some(&step.command),
                            None,
                            step.sha.as_deref(),
                        )
                        .map_err(store_error)
                };
                match undo::apply(runner, discovery, &action, &mut on_step) {
                    Ok(()) => {
                        let fresh = undo::capture(
                            runner,
                            discovery,
                            &touched_for_job,
                            &affected_for_job,
                        )?;
                        if let Err(reason) = Fingerprint::compare(&target, &fresh) {
                            store
                                .set_undo_state(
                                    &record_id,
                                    UndoState::RestoreFailed,
                                    Some("verify"),
                                    None,
                                    Some(&format!(
                                        "L'état restauré ne correspond pas à l'empreinte : {reason}"
                                    )),
                                    target.head_sha.as_deref(),
                                )
                                .map_err(store_error)?;
                            return Err(AppError::new(
                                "undo.verify_failed",
                                ErrorCategory::GitState,
                                "L'état restauré ne correspond pas à l'état attendu.",
                            )
                            .with_detail(reason)
                            .with_remediation(
                                "Inspectez `git reflog` ; aucune restauration automatique ne sera tentée.",
                            ));
                        }
                        store
                            .set_undo_state(
                                &record_id,
                                next_state,
                                None,
                                None,
                                None,
                                None,
                            )
                            .map_err(store_error)?;
                        Ok(InvalidationArea::ALL.to_vec())
                    }
                    Err(failure) => {
                        let failed = failure.clone();
                        store
                            .set_undo_state(
                                &record_id,
                                UndoState::RestoreFailed,
                                Some(&failed.step),
                                Some(&failed.command),
                                Some(&failed.detail),
                                failed.sha.as_deref(),
                            )
                            .map_err(store_error)?;
                        Err(failure.into_error())
                    }
                }
            })?;
            let state = session.refresh_state()?;
            Ok::<_, AppError>((generation, state))
        }
    })
    .await
    .map_err(crate::error::join_error)??;

    let record = store
        .undo_record(&selected.id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::internal("enregistrement undo introuvable"))?;
    Ok(UndoOutcomeDto {
        record: plain(&record),
        generation: outcome.0,
        state: outcome.1,
        message: match direction {
            Direction::Undo => format!("Annulé : {label}."),
            Direction::Redo => format!("Rétabli : {label}."),
        },
    })
}
