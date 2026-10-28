//! Branch lifecycle commands.

use beebranch_core::{AppError, Confirmation, DestructiveAction};
use beebranch_git::branches::{self, BranchComparison, BranchPreflight};
use beebranch_git::integration::{self, BranchIntegrationPreview, IntegrationMode};
use beebranch_git::session::InvalidationArea;
use beebranch_git::undo::{self, Fingerprint, RestoreMode, ReversibleAction};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    begin_destructive, finish_destructive, new_operation_id, run_mutation, run_undoable_mutation,
    MutationResult, UndoDraft, UndoMeta,
};
use crate::state::AppState;

fn checkout_inverse(fingerprint: &Fingerprint) -> ReversibleAction {
    ReversibleAction::Checkout {
        target: undo::head_target(fingerprint),
    }
}

fn sequence(mut actions: Vec<ReversibleAction>) -> ReversibleAction {
    if actions.len() == 1 {
        actions.remove(0)
    } else {
        ReversibleAction::Sequence { actions }
    }
}

fn ref_sha(fingerprint: &Fingerprint, reference: &str) -> Option<String> {
    fingerprint
        .refs
        .get(reference)
        .filter(|value| *value != "absent")
        .cloned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchRequest {
    pub repo_id: String,
    pub name: String,
    pub start: Option<String>,
    #[serde(default)]
    pub checkout: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPreviewRequest {
    pub repo_id: String,
    pub source: String,
    pub target: String,
    pub mode: IntegrationMode,
}

/// Read-only preview of a branch drop. No mutation, no checkout.
#[tauri::command]
pub async fn branch_integration_preview(
    state: State<'_, AppState>,
    request: IntegrationPreviewRequest,
) -> Result<BranchIntegrationPreview, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        integration::preview(
            session.runner(),
            session.worktree(),
            &request.source,
            &request.target,
            request.mode,
        )
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStartRequest {
    pub repo_id: String,
    pub source: String,
    pub target: String,
    pub mode: IntegrationMode,
    #[serde(default)]
    pub confirmation: Confirmation,
}

/// Start a branch drop: check out the target, then merge or rebase.
#[tauri::command]
pub async fn branch_integration_start(
    state: State<'_, AppState>,
    request: IntegrationStartRequest,
) -> Result<MutationResult<beebranch_git::integration::BranchIntegrationOutcome>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::BranchIntegrate, None)?;
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let target_ref = format!("refs/heads/{}", request.target);
    let label = match request.mode {
        IntegrationMode::Merge => format!("merge de {} dans {}", request.source, request.target),
        IntegrationMode::Rebase => format!("rebase de {} sur {}", request.target, request.source),
    };
    let source = request.source.clone();
    let target = request.target.clone();
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "branch.integrate",
            label: label.clone(),
            touched_refs: vec![target_ref],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let result = integration::start(runner, worktree, &source, &target, request.mode)?;
            let builder_label = label.clone();
            let target = target.clone();
            let operation = result.outcome.state.operation.clone();
            let builder = Box::new(move |before: &Fingerprint, after: &Fingerprint| {
                let undo = match operation.clone() {
                    Some(operation) => {
                        let mut actions = vec![ReversibleAction::AbortOperation { operation }];
                        if before.head_branch.as_deref() != Some(target.as_str()) {
                            actions.push(checkout_inverse(before));
                        }
                        sequence(actions)
                    }
                    None => undo::restore_to(before, RestoreMode::Hard),
                };
                let redo = match operation {
                    Some(_) => None,
                    None => Some(undo::restore_to(after, RestoreMode::Hard)),
                };
                UndoDraft {
                    kind: "branch.integrate".to_owned(),
                    label: builder_label.clone(),
                    undo,
                    redo,
                }
            });
            Ok((
                result,
                vec![
                    InvalidationArea::Refs,
                    InvalidationArea::Head,
                    InvalidationArea::Index,
                    InvalidationArea::Worktree,
                    InvalidationArea::State,
                ],
                builder,
            ))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    pub repo_id: String,
    pub name: Option<String>,
    pub detached_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchRequest {
    pub repo_id: String,
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    pub repo_id: String,
    pub name: String,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteBranchRequest {
    pub repo_id: String,
    pub remote: String,
    pub branch: String,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRequest {
    pub repo_id: String,
    pub branch: String,
    pub upstream: Option<String>,
}

#[tauri::command]
pub async fn branch_preflight(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<BranchPreflight, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        branches::preflight(session.runner(), session.worktree(), &name)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[tauri::command]
pub async fn branch_create(
    state: State<'_, AppState>,
    request: CreateBranchRequest,
) -> Result<MutationResult<BranchPreflight>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let reference = format!("refs/heads/{}", request.name);
    let name = request.name.clone();
    let checkout = request.checkout;
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "branch.create",
            label: format!("création de la branche {name}"),
            touched_refs: vec![reference.clone()],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let result =
                branches::create(runner, worktree, &name, request.start.as_deref(), checkout)?;
            let label = format!("création de la branche {name}");
            let ref_name = reference.clone();
            let sha = result.sha.clone().unwrap_or_default();
            let builder = Box::new(move |before: &Fingerprint, after: &Fingerprint| {
                let mut undo_actions = Vec::new();
                if checkout {
                    undo_actions.push(checkout_inverse(before));
                }
                if let Some(created) = ref_sha(after, &ref_name) {
                    undo_actions.push(ReversibleAction::DeleteRef {
                        reference: ref_name.clone(),
                        expected: created,
                    });
                }
                let mut redo_actions = vec![ReversibleAction::CreateRef {
                    reference: ref_name.clone(),
                    sha: sha.clone(),
                    upstream: None,
                }];
                if checkout {
                    redo_actions.push(checkout_inverse(after));
                }
                UndoDraft {
                    kind: "branch.create".to_owned(),
                    label,
                    undo: sequence(undo_actions),
                    redo: Some(sequence(redo_actions)),
                }
            });
            Ok((
                result,
                vec![
                    InvalidationArea::Refs,
                    InvalidationArea::Head,
                    InvalidationArea::State,
                ],
                builder,
            ))
        },
    )
    .await
}

#[tauri::command]
pub async fn branch_checkout(
    state: State<'_, AppState>,
    request: CheckoutRequest,
) -> Result<MutationResult<()>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let label = request
        .name
        .clone()
        .or_else(|| request.detached_at.clone())
        .unwrap_or_else(|| "HEAD".to_owned());
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "checkout",
            label: format!("checkout {label}"),
            touched_refs: Vec::new(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            branches::checkout(
                runner,
                worktree,
                request.name.as_deref(),
                request.detached_at.as_deref(),
            )?;
            let label = format!("checkout {label}");
            let builder = Box::new(move |before: &Fingerprint, after: &Fingerprint| UndoDraft {
                kind: "checkout".to_owned(),
                label,
                undo: checkout_inverse(before),
                redo: Some(checkout_inverse(after)),
            });
            Ok((
                (),
                vec![
                    InvalidationArea::Refs,
                    InvalidationArea::Head,
                    InvalidationArea::Worktree,
                    InvalidationArea::Index,
                    InvalidationArea::State,
                ],
                builder,
            ))
        },
    )
    .await
}

#[tauri::command]
pub async fn branch_rename(
    state: State<'_, AppState>,
    request: RenameBranchRequest,
) -> Result<MutationResult<()>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let old = request.old.clone();
    let new = request.new.clone();
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "branch.rename",
            label: format!("renommage de {old} en {new}"),
            touched_refs: vec![format!("refs/heads/{old}"), format!("refs/heads/{new}")],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            branches::rename(runner, worktree, &old, &new)?;
            let label = format!("renommage de {old} en {new}");
            let builder = Box::new(
                move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "branch.rename".to_owned(),
                    label,
                    undo: ReversibleAction::RenameRef {
                        from: new.clone(),
                        to: old.clone(),
                    },
                    redo: Some(ReversibleAction::RenameRef {
                        from: old.clone(),
                        to: new.clone(),
                    }),
                },
            );
            Ok(((), vec![InvalidationArea::Refs], builder))
        },
    )
    .await
}

#[tauri::command]
pub async fn branch_delete(
    state: State<'_, AppState>,
    request: DeleteBranchRequest,
) -> Result<MutationResult<String>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::BranchDelete, Some(&request.name))?;
    let session = state.session(&request.repo_id)?;
    let preflight = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        let name = request.name.clone();
        move || branches::preflight(session.runner(), session.worktree(), &name)
    })
    .await
    .map_err(crate::error::join_error)??;
    if preflight.current {
        return Err(AppError::new(
            "branch.current_delete",
            beebranch_core::ErrorCategory::GitState,
            "La branche courante ne peut pas être supprimée.",
        ));
    }
    let operation_id = new_operation_id("branch-delete");
    let detail = format!(
        "{} · mergée={} · sha={}",
        request.name,
        preflight.merged,
        preflight.sha.as_deref().unwrap_or("inconnu")
    );
    begin_destructive(
        &state,
        &operation_id,
        DestructiveAction::BranchDelete.code(),
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let store = state.store.clone();
    let reference = format!("refs/heads/{}", request.name);
    let result = run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "branch.delete",
            label: format!("suppression de la branche {}", request.name),
            touched_refs: vec![reference.clone()],
            affected_files: Vec::new(),
        },
        {
            let name = request.name.clone();
            let sha = preflight.sha.clone();
            let upstream = preflight.upstream.clone();
            let ref_name = reference.clone();
            move |runner, discovery| {
                let worktree = discovery.worktree()?;
                let deleted = branches::delete(runner, worktree, &name, !preflight.merged)?;
                let label = format!("suppression de la branche {name}");
                let restore_sha = sha.clone().unwrap_or_else(|| deleted.clone());
                let upstream = upstream.clone();
                let ref_name = ref_name.clone();
                let builder =
                    Box::new(
                        move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                            kind: "branch.delete".to_owned(),
                            label,
                            undo: ReversibleAction::CreateRef {
                                reference: ref_name.clone(),
                                sha: restore_sha.clone(),
                                upstream: upstream.clone(),
                            },
                            redo: Some(ReversibleAction::DeleteRef {
                                reference: ref_name.clone(),
                                expected: restore_sha.clone(),
                            }),
                        },
                    );
                Ok((deleted, vec![InvalidationArea::Refs], builder))
            }
        },
    )
    .await;
    finish_destructive(&state, &operation_id, &detail, result.as_ref().err())?;
    result
}

#[tauri::command]
pub async fn branch_delete_remote(
    state: State<'_, AppState>,
    request: DeleteRemoteBranchRequest,
) -> Result<MutationResult<()>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::BranchDelete, Some(&request.branch))?;
    let session = state.session(&request.repo_id)?;
    let operation_id = new_operation_id("branch-delete-remote");
    let detail = format!("{}/{}", request.remote, request.branch);
    begin_destructive(
        &state,
        &operation_id,
        "branch.delete_remote",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let result = run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        branches::delete_remote(runner, worktree, &request.remote, &request.branch)?;
        Ok(((), vec![InvalidationArea::Refs]))
    })
    .await;
    finish_destructive(&state, &operation_id, &detail, result.as_ref().err())?;
    result
}

#[tauri::command]
pub async fn branch_upstream(
    state: State<'_, AppState>,
    request: UpstreamRequest,
) -> Result<MutationResult<()>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        match request.upstream.as_deref() {
            Some(upstream) => {
                branches::set_upstream(runner, worktree, &request.branch, upstream)?;
            }
            None => branches::unset_upstream(runner, worktree, &request.branch)?,
        }
        Ok(((), vec![InvalidationArea::Refs]))
    })
    .await
}

#[tauri::command]
pub async fn branch_compare(
    state: State<'_, AppState>,
    repo_id: String,
    base: String,
    target: String,
) -> Result<BranchComparison, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        branches::compare(session.runner(), session.worktree(), &base, &target)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchesRequest {
    pub repo_id: String,
    pub names: Vec<String>,
    #[serde(default)]
    pub confirmation: Confirmation,
}

/// Delete several local branches under one explicit confirmation.
#[tauri::command]
pub async fn branch_delete_many(
    state: State<'_, AppState>,
    request: DeleteBranchesRequest,
) -> Result<MutationResult<Vec<String>>, AppError> {
    if request.names.is_empty() {
        return Err(AppError::invalid_input(
            "aucune branche sélectionnée".to_owned(),
        ));
    }
    let expected = format!("supprimer {} branches", request.names.len());
    request
        .confirmation
        .verify(DestructiveAction::BranchDeleteMany, Some(&expected))?;
    let session = state.session(&request.repo_id)?;
    let names = request.names.clone();
    let preflights = tauri::async_runtime::spawn_blocking({
        let session = session.clone();
        let names = names.clone();
        move || {
            names
                .into_iter()
                .map(|name| branches::preflight(session.runner(), session.worktree(), &name))
                .collect::<Result<Vec<_>, AppError>>()
        }
    })
    .await
    .map_err(crate::error::join_error)??;
    if let Some(current) = preflights.iter().find(|preflight| preflight.current) {
        return Err(AppError::new(
            "branch.current_delete",
            beebranch_core::ErrorCategory::GitState,
            format!(
                "La branche courante {} ne peut pas être supprimée.",
                current.name
            ),
        ));
    }
    let operation_id = new_operation_id("branch-delete-many");
    let detail = format!(
        "{} branches · {}",
        preflights.len(),
        preflights
            .iter()
            .map(|preflight| format!("{}:{:?}", preflight.name, preflight.sha))
            .collect::<Vec<_>>()
            .join(", ")
    );
    begin_destructive(
        &state,
        &operation_id,
        DestructiveAction::BranchDeleteMany.code(),
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let store = state.store.clone();
    let references: Vec<String> = names
        .iter()
        .map(|name| format!("refs/heads/{name}"))
        .collect();
    let result = run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "branch.deleteMany",
            label: format!("suppression de {} branches", names.len()),
            touched_refs: references.clone(),
            affected_files: Vec::new(),
        },
        {
            let names = names.clone();
            let restore: Vec<(String, String, Option<String>)> = names
                .iter()
                .zip(preflights.iter())
                .map(|(name, preflight)| {
                    (
                        format!("refs/heads/{name}"),
                        preflight.sha.clone().unwrap_or_default(),
                        preflight.upstream.clone(),
                    )
                })
                .collect();
            let label = format!("suppression de {} branches", names.len());
            move |runner, discovery| {
                let worktree = discovery.worktree()?;
                let mut deleted = Vec::new();
                for (name, preflight) in names.iter().zip(preflights.iter()) {
                    branches::delete(runner, worktree, name, !preflight.merged)?;
                    deleted.push(name.clone());
                }
                let restore = restore.clone();
                let label = label.clone();
                let builder = Box::new(move |_before: &Fingerprint, _after: &Fingerprint| {
                    let undo = restore
                        .iter()
                        .map(|(reference, sha, upstream)| ReversibleAction::CreateRef {
                            reference: reference.clone(),
                            sha: sha.clone(),
                            upstream: upstream.clone(),
                        })
                        .collect();
                    let redo = restore
                        .iter()
                        .map(|(reference, sha, _)| ReversibleAction::DeleteRef {
                            reference: reference.clone(),
                            expected: sha.clone(),
                        })
                        .collect();
                    UndoDraft {
                        kind: "branch.deleteMany".to_owned(),
                        label,
                        undo: sequence(undo),
                        redo: Some(sequence(redo)),
                    }
                });
                Ok((deleted, vec![InvalidationArea::Refs], builder))
            }
        },
    )
    .await;
    finish_destructive(&state, &operation_id, &detail, result.as_ref().err())?;
    result
}
