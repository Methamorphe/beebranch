//! Shared mutation plumbing for Tauri commands.

use std::sync::{Arc, Mutex};

use beebranch_core::{AppError, RepoState};
use beebranch_git::session::{InvalidationArea, RepoSession};
use beebranch_git::undo::{self, Fingerprint, ReversibleAction};
use beebranch_git::GitRunner;
use beebranch_git::ProcessEvent;
use beebranch_store::{NewUndoRecord, OperationState, Store};
use serde::Serialize;

use crate::error::store_error;
use crate::state::AppState;

/// Description attached to a reversible mutation and its journal entry.
#[derive(Debug, Clone)]
pub struct UndoMeta {
    pub kind: &'static str,
    pub label: String,
    pub touched_refs: Vec<String>,
    pub affected_files: Vec<String>,
}

/// Payload produced once the mutation succeeded.
#[derive(Debug, Clone)]
pub struct UndoDraft {
    pub kind: String,
    pub label: String,
    pub undo: ReversibleAction,
    pub redo: Option<ReversibleAction>,
}

/// Build an [`UndoDraft`] from the before/after fingerprints.
pub type UndoBuilder = Box<dyn FnOnce(&Fingerprint, &Fingerprint) -> UndoDraft + Send + 'static>;

/// Run a mutation and journal its typed inverse in the same serialized job.
///
/// Fingerprints are captured inside the per-repository mutation queue so no
/// external change can slip between the observation and the mutation.
pub async fn run_undoable_mutation<T, F>(
    session: Arc<RepoSession>,
    store: Arc<Store>,
    meta: UndoMeta,
    job: F,
) -> Result<MutationResult<T>, AppError>
where
    T: Send + 'static,
    F: FnOnce(
            &GitRunner,
            &beebranch_git::discover::RepoDiscovery,
        ) -> Result<(T, Vec<InvalidationArea>, UndoBuilder), AppError>
        + Send
        + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let slot: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));
        let writer = slot.clone();
        let repo_id = session.id().as_str().to_owned();
        let generation = session.mutate(move |runner, discovery| {
            let before =
                undo::capture(runner, discovery, &meta.touched_refs, &meta.affected_files)?;
            let (data, areas, builder) = job(runner, discovery)?;
            let after = undo::capture(runner, discovery, &meta.touched_refs, &meta.affected_files)?;
            let draft = builder(&before, &after);
            let undo_json = serde_json::to_string(&draft.undo)
                .map_err(|error| AppError::internal(format!("sérialisation undo: {error}")))?;
            let redo_json = draft
                .redo
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| AppError::internal(format!("sérialisation redo: {error}")))?;
            let before_json = serde_json::to_string(&before)
                .map_err(|error| AppError::internal(format!("sérialisation empreinte: {error}")))?;
            let after_json = serde_json::to_string(&after)
                .map_err(|error| AppError::internal(format!("sérialisation empreinte: {error}")))?;
            let refs_json = serde_json::to_string(&meta.touched_refs)
                .map_err(|error| AppError::internal(format!("sérialisation refs: {error}")))?;
            store
                .record_undo(NewUndoRecord {
                    repo_id: &repo_id,
                    kind: &draft.kind,
                    label: &draft.label,
                    undo_json: &undo_json,
                    redo_json: redo_json.as_deref(),
                    before_json: &before_json,
                    after_json: &after_json,
                    touched_refs_json: &refs_json,
                })
                .map_err(store_error)?;
            if let Ok(mut slot) = writer.lock() {
                *slot = Some(data);
            }
            Ok(areas)
        })?;
        let data = slot
            .lock()
            .map_err(|_| AppError::internal("verrou de résultat de mutation"))?
            .take()
            .ok_or_else(|| AppError::internal("la mutation n'a pas produit de résultat"))?;
        let state = session.refresh_state()?;
        Ok(MutationResult {
            data,
            generation,
            state,
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

/// Remove a branch record's undo entry when the operation could not happen.
pub fn discard_undo(store: &Store, id: &str) {
    let _ = store.set_undo_state(
        id,
        beebranch_store::UndoState::Evicted,
        None,
        None,
        None,
        None,
    );
}

/// Result of a serialized mutation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult<T> {
    pub data: T,
    pub generation: u64,
    pub state: RepoState,
}

/// Run a mutation on the repository queue, capture its data, refresh the
/// structural state and return the new generation.
pub async fn run_mutation<T, F>(
    session: Arc<RepoSession>,
    job: F,
) -> Result<MutationResult<T>, AppError>
where
    T: Send + 'static,
    F: FnOnce(
            &GitRunner,
            &beebranch_git::discover::RepoDiscovery,
        ) -> Result<(T, Vec<InvalidationArea>), AppError>
        + Send
        + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let slot: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));
        let writer = slot.clone();
        let generation = session.mutate(move |runner, discovery| {
            let (data, areas) = job(runner, discovery)?;
            if let Ok(mut slot) = writer.lock() {
                *slot = Some(data);
            }
            Ok(areas)
        })?;
        let data = slot
            .lock()
            .map_err(|_| AppError::internal("verrou de résultat de mutation"))?
            .take()
            .ok_or_else(|| AppError::internal("la mutation n'a pas produit de résultat"))?;
        let state = session.refresh_state()?;
        Ok(MutationResult {
            data,
            generation,
            state,
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

/// Record a destructive operation before it runs.
pub fn begin_destructive(
    state: &AppState,
    operation_id: &str,
    kind: &str,
    repo_id: &str,
    repo_path: &str,
) -> Result<(), AppError> {
    state
        .store
        .begin_operation(operation_id, kind, Some(repo_id), Some(repo_path))
        .map_err(store_error)
}

/// Finish a destructive operation and keep its consequence in the journal.
pub fn finish_destructive(
    state: &AppState,
    operation_id: &str,
    detail: &str,
    error: Option<&AppError>,
) -> Result<(), AppError> {
    state
        .store
        .set_operation_detail(operation_id, detail)
        .map_err(store_error)?;
    let outcome = match error {
        Some(_error) => OperationState::Failed,
        None => OperationState::Done,
    };
    state
        .store
        .finish_operation(operation_id, outcome, error.map(|error| error.code))
        .map_err(store_error)
}

/// Emit an operation event to the frontend, ignoring serialization failures.
pub fn emit_operation(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit(event, payload);
}

/// Forward one running Git command to the operation console.
///
/// Events carry the repository so a panel only shows its own operation, and
/// hook output (stdout/stderr of the child) is streamed line by line.
pub fn operation_progress(
    app: &tauri::AppHandle,
    operation_id: &str,
    repo_id: &str,
) -> impl FnMut(ProcessEvent) + Send + 'static {
    let app = app.clone();
    let operation_id = operation_id.to_owned();
    let repo_id = repo_id.to_owned();
    move |event| match event {
        ProcessEvent::Started { .. } => {}
        ProcessEvent::Stdout(line) => emit_operation(
            &app,
            "op://progress",
            serde_json::json!({
                "operationId": operation_id,
                "repoId": repo_id,
                "stream": "stdout",
                "line": line
            }),
        ),
        ProcessEvent::Stderr(line) => emit_operation(
            &app,
            "op://progress",
            serde_json::json!({
                "operationId": operation_id,
                "repoId": repo_id,
                "stream": "stderr",
                "line": line
            }),
        ),
        ProcessEvent::Finished {
            exit_code,
            duration,
        } => emit_operation(
            &app,
            "op://progress",
            serde_json::json!({
                "operationId": operation_id,
                "repoId": repo_id,
                "stream": "meta",
                "line": format!("terminé ({exit_code:?}) en {:.1}s", duration.as_secs_f64())
            }),
        ),
    }
}

/// Announce, before Git starts, the hooks it is about to run.
///
/// Git does not report hook transitions: the UI gets the resolved list first,
/// then the hook output through [`operation_progress`].
pub fn announce_hooks(
    app: &tauri::AppHandle,
    operation_id: &str,
    repo_id: &str,
    hooks: &[beebranch_git::hooks::ActiveHook],
) {
    for hook in hooks {
        emit_operation(
            app,
            "op://progress",
            serde_json::json!({
                "operationId": operation_id,
                "repoId": repo_id,
                "stream": "meta",
                "line": format!("hook Git actif : {} ({})", hook.name, hook.path.display())
            }),
        );
    }
}

/// Monotonic-ish operation identifier for the journal.
pub fn new_operation_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{prefix}_{nanos:x}_{counter:x}")
}

/// Journal a long-running operation before it starts.
pub fn begin_operation(
    state: &AppState,
    operation_id: &str,
    kind: &str,
    repo_id: &str,
    repo_path: &str,
) -> Result<(), AppError> {
    state
        .store
        .begin_operation(operation_id, kind, Some(repo_id), Some(repo_path))
        .map_err(store_error)
}

/// Finish a long-running operation with the right terminal state.
pub fn finish_operation(
    state: &AppState,
    operation_id: &str,
    error: Option<&AppError>,
) -> Result<(), AppError> {
    let outcome = match error {
        Some(error) if error.code == "op.cancelled" => OperationState::Cancelled,
        Some(_) => OperationState::Failed,
        None => OperationState::Done,
    };
    state
        .store
        .finish_operation(operation_id, outcome, error.map(|error| error.code))
        .map_err(store_error)
}
