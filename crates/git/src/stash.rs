//! Stash lifecycle: create, list, apply, pop and drop.

use std::path::Path;

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};

use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::status::read_status;
use crate::GitSubcommand;

pub const STASH_FORMAT: &str = "%gd%x1f%H%x1f%ct%x1f%gs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Reflog selector (`stash@{0}`).
    pub selector: String,
    pub sha: String,
    pub timestamp: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashOutcome {
    pub output: String,
    pub applied: bool,
    pub conflicts: Vec<String>,
}

/// Create a stash, optionally including untracked files.
pub fn create(
    runner: &GitRunner,
    worktree: &Path,
    message: &str,
    include_untracked: bool,
) -> Result<String, AppError> {
    if message.contains('\0') || message.contains('\n') || message.contains('\r') {
        return Err(AppError::invalid_input(
            "le message de stash doit tenir sur une ligne".to_owned(),
        ));
    }
    let mut spec = CommandSpec::new(GitSubcommand::Stash, worktree)
        .arg("push")
        .arg("-m")
        .arg(message)
        .capture_limits(CaptureLimits {
            stdout: 1024 * 1024,
            stderr: 1024 * 1024,
        });
    if include_untracked {
        spec = spec.arg("--include-untracked");
    }
    let outcome = runner.run(&spec)?.ensure_success()?;
    Ok(outcome.stdout.redacted())
}

/// List stashes, newest first.
pub fn list(runner: &GitRunner, worktree: &Path) -> Result<Vec<StashEntry>, AppError> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Stash, worktree)
                .arg("list")
                .arg(format!("--format={STASH_FORMAT}")),
        )?
        .ensure_success()?;
    parse_list(&outcome.stdout.text_lossy())
        .map_err(|message| AppError::internal(format!("stash list: {message}")))
}

/// Apply a stash and keep it.
pub fn apply(
    runner: &GitRunner,
    worktree: &Path,
    selector: &str,
) -> Result<StashOutcome, AppError> {
    run_apply(runner, worktree, selector, false, false)
}

/// Apply a stash and drop it only when the application succeeded without
/// conflicts (Git's `stash pop` semantics).
pub fn pop(runner: &GitRunner, worktree: &Path, selector: &str) -> Result<StashOutcome, AppError> {
    run_apply(runner, worktree, selector, true, false)
}

/// Pop a stash while restoring the staged state recorded in it (`--index`).
///
/// Used for the automatic stash of a branch integration: the local changes must
/// come back exactly as they were, staged files included.
pub fn pop_indexed(
    runner: &GitRunner,
    worktree: &Path,
    selector: &str,
) -> Result<StashOutcome, AppError> {
    run_apply(runner, worktree, selector, true, true)
}

fn run_apply(
    runner: &GitRunner,
    worktree: &Path,
    selector: &str,
    pop: bool,
    index: bool,
) -> Result<StashOutcome, AppError> {
    validate_selector(selector)?;
    let mut spec = CommandSpec::new(GitSubcommand::Stash, worktree)
        .arg(if pop { "pop" } else { "apply" })
        .capture_limits(CaptureLimits {
            stdout: 1024 * 1024,
            stderr: 1024 * 1024,
        });
    if index {
        spec = spec.arg("--index");
    }
    let outcome = runner.run(&spec.arg(selector))?;
    let output = join_output(outcome.stdout.redacted(), outcome.stderr.redacted());
    let status = read_status(runner, worktree, None)?;
    let conflicts = status.conflicts();
    if !outcome.success() && conflicts.is_empty() {
        let mut error = beebranch_core::classify_git_failure(outcome.exit_code(), &output);
        if error.code == "git.exit_unknown" {
            error = AppError::new(
                "stash.apply_failed",
                beebranch_core::ErrorCategory::GitExit,
                "Le stash n'a pas pu être appliqué.",
            );
        }
        return Err(error
            .with_detail(output)
            .with_remediation("Résolvez l'état du dépôt puis réessayez."));
    }
    Ok(StashOutcome {
        output,
        applied: outcome.success() || !conflicts.is_empty(),
        conflicts,
    })
}

/// Drop a stash. Returns the SHA that remains recoverable through the reflog.
pub fn drop(runner: &GitRunner, worktree: &Path, selector: &str) -> Result<String, AppError> {
    validate_selector(selector)?;
    let sha = resolve_selector(runner, worktree, selector)?;
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Stash, worktree)
                .arg("drop")
                .arg(selector),
        )?
        .ensure_success()?;
    Ok(sha)
}

/// Resolve a stash selector to its commit SHA.
pub fn resolve_selector(
    runner: &GitRunner,
    worktree: &Path,
    selector: &str,
) -> Result<String, AppError> {
    validate_selector(selector)?;
    let entries = list(runner, worktree)?;
    entries
        .into_iter()
        .find(|entry| entry.selector == selector)
        .map(|entry| entry.sha)
        .ok_or_else(|| AppError::not_found(format!("Le stash {selector} n'existe pas.")))
}

pub fn validate_selector(selector: &str) -> Result<(), AppError> {
    let value = selector
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'));
    let Some(index) = value else {
        return Err(AppError::invalid_input(format!(
            "sélecteur de stash invalide: {selector:?}"
        )));
    };
    if index.is_empty() || !index.chars().all(|character| character.is_ascii_digit()) {
        return Err(AppError::invalid_input(format!(
            "sélecteur de stash invalide: {selector:?}"
        )));
    }
    Ok(())
}

fn parse_list(input: &str) -> Result<Vec<StashEntry>, String> {
    let mut entries = Vec::new();
    for line in input.lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() < 4 {
            return Err(format!("ligne incomplète: {line:?}"));
        }
        entries.push(StashEntry {
            selector: fields[0].to_owned(),
            sha: fields[1].to_owned(),
            timestamp: fields[2]
                .parse()
                .map_err(|_| "horodatage invalide".to_owned())?,
            message: fields[3].to_owned(),
        });
    }
    Ok(entries)
}

fn join_output(stdout: String, stderr: String) -> String {
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_selectors() {
        assert!(validate_selector("stash@{0}").is_ok());
        assert!(validate_selector("stash@{12}").is_ok());
        assert!(validate_selector("stash@{x}").is_err());
        assert!(validate_selector("--all").is_err());
        assert!(validate_selector("refs/stash").is_err());
    }

    #[test]
    fn parses_stash_lines() {
        let entries =
            parse_list("stash@{0}\u{1f}abcdef\u{1f}1700000000\u{1f}WIP on main: message\n")
                .expect("parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].selector, "stash@{0}");
        assert_eq!(entries[0].sha, "abcdef");
        assert_eq!(entries[0].message, "WIP on main: message");
    }
}
