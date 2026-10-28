use beebranch_core::{AppError, Page, PageRequest};
use beebranch_git::commit::CommitDetail;
use beebranch_git::diff::{read_untracked_file, DiffLimits, DiffReport, DiffTarget};
use beebranch_git::graph::GraphRow;
use beebranch_git::log::CommitSummary;
use beebranch_git::refs::RefsSnapshot;
use beebranch_git::status::StatusReport;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::join_error;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation<T> {
    pub data: T,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub commits: Vec<CommitSummary>,
    pub rows: Vec<GraphRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub generation: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequestDto {
    /// `worktree`, `index`, `commit` or `range`.
    pub target: String,
    pub base: Option<String>,
    pub target_ref: Option<String>,
    pub path: Option<String>,
    pub context_lines: Option<u32>,
    /// Set by the caller when the path is untracked in the current status.
    pub untracked: Option<bool>,
}

#[tauri::command]
pub async fn status_get(
    state: State<'_, AppState>,
    repo_id: String,
    max_entries: Option<usize>,
    include_ignored: Option<bool>,
) -> Result<Generation<StatusReport>, AppError> {
    let session = state.session(&repo_id)?;
    let (report, generation) = tauri::async_runtime::spawn_blocking(move || {
        session.status_opts(max_entries, include_ignored.unwrap_or(false))
    })
    .await
    .map_err(join_error)??;
    Ok(Generation {
        data: report,
        generation,
    })
}

#[tauri::command]
pub async fn refs_get(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Generation<RefsSnapshot>, AppError> {
    let session = state.session(&repo_id)?;
    let (refs, generation) = tauri::async_runtime::spawn_blocking(move || session.refs())
        .await
        .map_err(join_error)??;
    Ok(Generation {
        data: refs,
        generation,
    })
}

#[tauri::command]
pub async fn log_page(
    state: State<'_, AppState>,
    repo_id: String,
    request: PageRequest,
    revision: Option<String>,
) -> Result<Page<CommitSummary>, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || session.log(&request, revision.as_deref()))
        .await
        .map_err(join_error)?
}

#[tauri::command]
pub async fn graph_page(
    state: State<'_, AppState>,
    repo_id: String,
    request: PageRequest,
    revision: Option<String>,
    all_refs: Option<bool>,
) -> Result<GraphPage, AppError> {
    let session = state.session(&repo_id)?;
    let (page, rows) = tauri::async_runtime::spawn_blocking(move || {
        session.graph_page_scoped(&request, revision.as_deref(), all_refs.unwrap_or(false))
    })
    .await
    .map_err(join_error)??;
    Ok(GraphPage {
        commits: page.items,
        rows,
        next: page.next,
        generation: page.generation,
        truncated: page.truncated,
    })
}

#[tauri::command]
pub async fn commit_get(
    state: State<'_, AppState>,
    repo_id: String,
    sha: String,
) -> Result<Generation<CommitDetail>, AppError> {
    let session = state.session(&repo_id)?;
    let (detail, generation) = tauri::async_runtime::spawn_blocking(move || {
        let generation = session.generation();
        session.commit(&sha).map(|detail| (detail, generation))
    })
    .await
    .map_err(join_error)??;
    Ok(Generation {
        data: detail,
        generation,
    })
}

#[tauri::command]
pub async fn diff_get(
    state: State<'_, AppState>,
    repo_id: String,
    request: DiffRequestDto,
) -> Result<Generation<DiffReport>, AppError> {
    let session = state.session(&repo_id)?;
    let (report, generation) = tauri::async_runtime::spawn_blocking(move || {
        let generation = session.generation();
        compute_diff(&session, &request).map(|report| (report, generation))
    })
    .await
    .map_err(join_error)??;

    Ok(Generation {
        data: report,
        generation,
    })
}

fn compute_diff(
    session: &beebranch_git::session::RepoSession,
    request: &DiffRequestDto,
) -> Result<DiffReport, AppError> {
    let limits = DiffLimits {
        context_lines: request.context_lines.unwrap_or(3).clamp(0, 100),
        ..DiffLimits::default()
    };

    match request.target.as_str() {
        "worktree" => {
            if request.untracked.unwrap_or(false) {
                let path = request.path.as_deref().ok_or_else(|| {
                    AppError::invalid_input("un chemin est requis pour un fichier non suivi")
                })?;
                let file = read_untracked_file(session.worktree(), path, limits)?;
                Ok(DiffReport {
                    truncated: file.truncated,
                    files: vec![file],
                })
            } else {
                let paths = request.path.iter().cloned().collect::<Vec<_>>();
                session.diff(&DiffTarget::WorkingTree, &paths, limits)
            }
        }
        "index" => {
            let paths = request.path.iter().cloned().collect::<Vec<_>>();
            session.diff(&DiffTarget::Index, &paths, limits)
        }
        "commit" => {
            let sha = request
                .base
                .as_deref()
                .ok_or_else(|| AppError::invalid_input("un SHA de commit est requis"))?;
            let detail = session.commit(sha)?;
            match detail.summary.parents.first() {
                Some(parent) => session.diff(
                    &DiffTarget::Range {
                        base: parent.clone(),
                        target: Some(sha.to_owned()),
                    },
                    &[],
                    limits,
                ),
                None => beebranch_git::diff::read_root_patch(
                    session.runner(),
                    session.worktree(),
                    sha,
                    limits,
                ),
            }
        }
        "range" => {
            let base = request
                .base
                .clone()
                .ok_or_else(|| AppError::invalid_input("une base est requise pour un range"))?;
            let paths = request.path.iter().cloned().collect::<Vec<_>>();
            session.diff(
                &DiffTarget::Range {
                    base,
                    target: request.target_ref.clone(),
                },
                &paths,
                limits,
            )
        }
        other => Err(AppError::invalid_input(format!(
            "cible de diff inconnue: {other}"
        ))),
    }
}
