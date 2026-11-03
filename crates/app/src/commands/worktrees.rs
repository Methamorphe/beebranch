//! Worktree commands (P2-T04).

use beebranch_core::{AppError, Confirmation, DestructiveAction, ErrorCategory};
use beebranch_git::session::InvalidationArea;
use beebranch_git::undo::{Fingerprint, ReversibleAction};
use beebranch_git::worktree::{self, WorktreePruneReport, WorktreeReport};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    run_mutation, run_undoable_mutation, MutationResult, UndoDraft, UndoMeta,
};
use crate::error::join_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeListRequest {
    pub repo_id: String,
    #[serde(default)]
    pub include_status: bool,
}

#[tauri::command]
pub async fn worktree_list(
    state: State<'_, AppState>,
    request: WorktreeListRequest,
) -> Result<WorktreeReport, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree::list(session.runner(), session.worktree(), request.include_status)
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddRequest {
    pub repo_id: String,
    pub path: String,
    pub reference: String,
    pub new_branch: Option<String>,
    #[serde(default)]
    pub detach: bool,
}

#[tauri::command]
pub async fn worktree_add(
    state: State<'_, AppState>,
    request: WorktreeAddRequest,
) -> Result<MutationResult<WorktreeReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let path = request.path.clone();
    let reference = request.reference.clone();
    let new_branch = request.new_branch.clone();
    let detach = request.detach;
    // A branch created with the worktree is part of the operation: the undo
    // deletes it again, and refuses once commits moved it.
    let created_ref = new_branch.as_ref().map(|name| format!("refs/heads/{name}"));
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "worktree.add",
            label: format!("création du worktree {path}"),
            touched_refs: created_ref.iter().cloned().collect(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let report = worktree::add(
                runner,
                worktree,
                &path,
                &reference,
                new_branch.as_deref(),
                detach,
            )?;
            let label = format!("création du worktree {path}");
            let builder = Box::new(move |_before: &Fingerprint, after: &Fingerprint| {
                // `git worktree remove` without `--force` refuses a worktree
                // with local changes, so the undo never discards them.
                let mut undo = vec![ReversibleAction::RemoveWorktree {
                    path: path.clone(),
                    force: false,
                }];
                if let Some(reference) = &created_ref {
                    if let Some(sha) = after.refs.get(reference).filter(|sha| *sha != "absent") {
                        undo.push(ReversibleAction::DeleteRef {
                            reference: reference.clone(),
                            expected: sha.clone(),
                        });
                    }
                }
                UndoDraft {
                    kind: "worktree.add".to_owned(),
                    label,
                    undo: if undo.len() == 1 {
                        undo.remove(0)
                    } else {
                        ReversibleAction::Sequence { actions: undo }
                    },
                    redo: Some(ReversibleAction::AddWorktree {
                        path: path.clone(),
                        reference: reference.clone(),
                        new_branch: new_branch.clone(),
                        detach,
                    }),
                }
            });
            Ok((
                report,
                vec![InvalidationArea::Refs, InvalidationArea::State],
                builder,
            ))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub repo_id: String,
    pub path: String,
    #[serde(default)]
    pub force: bool,
    /// Also delete the branch that was checked out in the removed worktree.
    #[serde(default)]
    pub delete_branch: bool,
    pub confirmation: Confirmation,
}

#[tauri::command]
pub async fn worktree_remove(
    state: State<'_, AppState>,
    request: WorktreeRemoveRequest,
) -> Result<MutationResult<WorktreeReport>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::WorktreeRemove)?;
    let session = state.session(&request.repo_id)?;
    let (dirty, branch) = {
        let runner = session.runner().clone();
        let worktree = session.worktree().to_path_buf();
        let path = request.path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let report = worktree::list(&runner, &worktree, true)?;
            let entry = report.entries.iter().find(|entry| entry.path == path);
            Ok::<(bool, Option<String>), AppError>((
                entry.and_then(|entry| entry.dirty).unwrap_or(false),
                entry.and_then(|entry| entry.branch.clone()),
            ))
        })
        .await
        .map_err(join_error)??
    };
    if dirty && !request.force {
        return Err(AppError::new(
            "worktree.dirty",
            ErrorCategory::GitState,
            "Ce worktree contient des modifications non commitées.",
        )
        .with_remediation(
            "Committez ou supprimez les modifications, ou utilisez la suppression forcée après confirmation.",
        ));
    }
    let store = state.store.clone();
    let path = request.path.clone();
    let force = request.force;
    let delete_branch = request.delete_branch;
    if dirty {
        // The forced removal discards those changes for good: it is not
        // offered as undoable, since re-adding the worktree would not bring
        // them back.
        return run_mutation(state.store.clone(), session, move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let report = worktree::remove(runner, worktree, &path, force, delete_branch)?;
            Ok((
                report,
                vec![InvalidationArea::Refs, InvalidationArea::State],
            ))
        })
        .await;
    }
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "worktree.remove",
            label: format!("suppression du worktree {path}"),
            // The undo re-adds the worktree on this branch: it must still be
            // where it was (or still absent when it was deleted with it).
            touched_refs: branch
                .iter()
                .map(|name| format!("refs/heads/{name}"))
                .collect(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let before = worktree::list(runner, worktree, false)?;
            let entry = before
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .cloned();
            let report = worktree::remove(runner, worktree, &path, force, delete_branch)?;
            let label = format!("suppression du worktree {path}");
            let builder = Box::new(move |_before: &Fingerprint, _after: &Fingerprint| {
                // When the branch was deleted with the worktree, the undo must
                // recreate it at the recorded head, not check out a missing ref.
                let (reference, detach, new_branch) = match &entry {
                    Some(entry) if delete_branch && entry.branch.is_some() => (
                        entry.head.clone().unwrap_or_else(|| "HEAD".to_owned()),
                        false,
                        entry.branch.clone(),
                    ),
                    Some(entry) => match &entry.branch {
                        Some(branch) => (branch.clone(), false, None),
                        None => (
                            entry.head.clone().unwrap_or_else(|| "HEAD".to_owned()),
                            true,
                            None,
                        ),
                    },
                    None => ("HEAD".to_owned(), true, None),
                };
                UndoDraft {
                    kind: "worktree.remove".to_owned(),
                    label,
                    undo: ReversibleAction::AddWorktree {
                        path: path.clone(),
                        reference,
                        new_branch,
                        detach,
                    },
                    redo: Some(ReversibleAction::RemoveWorktree {
                        path: path.clone(),
                        force,
                    }),
                }
            });
            Ok((
                report,
                vec![InvalidationArea::Refs, InvalidationArea::State],
                builder,
            ))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLockRequest {
    pub repo_id: String,
    pub path: String,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn worktree_lock(
    state: State<'_, AppState>,
    request: WorktreeLockRequest,
) -> Result<MutationResult<WorktreeReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(state.store.clone(), session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = worktree::lock(runner, worktree, &request.path, request.reason.as_deref())?;
        Ok((report, vec![InvalidationArea::Refs]))
    })
    .await
}

#[tauri::command]
pub async fn worktree_unlock(
    state: State<'_, AppState>,
    request: WorktreeLockRequest,
) -> Result<MutationResult<WorktreeReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(state.store.clone(), session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = worktree::unlock(runner, worktree, &request.path)?;
        Ok((report, vec![InvalidationArea::Refs]))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePruneRequest {
    pub repo_id: String,
    #[serde(default)]
    pub dry_run: bool,
    /// Git duration such as `3.days.ago`; omitted keeps Git's own default.
    pub expire: Option<String>,
}

#[tauri::command]
pub async fn worktree_prune(
    state: State<'_, AppState>,
    request: WorktreePruneRequest,
) -> Result<MutationResult<WorktreePruneReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(state.store.clone(), session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = worktree::prune(runner, worktree, request.dry_run, request.expire.as_deref())?;
        let areas = if request.dry_run {
            vec![InvalidationArea::Refs]
        } else {
            vec![InvalidationArea::Refs, InvalidationArea::State]
        };
        Ok((report, areas))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRepairRequest {
    pub repo_id: String,
    /// Optional worktree path; omitted repairs every registered worktree.
    pub path: Option<String>,
}

#[tauri::command]
pub async fn worktree_repair(
    state: State<'_, AppState>,
    request: WorktreeRepairRequest,
) -> Result<MutationResult<WorktreeReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(state.store.clone(), session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = worktree::repair(runner, worktree, request.path.as_deref())?;
        Ok((report, vec![InvalidationArea::Refs]))
    })
    .await
}
