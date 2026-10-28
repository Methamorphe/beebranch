use std::path::Path;

use beebranch_core::{AppError, RepoState};
use beebranch_git::discover::discover;
use beebranch_git::state::detect;
use beebranch_store::{OperationRecord, OperationState};
use serde::Serialize;
use tauri::State;

use crate::error::{json_error, store_error};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryItem {
    pub operation: OperationRecord,
    pub repo_available: bool,
    pub state: Option<RepoState>,
    pub locks: Vec<String>,
    pub remediation: String,
}

/// List interrupted operations and re-validate each repository state.
///
/// Locks are reported, never removed. No Git command is executed beyond
/// read-only state detection.
pub fn collect(state: &AppState) -> Result<Vec<RecoveryItem>, AppError> {
    let operations = state
        .store
        .list_operations(200)
        .map_err(store_error)?
        .into_iter()
        .filter(|operation| operation.state == OperationState::Interrupted)
        .collect::<Vec<_>>();

    let mut items = Vec::with_capacity(operations.len());
    for operation in operations {
        let mut item = RecoveryItem {
            remediation: remediation_for(&operation),
            repo_available: false,
            state: None,
            locks: Vec::new(),
            operation,
        };

        if let Some(path) = item.operation.repo_path.clone() {
            if Path::new(&path).exists() {
                item.repo_available = true;
                if let Ok(runner) = state.runner() {
                    if let Ok(discovery) = discover(runner, &path) {
                        match detect(runner, &discovery, Some(20_000)) {
                            Ok(detected) => {
                                item.state = Some(detected.state);
                                item.locks = detected
                                    .locks
                                    .iter()
                                    .map(|lock| lock.display().to_string())
                                    .collect();
                            }
                            Err(error) => {
                                item.remediation = format!(
                                    "{} État illisible : {}",
                                    item.remediation, error.message
                                );
                            }
                        }
                    }
                }
            } else {
                item.remediation =
                    "Le dossier du dépôt n'existe plus ; vérifiez son emplacement.".to_owned();
            }
        }

        items.push(item);
    }
    Ok(items)
}

#[tauri::command]
pub fn recovery_list(state: State<'_, AppState>) -> Result<Vec<RecoveryItem>, AppError> {
    collect(&state)
}

fn remediation_for(operation: &OperationRecord) -> String {
    match operation.kind.as_str() {
        "fetch" | "push" | "pull" => {
            "Vérifiez l'état local et distant (les refs ont pu changer), puis relancez.".to_owned()
        }
        "commit" | "amend" => {
            "Vérifiez l'index et les derniers commits ; aucun fichier n'a été supprimé.".to_owned()
        }
        "merge" | "rebase" | "cherry-pick" | "revert" => {
            "Utilisez `git merge/rebase/cherry-pick --continue` ou `--abort` après vérification."
                .to_owned()
        }
        "clone" => {
            "Un répertoire partiel peut subsister ; vérifiez-le avant de recommencer.".to_owned()
        }
        _ => "Revalidez l'état du dépôt avant de poursuivre.".to_owned(),
    }
}

/// Redacted diagnostic export: no token, no credential URL, no command line.
pub fn diagnostics(state: &AppState) -> Result<String, AppError> {
    let sessions = state
        .sessions
        .list()
        .iter()
        .map(|session| {
            serde_json::json!({
                "repoId": session.id().as_str(),
                "worktree": session.worktree().display().to_string(),
                "generation": session.generation(),
                "locks": session.locks().iter().map(|lock| lock.display().to_string()).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();

    let operations = state
        .store
        .list_operations(50)
        .map_err(store_error)?
        .into_iter()
        .map(|operation| {
            serde_json::json!({
                "id": operation.id,
                "kind": operation.kind,
                "state": operation.state,
                "repoPath": operation.repo_path,
                "startedAt": operation.started_at,
                "updatedAt": operation.updated_at,
                "finishedAt": operation.finished_at,
                "errorCode": operation.error_code,
                "detail": operation.detail,
            })
        })
        .collect::<Vec<_>>();

    let payload = serde_json::json!({
        "app": {
            "name": beebranch_core::APP_NAME,
            "version": beebranch_core::APP_VERSION,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "git": state.capability.as_ref().map(|capability| serde_json::json!({
            "version": capability.version.to_string(),
            "lfs": capability.lfs.as_ref().map(|lfs| lfs.version.clone()),
        })),
        "gitlab": state.gitlab_instance.lock().ok().and_then(|instance| {
            instance.as_ref().map(|instance| serde_json::json!({
                "id": instance.id,
                "baseUrl": instance.base_url,
                "displayName": instance.display_name,
            }))
        }),
        "sessions": sessions,
        "operations": operations,
    });

    serde_json::to_string_pretty(&payload).map_err(json_error)
}

#[tauri::command]
pub fn diagnostics_export(state: State<'_, AppState>) -> Result<String, AppError> {
    diagnostics(&state)
}

/// Journal of recent operations, including destructive actions and their
/// consequences. Bounded and read-only.
#[tauri::command]
pub fn operation_journal(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<OperationRecord>, AppError> {
    state
        .store
        .list_operations(limit.unwrap_or(100))
        .map_err(store_error)
}
