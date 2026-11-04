//! Read-only pre-operation summary used by the confirmation bar.

use beebranch_core::AppError;
use beebranch_git::preview::{OperationPreview, PreviewOperation};
use serde::Deserialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPreviewRequest {
    pub repo_id: String,
    pub operation: PreviewOperation,
}

/// Commits, files and conflict risk of an operation, without changing anything.
#[tauri::command]
pub async fn operation_preview(
    state: State<'_, AppState>,
    request: OperationPreviewRequest,
) -> Result<OperationPreview, AppError> {
    let session = state.session(&request.repo_id)?;
    let merge_tree = state
        .capability
        .as_ref()
        .map(|capability| capability.features.merge_tree_write)
        .unwrap_or(false);
    let operation = request.operation;
    tauri::async_runtime::spawn_blocking(move || {
        beebranch_git::preview::operation(
            session.runner(),
            session.discovery(),
            &operation,
            merge_tree,
        )
    })
    .await
    .map_err(crate::error::join_error)?
}
