//! Commit search commands.

use beebranch_core::{AppError, PageRequest};
use beebranch_git::search::{self, SearchMode, SearchQuery, SearchResult};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::util::emit_operation;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub repo_id: String,
    pub text: String,
    pub mode: SearchMode,
    pub revision: Option<String>,
    #[serde(default)]
    pub all_refs: bool,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub request: PageRequest,
    /// Client-generated id used by `operation_cancel`.
    pub operation_id: String,
}

#[tauri::command]
pub async fn search_commits(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SearchRequest,
) -> Result<SearchResult, AppError> {
    if request.operation_id.is_empty()
        || request.operation_id.len() > 80
        || request.operation_id.chars().any(char::is_control)
    {
        return Err(AppError::invalid_input("operationId invalide".to_owned()));
    }
    let session = state.session(&request.repo_id)?;
    let operations = state.operations.clone();
    if operations
        .lock()
        .map(|flags| flags.contains_key(&request.operation_id))
        .unwrap_or(true)
    {
        return Err(AppError::invalid_input(
            "operationId déjà utilisé par une opération en cours".to_owned(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let query = SearchQuery {
            text: request.text,
            mode: request.mode,
            revision: request.revision,
            all_refs: request.all_refs,
            depth: request.depth.unwrap_or(search::DEFAULT_DEPTH),
            request: request.request,
            path: request.path,
            since: request.since,
            until: request.until,
            author: request.author,
        };
        let generation = session.generation();
        let context = beebranch_git::OperationContext::new(&request.operation_id, "search");
        let command = search::spawn(session.runner(), session.worktree(), &query, &context, {
            let app = app.clone();
            let operation_id = request.operation_id.clone();
            let repo_id = request.repo_id.clone();
            move |event| {
                if let beebranch_git::ProcessEvent::Started { pid } = event {
                    emit_operation(
                        &app,
                        "op://started",
                        serde_json::json!({ "operationId": operation_id, "repoId": repo_id, "pid": pid }),
                    );
                }
            }
        })?;
        if let Ok(mut flags) = operations.lock() {
            flags.insert(
                request.operation_id.clone(),
                (request.repo_id.clone(), command.cancel_flag()),
            );
        }
        emit_operation(
            &app,
            "op://started",
            serde_json::json!({ "operationId": request.operation_id, "repoId": request.repo_id }),
        );
        let outcome = command.wait();
        if let Ok(mut flags) = operations.lock() {
            flags.remove(&request.operation_id);
        }
        search::finish(outcome.map_err(AppError::from)?, &query, generation)
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSearchRequest {
    pub repo_id: String,
    pub text: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[tauri::command]
pub async fn search_paths(
    state: State<'_, AppState>,
    request: PathSearchRequest,
) -> Result<search::PathSearch, AppError> {
    let session = state.session(&request.repo_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        search::search_paths(
            session.runner(),
            session.worktree(),
            &request.text,
            request.limit.unwrap_or(200),
            request.offset.unwrap_or(0),
        )
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchRequest {
    pub repo_id: String,
    pub text: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    /// Client-generated id used by `operation_cancel`.
    pub operation_id: String,
}

#[tauri::command]
pub async fn search_content(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ContentSearchRequest,
) -> Result<search::ContentSearch, AppError> {
    if request.operation_id.is_empty()
        || request.operation_id.len() > 80
        || request.operation_id.chars().any(char::is_control)
    {
        return Err(AppError::invalid_input("operationId invalide".to_owned()));
    }
    let session = state.session(&request.repo_id)?;
    let operations = state.operations.clone();
    if operations
        .lock()
        .map(|flags| flags.contains_key(&request.operation_id))
        .unwrap_or(true)
    {
        return Err(AppError::invalid_input(
            "operationId déjà utilisé par une opération en cours".to_owned(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let limit = request.limit.unwrap_or(200);
        let context = beebranch_git::OperationContext::new(&request.operation_id, "content-search");
        let spec = search::content_command(
            session.worktree(),
            &request.text,
            request.path.as_deref(),
            limit,
            &context,
        )?;
        let command = session.runner().spawn(&spec, {
            let app = app.clone();
            let operation_id = request.operation_id.clone();
            let repo_id = request.repo_id.clone();
            move |event| {
                if let beebranch_git::ProcessEvent::Started { pid } = event {
                    emit_operation(
                        &app,
                        "op://started",
                        serde_json::json!({ "operationId": operation_id, "repoId": repo_id, "pid": pid }),
                    );
                }
            }
        })?;
        if let Ok(mut flags) = operations.lock() {
            flags.insert(
                request.operation_id.clone(),
                (request.repo_id.clone(), command.cancel_flag()),
            );
        }
        emit_operation(
            &app,
            "op://started",
            serde_json::json!({ "operationId": request.operation_id, "repoId": request.repo_id }),
        );
        let outcome = command.wait();
        if let Ok(mut flags) = operations.lock() {
            flags.remove(&request.operation_id);
        }
        search::finish_content(
            outcome.map_err(AppError::from)?,
            request.path.as_deref(),
            limit,
            request.offset.unwrap_or(0),
        )
    })
    .await
    .map_err(crate::error::join_error)?
}
