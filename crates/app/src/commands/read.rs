use beebranch_core::{AppError, Page, PageRequest};
use beebranch_git::commit::CommitDetail;
use beebranch_git::diff::{read_untracked_file, DiffLimits, DiffReport, DiffTarget};
use beebranch_git::graph::GraphRow;
use beebranch_git::log::CommitSummary;
use beebranch_git::refs::RefsSnapshot;
use beebranch_git::session::RepoSession;
use beebranch_git::status::StatusReport;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
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

/// Default text budget for one file read: enough for any README, small enough
/// to keep the IPC payload and the renderer responsive.
const FILE_CONTENT_DEFAULT_LIMIT: usize = 2 * 1024 * 1024;
const FILE_CONTENT_MAX_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentRequestDto {
    pub path: String,
    /// `worktree` (default), `index`, `head`, or any revision such as a SHA.
    pub revision: Option<String>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentDto {
    pub path: String,
    pub revision: String,
    /// `None` when the path is absent at that revision or the bytes are binary.
    pub content: Option<String>,
    pub bytes: u64,
    pub truncated: bool,
    pub binary: bool,
}

/// Read one text file for the in-app renderer.
///
/// GitLab and repository prose is untrusted, so this only ever returns bytes;
/// the frontend builds Markdown as React elements and never injects HTML.
#[tauri::command]
pub async fn file_content_get(
    state: State<'_, AppState>,
    repo_id: String,
    request: FileContentRequestDto,
) -> Result<FileContentDto, AppError> {
    let session = state.session(&repo_id)?;
    tauri::async_runtime::spawn_blocking(move || read_file_content(&session, &request))
        .await
        .map_err(join_error)?
}

fn read_file_content(
    session: &RepoSession,
    request: &FileContentRequestDto,
) -> Result<FileContentDto, AppError> {
    beebranch_git::diff::validate_relative_path(&request.path)?;
    let limit = request
        .max_bytes
        .unwrap_or(FILE_CONTENT_DEFAULT_LIMIT)
        .clamp(1024, FILE_CONTENT_MAX_LIMIT);
    let revision = request
        .revision
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("worktree");
    let path = request.path.as_str();

    let (bytes, total, truncated) = match revision.to_ascii_lowercase().as_str() {
        "worktree" => read_worktree_file(session.worktree(), path, limit)?,
        "index" => cap_blob(
            beebranch_git::history::index_content(session.runner(), session.worktree(), path)?,
            limit,
        ),
        "head" => cap_blob(
            beebranch_git::history::head_content(session.runner(), session.worktree(), path)?,
            limit,
        ),
        _ => cap_blob(
            beebranch_git::history::revision_content(
                session.runner(),
                session.worktree(),
                revision,
                path,
            )?,
            limit,
        ),
    };
    let (content, binary) = decode_content(bytes, truncated);

    Ok(FileContentDto {
        path: request.path.clone(),
        revision: revision.to_owned(),
        content,
        bytes: total,
        truncated,
        binary,
    })
}

fn read_worktree_file(
    worktree: &Path,
    path: &str,
    limit: usize,
) -> Result<(Option<Vec<u8>>, u64, bool), AppError> {
    let target = worktree.join(path);
    // Follow symlinks only inside the worktree: a link cannot exfiltrate an
    // arbitrary local file through the renderer.
    let root = std::fs::canonicalize(worktree)
        .map_err(|error| AppError::internal(format!("worktree {}: {error}", worktree.display())))?;
    let canonical = match std::fs::canonicalize(&target) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, 0, false)),
        Err(error) => {
            return Err(AppError::internal(format!(
                "lecture de {}: {error}",
                target.display()
            )))
        }
    };
    if !canonical.starts_with(&root) {
        return Err(AppError::invalid_input(
            "le chemin sort du worktree".to_owned(),
        ));
    }
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        AppError::internal(format!("lecture de {}: {error}", canonical.display()))
    })?;
    if !metadata.is_file() {
        return Err(AppError::invalid_input(format!(
            "{path} n'est pas un fichier"
        )));
    }
    let file = std::fs::File::open(&canonical).map_err(|error| {
        AppError::internal(format!("lecture de {}: {error}", canonical.display()))
    })?;
    let mut bytes = Vec::new();
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            AppError::internal(format!("lecture de {}: {error}", canonical.display()))
        })?;
    let total = metadata.len();
    Ok((Some(bytes), total, total > limit as u64))
}

fn cap_blob(bytes: Option<Vec<u8>>, limit: usize) -> (Option<Vec<u8>>, u64, bool) {
    match bytes {
        None => (None, 0, false),
        Some(mut data) => {
            let total = data.len() as u64;
            if data.len() > limit {
                data.truncate(limit);
                (Some(data), total, true)
            } else {
                (Some(data), total, false)
            }
        }
    }
}

fn decode_content(bytes: Option<Vec<u8>>, truncated: bool) -> (Option<String>, bool) {
    let Some(data) = bytes else {
        return (None, false);
    };
    if data.contains(&0) {
        return (None, true);
    }
    match String::from_utf8(data) {
        Ok(text) => (Some(text), false),
        // A truncated read may cut a multi-byte character in half; keep the
        // readable prefix instead of declaring the file binary.
        Err(error) if truncated => (
            Some(String::from_utf8_lossy(error.as_bytes()).into_owned()),
            false,
        ),
        Err(_) => (None, true),
    }
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
            let paths = request.path.iter().cloned().collect::<Vec<_>>();
            let mut report = match detail.summary.parents.first() {
                Some(parent) => session.diff(
                    &DiffTarget::Range {
                        base: parent.clone(),
                        target: Some(sha.to_owned()),
                    },
                    &paths,
                    limits,
                ),
                None => beebranch_git::diff::read_root_patch(
                    session.runner(),
                    session.worktree(),
                    sha,
                    &paths,
                    limits,
                ),
            }?;
            // A stash keeps its untracked files in a separate root commit:
            // the tracked diff alone would silently hide them.
            if let Some(untracked) = detail
                .stash
                .as_ref()
                .and_then(|stash| stash.untracked.as_deref())
            {
                let extra = beebranch_git::diff::read_root_patch(
                    session.runner(),
                    session.worktree(),
                    untracked,
                    &paths,
                    limits,
                )?;
                report.truncated |= extra.truncated;
                for file in extra.files {
                    if !report
                        .files
                        .iter()
                        .any(|existing| existing.new_path == file.new_path)
                    {
                        report.files.push(file);
                    }
                }
            }
            Ok(report)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use beebranch_git::session::{RepoSession, SessionOptions};
    use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};

    fn git(
        runner: &GitRunner,
        dir: &Path,
        subcommand: GitSubcommand,
        args: &[&str],
        stdin: &[u8],
    ) -> String {
        let spec = CommandSpec::new(subcommand, dir)
            .args(args.iter().copied())
            .stdin(StdinMode::Bytes(stdin.to_vec()));
        let outcome = runner.run(&spec).expect("git");
        assert!(
            outcome.success(),
            "{subcommand}: {}",
            outcome.stderr.text_lossy()
        );
        outcome.stdout.text_lossy().trim().to_owned()
    }

    fn repository(dir: &Path, runner: &GitRunner) -> (String, String) {
        git(
            runner,
            dir,
            GitSubcommand::Init,
            &["--quiet", "--initial-branch=main"],
            &[],
        );
        git(
            runner,
            dir,
            GitSubcommand::Config,
            &["user.email", "a@b.c"],
            &[],
        );
        git(
            runner,
            dir,
            GitSubcommand::Config,
            &["user.name", "Alice"],
            &[],
        );
        std::fs::write(dir.join("a.txt"), "one\n").expect("write");
        git(runner, dir, GitSubcommand::Add, &["-A"], &[]);
        git(runner, dir, GitSubcommand::Commit, &["-F", "-"], b"first\n");
        let root = git(runner, dir, GitSubcommand::RevParse, &["HEAD"], &[]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").expect("write");
        std::fs::write(dir.join("b.txt"), "other\n").expect("write");
        git(runner, dir, GitSubcommand::Add, &["-A"], &[]);
        git(
            runner,
            dir,
            GitSubcommand::Commit,
            &["-F", "-"],
            b"second\n",
        );
        let head = git(runner, dir, GitSubcommand::RevParse, &["HEAD"], &[]);
        (root, head)
    }

    fn commit_request(sha: &str, path: &str) -> DiffRequestDto {
        DiffRequestDto {
            target: "commit".to_owned(),
            base: Some(sha.to_owned()),
            target_ref: None,
            path: Some(path.to_owned()),
            context_lines: None,
            untracked: None,
        }
    }

    #[test]
    fn commit_diff_returns_only_the_requested_path() {
        let dir = tempfile::tempdir().expect("repo");
        let runner = GitRunner::detect().expect("git");
        let (root, head) = repository(dir.path(), &runner);
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("session");

        let report = compute_diff(&session, &commit_request(&head, "b.txt")).expect("commit diff");
        assert_eq!(
            report.files.len(),
            1,
            "{:?}",
            report
                .files
                .iter()
                .map(|file| file.new_path.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(report.files[0].new_path, "b.txt");

        let report = compute_diff(&session, &commit_request(&root, "a.txt")).expect("root diff");
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].new_path, "a.txt");

        let report = compute_diff(&session, &commit_request(&root, "b.txt")).expect("root diff");
        assert!(
            report.files.is_empty(),
            "b.txt is absent from the root commit"
        );
    }

    fn content_request(
        path: &str,
        revision: Option<&str>,
        max_bytes: Option<usize>,
    ) -> FileContentRequestDto {
        FileContentRequestDto {
            path: path.to_owned(),
            revision: revision.map(str::to_owned),
            max_bytes,
        }
    }

    #[test]
    fn file_content_reads_worktree_head_and_history() {
        let dir = tempfile::tempdir().expect("repo");
        let runner = GitRunner::detect().expect("git");
        let (root, _) = repository(dir.path(), &runner);
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("session");

        let worktree =
            read_file_content(&session, &content_request("a.txt", None, None)).expect("worktree");
        assert_eq!(worktree.content.as_deref(), Some("one\ntwo\n"));
        assert_eq!(worktree.bytes, 8);
        assert!(!worktree.truncated && !worktree.binary);

        let head = read_file_content(&session, &content_request("a.txt", Some("head"), None))
            .expect("head");
        assert_eq!(head.content.as_deref(), Some("one\ntwo\n"));

        let first = read_file_content(&session, &content_request("a.txt", Some(&root), None))
            .expect("root");
        assert_eq!(first.content.as_deref(), Some("one\n"));

        let missing =
            read_file_content(&session, &content_request("missing.md", Some("head"), None))
                .expect("missing");
        assert!(missing.content.is_none());
        assert_eq!(missing.bytes, 0);
        assert!(!missing.binary);
    }

    #[test]
    fn file_content_flags_binary_and_truncates_large_files() {
        let dir = tempfile::tempdir().expect("repo");
        let runner = GitRunner::detect().expect("git");
        repository(dir.path(), &runner);
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("session");

        std::fs::write(dir.path().join("bin.dat"), b"a\0b").expect("write");
        let binary =
            read_file_content(&session, &content_request("bin.dat", None, None)).expect("binary");
        assert!(binary.binary);
        assert!(binary.content.is_none());
        assert_eq!(binary.bytes, 3);

        std::fs::write(dir.path().join("big.md"), "x".repeat(4096)).expect("write");
        let truncated = read_file_content(&session, &content_request("big.md", None, Some(1024)))
            .expect("truncated");
        assert!(truncated.truncated);
        assert_eq!(truncated.bytes, 4096);
        assert_eq!(truncated.content.as_deref().map(str::len), Some(1024));
    }

    #[test]
    fn file_content_refuses_paths_outside_the_worktree() {
        let dir = tempfile::tempdir().expect("repo");
        let runner = GitRunner::detect().expect("git");
        repository(dir.path(), &runner);
        let session =
            RepoSession::open(&runner, dir.path(), SessionOptions::default()).expect("session");

        assert!(read_file_content(&session, &content_request("../escape.md", None, None)).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", dir.path().join("link.md")).expect("symlink");
            assert!(read_file_content(&session, &content_request("link.md", None, None)).is_err());
        }
    }
}
