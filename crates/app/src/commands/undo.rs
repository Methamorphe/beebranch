//! Undo/redo commands and restoration journaling.
//!
//! Every restoration is serialized in the repository mutation queue: the
//! record is selected, checked and applied inside the same job, so two quick
//! undos cannot pick the same record. Each step is written to SQLite before it
//! runs, so a crash leaves an explicit `restoreInterrupted` record instead of a
//! silent partial state.

use std::sync::{Arc, Mutex};

use beebranch_core::{AppError, ErrorCategory, RepoState};
use beebranch_git::session::{InvalidationArea, RepoSession};
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
    /// Why the entry cannot run right now (`undo_status` only): the same
    /// error the undo/redo would return, evaluated without side effects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<AppError>,
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
        blocked: None,
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
    status_now(&state, &repo_id).await
}

/// Evaluate the preconditions of `record` without touching the repository.
///
/// This runs outside the mutation queue, so it never writes: the index tree is
/// not recomputed (`git write-tree` locks the index) and the status comparison
/// alone stands for it. A stale answer is harmless: the undo itself checks
/// everything again inside the queue.
fn blocked(session: &RepoSession, record: &UndoRecord, direction: Direction) -> Option<AppError> {
    let plan = match Plan::parse(record, direction) {
        Ok(plan) => plan,
        Err(error) => return Some(error),
    };
    let runner = session.runner();
    let discovery = session.discovery();
    undo::ensure_restorable(runner, discovery, &plan.action)
        .and_then(|()| undo::preview_preconditions(runner, discovery, &plan.action, &plan.expected))
        .err()
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
    expected_id: Option<String>,
) -> Result<UndoOutcomeDto, AppError> {
    apply(&state, &repo_id, Direction::Undo, expected_id).await
}

#[tauri::command]
pub async fn redo_apply(
    state: State<'_, AppState>,
    repo_id: String,
    expected_id: Option<String>,
) -> Result<UndoOutcomeDto, AppError> {
    apply(&state, &repo_id, Direction::Redo, expected_id).await
}

/// Undo the latest available operation. Public for integration tests and the
/// shell; IPC calls [`undo_apply`].
pub async fn undo_now(state: &AppState, repo_id: &str) -> Result<UndoOutcomeDto, AppError> {
    apply(state, repo_id, Direction::Undo, None).await
}

/// Undo `id` only if it is still the latest available operation (the
/// "Undo commit" button of the commit panel targets its own record).
pub async fn undo_exact(
    state: &AppState,
    repo_id: &str,
    id: &str,
) -> Result<UndoOutcomeDto, AppError> {
    apply(state, repo_id, Direction::Undo, Some(id.to_owned())).await
}

/// Redo the most recently undone operation.
pub async fn redo_now(state: &AppState, repo_id: &str) -> Result<UndoOutcomeDto, AppError> {
    apply(state, repo_id, Direction::Redo, None).await
}

/// Journal status with the applicability of the next undo and redo. Public
/// for integration tests; IPC calls [`undo_status`].
pub async fn status_now(state: &AppState, repo_id: &str) -> Result<UndoStatusDto, AppError> {
    let store = state.store.clone();
    // A closed repository still lists its journal, without applicability.
    let session = state.session(repo_id).ok();
    let repo_id = repo_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let undo_record = store
            .latest_undo(&repo_id, UndoState::Available)
            .map_err(store_error)?;
        let redo_record = store.next_redo(&repo_id).map_err(store_error)?;
        let recent = store.list_undo(&repo_id, 20).map_err(store_error)?;
        let failed = store
            .list_failed_undo(100)
            .map_err(store_error)?
            .into_iter()
            .filter(|record| record.repo_id == repo_id)
            .map(|record| plain(&record))
            .collect();
        let describe = |record: &UndoRecord, direction: Direction| {
            let mut value = entry(record, Some(direction.as_str()));
            if let Some(session) = &session {
                value.blocked = blocked(session, record, direction);
            }
            value
        };
        Ok(UndoStatusDto {
            undo: undo_record
                .as_ref()
                .map(|record| describe(record, Direction::Undo)),
            redo: redo_record
                .as_ref()
                .map(|record| describe(record, Direction::Redo)),
            failed,
            recent: recent.iter().map(plain).collect(),
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Undo,
    Redo,
}

impl Direction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Undo => "undo",
            Self::Redo => "redo",
        }
    }
}

/// Inverse to run for a record, and the states around it.
struct Plan {
    action: ReversibleAction,
    /// State the repository must still be in.
    expected: Fingerprint,
    /// State the inverse must produce.
    target: Fingerprint,
}

impl Plan {
    fn parse(record: &UndoRecord, direction: Direction) -> Result<Self, AppError> {
        let action_json = match direction {
            Direction::Undo => record.undo_json.clone(),
            Direction::Redo => record.redo_json.clone().ok_or_else(|| {
                AppError::new(
                    "redo.unsupported",
                    ErrorCategory::Input,
                    "Cette opération n'est pas rétablissable.",
                )
            })?,
        };
        let action: ReversibleAction = serde_json::from_str(&action_json)
            .map_err(|error| AppError::internal(format!("action undo illisible: {error}")))?;
        let before: Fingerprint = serde_json::from_str(&record.before_json)
            .map_err(|error| AppError::internal(format!("empreinte before illisible: {error}")))?;
        let after: Fingerprint = serde_json::from_str(&record.after_json)
            .map_err(|error| AppError::internal(format!("empreinte after illisible: {error}")))?;
        let (expected, target) = match direction {
            Direction::Undo => (after, before),
            Direction::Redo => (before, after),
        };
        Ok(Self {
            action,
            expected,
            target,
        })
    }
}

/// Record the next undo or redo applies to.
fn select(store: &Store, repo_id: &str, direction: Direction) -> Result<UndoRecord, AppError> {
    match direction {
        Direction::Undo => store
            .latest_undo(repo_id, UndoState::Available)
            .map_err(store_error)?
            .ok_or_else(|| {
                AppError::new(
                    "undo.empty",
                    ErrorCategory::Input,
                    "Aucune opération annulable.",
                )
            }),
        Direction::Redo => store
            .next_redo(repo_id)
            .map_err(store_error)?
            .ok_or_else(|| {
                AppError::new(
                    "redo.empty",
                    ErrorCategory::Input,
                    "Aucune opération à rétablir.",
                )
            }),
    }
}

async fn apply(
    state: &AppState,
    repo_id: &str,
    direction: Direction,
    expected_id: Option<String>,
) -> Result<UndoOutcomeDto, AppError> {
    let session = state.session(repo_id)?;
    let store = state.store.clone();
    let repo_id = repo_id.to_owned();
    let next_state = match direction {
        Direction::Undo => UndoState::Consumed,
        Direction::Redo => UndoState::Available,
    };
    let chosen: Arc<Mutex<Option<UndoRecord>>> = Arc::new(Mutex::new(None));

    let outcome = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        let store: Arc<Store> = store.clone();
        let chosen = chosen.clone();
        move || {
            let generation = session.mutate(move |runner, discovery| {
                // Selected inside the queue: a second undo queued behind this
                // one sees the state this one leaves.
                let selected = select(&store, &repo_id, direction)?;
                if let Some(expected_id) = expected_id.as_deref() {
                    if expected_id != selected.id {
                        return Err(AppError::new(
                            "undo.stale",
                            ErrorCategory::Input,
                            "Cette opération n'est plus la dernière de la pile.",
                        )
                        .with_detail(format!("attendu {expected_id}, actuel {}", selected.id))
                        .with_remediation("Aucune modification n'a été appliquée."));
                    }
                }
                if let Ok(mut slot) = chosen.lock() {
                    *slot = Some(selected.clone());
                }
                let plan = Plan::parse(&selected, direction)?;
                undo::ensure_restorable(runner, discovery, &plan.action)?;
                undo::check_preconditions(runner, discovery, &plan.action, &plan.expected)?;
                let record_id = selected.id.clone();
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
                match undo::apply(runner, discovery, &plan.action, &mut on_step) {
                    Ok(()) => {
                        if let Err(error) =
                            undo::verify_restored(runner, discovery, &plan.action, &plan.target)
                        {
                            let reason = error.detail.clone().unwrap_or_default();
                            store
                                .set_undo_state(
                                    &record_id,
                                    UndoState::RestoreFailed,
                                    Some("verify"),
                                    None,
                                    Some(&format!(
                                        "L'état restauré ne correspond pas à l'empreinte : {reason}"
                                    )),
                                    plan.target.head_sha.as_deref(),
                                )
                                .map_err(store_error)?;
                            return Err(error.with_remediation(
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

    let selected = chosen
        .lock()
        .map_err(|_| AppError::internal("verrou de sélection undo"))?
        .take()
        .ok_or_else(|| AppError::internal("enregistrement undo introuvable"))?;
    let record = store
        .undo_record(&selected.id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::internal("enregistrement undo introuvable"))?;
    Ok(UndoOutcomeDto {
        record: plain(&record),
        generation: outcome.0,
        state: outcome.1,
        message: match direction {
            Direction::Undo => format!("Annulé : {}.", selected.label),
            Direction::Redo => format!("Rétabli : {}.", selected.label),
        },
    })
}
