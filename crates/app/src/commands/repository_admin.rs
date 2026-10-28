//! Tags, remotes and submodules commands (P2-T11, P2-T12).

use beebranch_core::{AppError, Confirmation, DestructiveAction, ErrorCategory};
use beebranch_git::refs_admin::{self, RemoteInfo, TagInfo};
use beebranch_git::session::InvalidationArea;
use beebranch_git::submodule::{self, SubmoduleReport};
use beebranch_git::undo::{self, Fingerprint, ReversibleAction};
use serde::Deserialize;
use tauri::State;

use crate::commands::util::{
    run_mutation, run_undoable_mutation, MutationResult, UndoDraft, UndoMeta,
};
use crate::error::join_error;
use crate::state::AppState;

fn require_explicit(confirmation: &Confirmation, what: &str) -> Result<(), AppError> {
    if confirmation.acknowledged {
        Ok(())
    } else {
        Err(AppError::new(
            "confirmation.required",
            ErrorCategory::Input,
            format!("Confirmez explicitement {what}."),
        ))
    }
}

// --- Tags -----------------------------------------------------------------

#[tauri::command]
pub async fn tag_list(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<TagInfo>, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        refs_admin::list_tags(session.runner(), session.worktree())
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagRequest {
    pub repo_id: String,
    pub name: String,
    pub message: Option<String>,
    pub target: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn tag_create(
    state: State<'_, AppState>,
    request: CreateTagRequest,
) -> Result<MutationResult<TagInfo>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let tag_name = request.name.clone();
    let reference = format!("refs/tags/{}", request.name);
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "tag.create",
            label: format!("création du tag {}", request.name),
            touched_refs: vec![reference.clone()],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let tag = refs_admin::create_tag(
                runner,
                worktree,
                &tag_name,
                request.message.as_deref(),
                request.target.as_deref(),
                request.force,
            )?;
            let label = format!("création du tag {}", tag.name);
            let name = tag.name.clone();
            let object = tag.oid.clone();
            let target = tag.target_oid.clone().unwrap_or_else(|| tag.oid.clone());
            let message = tag.message.clone();
            let tagger = tag.tagger.clone();
            let tagger_email = tag.tagger_email.clone();
            let tagger_time = tag.tagger_time;
            let builder = Box::new(
                move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "tag.create".to_owned(),
                    label,
                    undo: ReversibleAction::DeleteTag {
                        name: name.clone(),
                        expected: object.clone(),
                    },
                    redo: Some(ReversibleAction::CreateTag {
                        name: name.clone(),
                        object: target.clone(),
                        message: message.clone(),
                        tagger: tagger.clone(),
                        tagger_email: tagger_email.clone(),
                        tagger_time,
                    }),
                },
            );
            Ok((tag, vec![InvalidationArea::Refs], builder))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagRequest {
    pub repo_id: String,
    pub name: String,
    pub confirmation: Confirmation,
}

#[tauri::command]
pub async fn tag_delete(
    state: State<'_, AppState>,
    request: DeleteTagRequest,
) -> Result<MutationResult<Vec<TagInfo>>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::TagDelete, Some(&request.name))?;
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let name = request.name.clone();
    let reference = format!("refs/tags/{}", request.name);
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "tag.delete",
            label: format!("suppression du tag {name}"),
            touched_refs: vec![reference],
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let previous = refs_admin::list_tags(runner, worktree)?
                .into_iter()
                .find(|tag| tag.name == name)
                .ok_or_else(|| {
                    AppError::new(
                        "tag.missing",
                        ErrorCategory::GitState,
                        "Le tag est introuvable.",
                    )
                    .with_detail(name.clone())
                })?;
            refs_admin::delete_tag(runner, worktree, &name)?;
            let tags = refs_admin::list_tags(runner, worktree)?;
            let label = format!("suppression du tag {name}");
            let builder = Box::new(
                move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "tag.delete".to_owned(),
                    label,
                    undo: ReversibleAction::CreateTag {
                        name: previous.name.clone(),
                        object: previous
                            .target_oid
                            .clone()
                            .unwrap_or_else(|| previous.oid.clone()),
                        message: previous.message.clone(),
                        tagger: previous.tagger.clone(),
                        tagger_email: previous.tagger_email.clone(),
                        tagger_time: previous.tagger_time,
                    },
                    redo: Some(ReversibleAction::DeleteTag {
                        name: previous.name.clone(),
                        expected: previous.oid.clone(),
                    }),
                },
            );
            Ok((tags, vec![InvalidationArea::Refs], builder))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTagRequest {
    pub repo_id: String,
    pub remote: String,
    pub name: String,
    pub confirmation: Confirmation,
}

#[tauri::command]
pub async fn tag_push(
    state: State<'_, AppState>,
    request: PushTagRequest,
) -> Result<MutationResult<refs_admin::PushReport>, AppError> {
    require_explicit(&request.confirmation, "le push du tag vers le remote")?;
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = refs_admin::push_tag(runner, worktree, &request.remote, &request.name)?;
        Ok((report, vec![InvalidationArea::Refs]))
    })
    .await
}

// --- Remotes --------------------------------------------------------------

#[tauri::command]
pub async fn remote_list(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<RemoteInfo>, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        refs_admin::list_remotes(session.runner(), session.worktree())
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriteRequest {
    pub repo_id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub push: bool,
}

#[tauri::command]
pub async fn remote_add(
    state: State<'_, AppState>,
    request: RemoteWriteRequest,
) -> Result<MutationResult<Vec<RemoteInfo>>, AppError> {
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let name = request.name.clone();
    let url = request.url.clone();
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "remote.add",
            label: format!("ajout du remote {name}"),
            touched_refs: Vec::new(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let remotes = refs_admin::add_remote(runner, worktree, &name, &url)?;
            let (urls, push_urls, fetch) = undo::remote_config(runner, worktree, &name)?;
            let urls = dedup(urls);
            let label = format!("ajout du remote {name}");
            let remote_name = name.clone();
            let builder = Box::new(
                move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "remote.add".to_owned(),
                    label,
                    undo: ReversibleAction::RemoveRemote {
                        name: remote_name.clone(),
                        expected_urls: urls.clone(),
                    },
                    redo: Some(ReversibleAction::AddRemote {
                        name: remote_name.clone(),
                        urls: urls.clone(),
                        push_urls: push_urls.clone(),
                        fetch: fetch.clone(),
                    }),
                },
            );
            Ok((remotes, vec![InvalidationArea::Refs], builder))
        },
    )
    .await
}

fn dedup(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

#[tauri::command]
pub async fn remote_set_url(
    state: State<'_, AppState>,
    request: RemoteWriteRequest,
) -> Result<MutationResult<Vec<RemoteInfo>>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let remotes = refs_admin::set_remote_url(
            runner,
            worktree,
            &request.name,
            &request.url,
            request.push,
        )?;
        Ok((remotes, vec![InvalidationArea::Refs]))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemoveRequest {
    pub repo_id: String,
    pub name: String,
    pub confirmation: Confirmation,
}

#[tauri::command]
pub async fn remote_remove(
    state: State<'_, AppState>,
    request: RemoteRemoveRequest,
) -> Result<MutationResult<Vec<RemoteInfo>>, AppError> {
    request
        .confirmation
        .verify(DestructiveAction::RemoteRemove, Some(&request.name))?;
    let session = state.session(&request.repo_id)?;
    let store = state.store.clone();
    let name = request.name.clone();
    run_undoable_mutation(
        session,
        store,
        UndoMeta {
            kind: "remote.remove",
            label: format!("suppression du remote {name}"),
            touched_refs: Vec::new(),
            affected_files: Vec::new(),
        },
        move |runner, discovery| {
            let worktree = discovery.worktree()?;
            let (urls, push_urls, fetch) = undo::remote_config(runner, worktree, &name)?;
            let urls = dedup(urls);
            let remotes = refs_admin::remove_remote(runner, worktree, &name)?;
            let label = format!("suppression du remote {name}");
            let remote_name = name.clone();
            let builder = Box::new(
                move |_before: &Fingerprint, _after: &Fingerprint| UndoDraft {
                    kind: "remote.remove".to_owned(),
                    label,
                    undo: ReversibleAction::AddRemote {
                        name: remote_name.clone(),
                        urls: urls.clone(),
                        push_urls: push_urls.clone(),
                        fetch: fetch.clone(),
                    },
                    redo: Some(ReversibleAction::RemoveRemote {
                        name: remote_name.clone(),
                        expected_urls: urls.clone(),
                    }),
                },
            );
            Ok((remotes, vec![InvalidationArea::Refs], builder))
        },
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePruneRequest {
    pub repo_id: String,
    pub name: String,
}

#[tauri::command]
pub async fn remote_prune(
    state: State<'_, AppState>,
    request: RemotePruneRequest,
) -> Result<MutationResult<Vec<RemoteInfo>>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let remotes = refs_admin::prune_remote(runner, worktree, &request.name)?;
        Ok((remotes, vec![InvalidationArea::Refs]))
    })
    .await
}

// --- Submodules -----------------------------------------------------------

#[tauri::command]
pub async fn submodule_list(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<SubmoduleReport, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        submodule::list(session.runner(), session.worktree())
    })
    .await
    .map_err(join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleAddRequest {
    pub repo_id: String,
    pub url: String,
    pub path: String,
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn submodule_add(
    state: State<'_, AppState>,
    request: SubmoduleAddRequest,
) -> Result<MutationResult<SubmoduleReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = submodule::add(
            runner,
            worktree,
            &request.url,
            &request.path,
            request.branch.as_deref(),
        )?;
        Ok((
            report,
            vec![
                InvalidationArea::Index,
                InvalidationArea::Worktree,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUpdateRequest {
    pub repo_id: String,
    pub path: Option<String>,
    #[serde(default)]
    pub init: bool,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub remote: bool,
}

#[tauri::command]
pub async fn submodule_update(
    state: State<'_, AppState>,
    request: SubmoduleUpdateRequest,
) -> Result<MutationResult<SubmoduleReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = submodule::update(
            runner,
            worktree,
            request.init,
            request.recursive,
            request.remote,
            request.path.as_deref(),
        )?;
        Ok((
            report,
            vec![
                InvalidationArea::Index,
                InvalidationArea::Worktree,
                InvalidationArea::State,
            ],
        ))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleSyncRequest {
    pub repo_id: String,
    pub path: Option<String>,
    #[serde(default)]
    pub recursive: bool,
}

#[tauri::command]
pub async fn submodule_sync(
    state: State<'_, AppState>,
    request: SubmoduleSyncRequest,
) -> Result<MutationResult<SubmoduleReport>, AppError> {
    let session = state.session(&request.repo_id)?;
    run_mutation(session, move |runner, discovery| {
        let worktree = discovery.worktree()?;
        let report = submodule::sync(runner, worktree, request.recursive, request.path.as_deref())?;
        Ok((report, vec![InvalidationArea::State]))
    })
    .await
}
