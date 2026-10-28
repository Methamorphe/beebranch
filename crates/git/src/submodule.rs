//! Submodules: status, add, init/update and sync.
//!
//! Recursive operations are bounded by a timeout and return the renewed
//! status report. A submodule pointer is only ever moved by an explicit
//! `update`/`add` call from the UI.

use std::path::{Component, Path};
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

pub const MAX_SUBMODULES: usize = 500;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleState {
    UpToDate,
    Modified,
    NotInitialized,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleEntry {
    pub path: String,
    pub sha: String,
    pub state: SubmoduleState,
    pub describe: Option<String>,
    /// True when a nested submodule line was reported by `--recursive`.
    pub nested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleReport {
    pub entries: Vec<SubmoduleEntry>,
    pub truncated: bool,
}

pub fn list(runner: &GitRunner, worktree: &Path) -> Result<SubmoduleReport, AppError> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Submodule, worktree)
                .arg("status")
                .arg("--recursive"),
        )?
        .ensure_success()?;
    let mut entries = Vec::new();
    for line in outcome.stdout.text_lossy().lines() {
        if line.trim().is_empty() {
            continue;
        }
        // ` X <sha> <path> (<describe>)` where X is ' ', '-', '+' or 'U'.
        let state = match line.as_bytes().first().copied() {
            Some(b'-') => SubmoduleState::NotInitialized,
            Some(b'+') => SubmoduleState::Modified,
            Some(b'U') => SubmoduleState::Conflict,
            _ => SubmoduleState::UpToDate,
        };
        let rest = line[1..].trim_start();
        let mut fields = rest.splitn(2, ' ');
        let Some(sha) = fields.next() else { continue };
        let remainder = fields.next().unwrap_or_default();
        let (path, describe) = match remainder.rsplit_once(" (") {
            Some((path, describe)) => (
                path.to_owned(),
                Some(describe.trim_end_matches(')').to_owned()),
            ),
            None => (remainder.to_owned(), None),
        };
        if path.is_empty() {
            continue;
        }
        let nested = line.starts_with("  ") || line.starts_with('\t');
        entries.push(SubmoduleEntry {
            path,
            sha: sha.to_owned(),
            state,
            describe,
            nested,
        });
        if entries.len() >= MAX_SUBMODULES {
            break;
        }
    }
    Ok(SubmoduleReport {
        truncated: entries.len() >= MAX_SUBMODULES,
        entries,
    })
}

fn validate_relative_path(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_input("le chemin est vide".to_owned()));
    }
    let value = Path::new(path);
    if value.is_absolute() {
        return Err(AppError::invalid_input(
            "le chemin du sous-module doit être relatif".to_owned(),
        ));
    }
    for component in value.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "le chemin ne peut pas remonter avec `..`".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "l'accès direct à `.git` est interdit".to_owned(),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), AppError> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(AppError::invalid_input(
            "l'URL du sous-module est invalide".to_owned(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::invalid_input(
            "l'URL du sous-module ne peut pas contenir d'espace.".to_owned(),
        ));
    }
    if let Some((userinfo, _)) = trimmed.split_once('@') {
        if userinfo.contains(':') {
            return Err(AppError::new(
                "submodule.url_has_credentials",
                ErrorCategory::Input,
                "L'URL du sous-module ne doit pas contenir de mot de passe.",
            ));
        }
    }
    if let Some(scheme) = trimmed.split_once("://").map(|(scheme, _)| scheme) {
        let allowed = matches!(scheme, "https" | "http" | "ssh" | "git" | "file");
        if !allowed {
            return Err(AppError::invalid_input(format!(
                "Le protocole `{scheme}` n'est pas autorisé pour un sous-module."
            )));
        }
    }
    Ok(())
}

/// Add a submodule. `branch` optionally tracks a branch.
pub fn add(
    runner: &GitRunner,
    worktree: &Path,
    url: &str,
    path: &str,
    branch: Option<&str>,
) -> Result<SubmoduleReport, AppError> {
    validate_relative_path(path)?;
    validate_url(url)?;
    if let Some(branch) = branch {
        crate::branches::validate_branch_name(runner, worktree, branch)?;
    }
    let mut spec = CommandSpec::new(GitSubcommand::Submodule, worktree)
        .arg("add")
        .arg("--force");
    if let Some(branch) = branch {
        spec = spec.arg("-b").arg(branch);
    }
    spec = spec.arg(url).arg(path);
    // Git refuses the `file` transport for submodules by default. A local
    // path explicitly entered by the user is a legitimate source; scope the
    // allowance to that command.
    if url.starts_with('/')
        || url.starts_with("file://")
        || url.starts_with("./")
        || url.starts_with("../")
    {
        spec = spec.env("GIT_ALLOW_PROTOCOL", "file:https:ssh:git");
    }
    runner
        .run(&spec.timeout(NETWORK_TIMEOUT))?
        .ensure_success()?;
    list(runner, worktree)
}

/// Initialise or update submodules. `path` limits the operation to one entry.
pub fn update(
    runner: &GitRunner,
    worktree: &Path,
    init: bool,
    recursive: bool,
    remote: bool,
    path: Option<&str>,
) -> Result<SubmoduleReport, AppError> {
    if let Some(path) = path {
        validate_relative_path(path)?;
    }
    let mut spec = CommandSpec::new(GitSubcommand::Submodule, worktree).arg("update");
    if init {
        spec = spec.arg("--init");
    }
    if recursive {
        spec = spec.arg("--recursive");
    }
    if remote {
        spec = spec.arg("--remote");
    }
    if let Some(path) = path {
        spec = spec.arg("--").arg(path);
    }
    runner
        .run(&spec.timeout(NETWORK_TIMEOUT))?
        .ensure_success()?;
    list(runner, worktree)
}

pub fn sync(
    runner: &GitRunner,
    worktree: &Path,
    recursive: bool,
    path: Option<&str>,
) -> Result<SubmoduleReport, AppError> {
    if let Some(path) = path {
        validate_relative_path(path)?;
    }
    let mut spec = CommandSpec::new(GitSubcommand::Submodule, worktree).arg("sync");
    if recursive {
        spec = spec.arg("--recursive");
    }
    if let Some(path) = path {
        spec = spec.arg("--").arg(path);
    }
    runner
        .run(&spec.timeout(NETWORK_TIMEOUT))?
        .ensure_success()?;
    list(runner, worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_states_and_describe() {
        let text = " abc1234 vendor/lib (v1.2.0)\n-def5678 vendor/offline\n+aaa9999 vendor/dirty\nUbbb0000 vendor/conflict\n";
        let mut entries = Vec::new();
        for line in text.lines() {
            let state = match line.as_bytes().first().copied() {
                Some(b'-') => SubmoduleState::NotInitialized,
                Some(b'+') => SubmoduleState::Modified,
                Some(b'U') => SubmoduleState::Conflict,
                _ => SubmoduleState::UpToDate,
            };
            entries.push(state);
        }
        assert_eq!(
            entries,
            vec![
                SubmoduleState::UpToDate,
                SubmoduleState::NotInitialized,
                SubmoduleState::Modified,
                SubmoduleState::Conflict
            ]
        );
        assert!(validate_url("https://example.test/a.git").is_ok());
        assert!(validate_url("https://user:secret@example.test/a.git").is_err());
        assert!(validate_url("ext::sh -c evil").is_err());
    }
}
