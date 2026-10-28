//! Patch creation, application and export (P2-T14).

use std::path::PathBuf;

use beebranch_core::{AppError, ErrorCategory};
use beebranch_git::patch::{self, PatchApplyReport, PatchReport, PatchSource};
use beebranch_git::session::InvalidationArea;
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{run_mutation, MutationResult};
use crate::error::join_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchCreateRequest {
    pub repo_id: String,
    pub source: PatchSource,
}

#[tauri::command]
pub async fn patch_create(
    state: State<'_, AppState>,
    request: PatchCreateRequest,
) -> Result<PatchReport, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        patch::create(session.runner(), session.worktree(), &request.source)
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyRequest {
    pub repo_id: String,
    pub text: String,
    #[serde(default)]
    pub three_way: bool,
    #[serde(default)]
    pub stage: bool,
}

#[tauri::command]
pub async fn patch_apply(
    state: State<'_, AppState>,
    request: PatchApplyRequest,
) -> Result<MutationResult<PatchApplyReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = patch::apply(
            runner,
            worktree,
            &request.text,
            request.three_way,
            request.stage,
        )?;
        Ok((
            report,
            vec![
                InvalidationArea::Worktree,
                InvalidationArea::Index,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSaveRequest {
    pub path: String,
    pub text: String,
}

/// Export a generated patch outside the repository.
#[tauri::command]
pub async fn patch_save(request: PatchSaveRequest) -> Result<String, AppError> {
    let target = PathBuf::from(&request.path);
    if !target.is_absolute() {
        return Err(AppError::invalid_input(
            "Le chemin d'export doit être absolu.".to_owned(),
        ));
    }
    if request.text.len() > patch::MAX_PATCH_BYTES {
        return Err(AppError::new(
            "patch.too_large",
            ErrorCategory::Input,
            "Le patch dépasse la limite de 16 Mio.",
        ));
    }
    if target.exists() {
        return Err(AppError::new(
            "patch.exists",
            ErrorCategory::Input,
            "Le fichier d'export existe déjà ; choisissez un autre nom.",
        ));
    }
    let text = request.text;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            if !parent.is_dir() {
                return Err(AppError::invalid_input(
                    "Le dossier d'export n'existe pas.".to_owned(),
                ));
            }
        }
        std::fs::write(&target, text.as_bytes()).map_err(|error| {
            AppError::new(
                "patch.write_failed",
                ErrorCategory::Permission,
                "Le patch n'a pas pu être exporté.",
            )
            .with_detail(error.to_string())
        })?;
        Ok(target.display().to_string())
    })
    .await
    .map_err(join_error)?
}
