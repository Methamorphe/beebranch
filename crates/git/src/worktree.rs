//! Git worktrees: list, create, remove, lock and prune.
//!
//! Every operation reads the authoritative list from `git worktree list
//! --porcelain` before and after the mutation. Paths given by the frontend are
//! absolute and must match an entry reported by Git for removal, locking and
//! unlocking; an arbitrary path is never passed to a destructive command.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::status::read_status;
use crate::GitSubcommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub main: bool,
    /// Number of changed entries when `include_status` was requested.
    pub changed_files: Option<u32>,
    pub dirty: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReport {
    pub main_worktree: String,
    pub entries: Vec<WorktreeEntry>,
}

fn worktree_error(code: &'static str, message: &str) -> AppError {
    AppError::new(code, ErrorCategory::GitState, message.to_owned())
}

/// Read `git worktree list --porcelain`.
pub fn list(
    runner: &GitRunner,
    worktree: &Path,
    include_status: bool,
) -> Result<WorktreeReport, AppError> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Worktree, worktree)
                .arg("list")
                .arg("--porcelain"),
        )?
        .ensure_success()?;
    let mut entries = parse_list(&outcome.stdout.text_lossy());
    for entry in &mut entries {
        if include_status {
            let path = Path::new(&entry.path);
            match read_status(runner, path, Some(500)) {
                Ok(status) => {
                    entry.changed_files = Some(
                        (status.counts.staged
                            + status.counts.unstaged
                            + status.counts.untracked
                            + status.counts.conflicted) as u32,
                    );
                    entry.dirty = Some(status.counts.is_dirty());
                }
                Err(_) => {
                    entry.changed_files = None;
                    entry.dirty = None;
                }
            }
        }
    }
    let main_worktree = entries
        .iter()
        .find(|entry| entry.main)
        .map(|entry| entry.path.clone())
        .unwrap_or_else(|| worktree.display().to_string());
    Ok(WorktreeReport {
        main_worktree,
        entries,
    })
}

fn parse_list(text: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut bare = false;
        let mut detached = false;
        let mut locked = None;
        let mut prunable = None;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("branch ") {
                branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                );
            } else if line == "bare" {
                bare = true;
            } else if line == "detached" {
                detached = true;
            } else if line == "locked" {
                locked = Some(String::new());
            } else if let Some(value) = line.strip_prefix("locked ") {
                locked = Some(value.to_owned());
            } else if line == "prunable" {
                prunable = Some(String::new());
            } else if let Some(value) = line.strip_prefix("prunable ") {
                prunable = Some(value.to_owned());
            }
        }
        if let Some(path) = path {
            let main = entries.is_empty();
            entries.push(WorktreeEntry {
                path,
                head,
                branch,
                bare,
                detached,
                locked,
                prunable,
                main,
                changed_files: None,
                dirty: None,
            });
        }
    }
    entries
}

fn validate_worktree_path(path: &str) -> Result<PathBuf, AppError> {
    let value = Path::new(path);
    if path.trim().is_empty() {
        return Err(AppError::invalid_input(
            "le chemin du worktree est vide".to_owned(),
        ));
    }
    if !value.is_absolute() {
        return Err(AppError::invalid_input(
            "le chemin du worktree doit être absolu".to_owned(),
        ));
    }
    for component in value.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "le chemin du worktree ne peut pas remonter avec `..`".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "un worktree ne peut pas être créé dans `.git`".to_owned(),
                ));
            }
            _ => {}
        }
    }
    Ok(value.to_path_buf())
}

fn known_path(runner: &GitRunner, worktree: &Path, path: &str) -> Result<PathBuf, AppError> {
    let target = validate_worktree_path(path)?;
    let report = list(runner, worktree, false)?;
    let canonical = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    let known = report.entries.iter().any(|entry| {
        std::fs::canonicalize(&entry.path)
            .map(|path| path == canonical)
            .unwrap_or_else(|_| Path::new(&entry.path) == canonical)
    });
    if !known {
        return Err(worktree_error(
            "worktree.unknown",
            "Ce worktree n'appartient pas à ce dépôt.",
        )
        .with_detail(target.display().to_string()));
    }
    Ok(canonical)
}

/// Create a worktree. `reference` is a branch, tag or commit.
pub fn add(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    reference: &str,
    new_branch: Option<&str>,
    detach: bool,
) -> Result<WorktreeReport, AppError> {
    let target = validate_worktree_path(path)?;
    if target.exists() {
        return Err(worktree_error(
            "worktree.path_exists",
            "Le chemin du nouveau worktree existe déjà.",
        )
        .with_detail(target.display().to_string()));
    }
    crate::log::validate_revision(reference)?;
    if let Some(branch) = new_branch {
        crate::branches::validate_branch_name(runner, worktree, branch)?;
    }
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("add");
    if detach {
        spec = spec.arg("--detach");
    }
    if let Some(branch) = new_branch {
        spec = spec.arg("-b").arg(branch);
    }
    spec = spec.arg(target.as_os_str()).arg(reference);
    runner
        .run(&spec.timeout(Duration::from_secs(120)))?
        .ensure_success()?;
    list(runner, worktree, true)
}

/// Remove a worktree. A dirty worktree requires `force` plus a typed
/// confirmation in the command layer.
pub fn remove(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    force: bool,
) -> Result<WorktreeReport, AppError> {
    let target = known_path(runner, worktree, path)?;
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("remove");
    if force {
        spec = spec.arg("--force");
    }
    spec = spec.arg(target.as_os_str());
    runner
        .run(&spec.timeout(Duration::from_secs(120)))?
        .ensure_success()?;
    list(runner, worktree, true)
}

pub fn lock(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    reason: Option<&str>,
) -> Result<WorktreeReport, AppError> {
    let target = known_path(runner, worktree, path)?;
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("lock");
    if let Some(reason) = reason.map(str::trim).filter(|reason| !reason.is_empty()) {
        spec = spec.arg(format!("--reason={reason}"));
    }
    spec = spec.arg(target.as_os_str());
    runner.run(&spec)?.ensure_success()?;
    list(runner, worktree, true)
}

pub fn unlock(runner: &GitRunner, worktree: &Path, path: &str) -> Result<WorktreeReport, AppError> {
    let target = known_path(runner, worktree, path)?;
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Worktree, worktree)
                .arg("unlock")
                .arg(target.as_os_str()),
        )?
        .ensure_success()?;
    list(runner, worktree, true)
}

/// Prune metadata for missing worktrees. `dry_run` lists without deleting.
pub fn prune(
    runner: &GitRunner,
    worktree: &Path,
    dry_run: bool,
) -> Result<WorktreeReport, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("prune");
    if dry_run {
        spec = spec.arg("--dry-run");
    }
    runner.run(&spec)?.ensure_success()?;
    list(runner, worktree, true)
}

/// Count of changed files for one worktree path, used by status badges.
pub fn status_counts(runner: &GitRunner, path: &str) -> Result<(u32, bool), AppError> {
    let target = Path::new(path);
    if !target.is_dir() {
        return Err(worktree_error(
            "worktree.missing",
            "Le worktree n'est plus présent sur le disque.",
        ));
    }
    let status = read_status(runner, target, Some(500))?;
    Ok((
        (status.counts.staged
            + status.counts.unstaged
            + status.counts.untracked
            + status.counts.conflicted) as u32,
        status.counts.is_dirty(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_entries() {
        let text = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def\nbranch refs/heads/feature\nlocked maintenance\n";
        let entries = parse_list(text);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].main);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].path, "/repo-feature");
        assert_eq!(entries[1].locked.as_deref(), Some("maintenance"));
    }

    #[test]
    fn rejects_relative_and_git_paths() {
        assert!(validate_worktree_path("relative/path").is_err());
        assert!(validate_worktree_path("/repo/.git/wt").is_err());
        assert!(validate_worktree_path("/repo/../escape").is_err());
        assert!(validate_worktree_path("/repo/.gitx").is_ok());
    }
}
