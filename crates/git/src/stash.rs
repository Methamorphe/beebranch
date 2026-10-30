//! Stash lifecycle: create, list, apply, pop and drop.

use std::path::Path;

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};

use crate::commit::{read_changed_files, CommitDetail, StashSnapshot, MAX_FILES};
use crate::log::{CommitIdentity, CommitSummary};
use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::status::read_status;
use crate::GitSubcommand;

/// Reflog selector, commit, parents, author, committer, date and reflog
/// subject. The graph needs the parents to attach the stash to its base and
/// the identities to render the row like any other commit.
pub const STASH_FORMAT: &str = "%gd%x1f%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%gs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Reflog selector (`stash@{0}`).
    pub selector: String,
    pub sha: String,
    /// Parents of the stash commit: the base first, then the index and
    /// untracked snapshots.
    pub parents: Vec<String>,
    pub author: CommitIdentity,
    pub committer: CommitIdentity,
    pub timestamp: i64,
    /// The message the user typed, without the `On <branch>: ` prefix Git
    /// writes in the reflog.
    pub message: String,
}

impl StashEntry {
    /// The stash as a single-parent commit pointing at its base: what the graph
    /// draws, so a stash is one node like in the benchmark client instead of three (the
    /// index and untracked snapshots stay out of the history).
    pub fn summary(&self) -> CommitSummary {
        CommitSummary {
            sha: self.sha.clone(),
            parents: self.parents.first().cloned().into_iter().collect(),
            author: self.author.clone(),
            committer: self.committer.clone(),
            refs: Vec::new(),
            subject: self.message.clone(),
        }
    }
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

/// Find the stash entry whose commit is `sha`, if any.
pub fn find(
    runner: &GitRunner,
    worktree: &Path,
    sha: &str,
) -> Result<Option<StashEntry>, AppError> {
    Ok(list(runner, worktree)?
        .into_iter()
        .find(|entry| entry.sha == sha))
}

/// Read the detail of a stash entry.
///
/// Tracked changes are diffed against the base commit. Untracked files live in
/// a separate root commit (the stash's third parent), so they are listed from
/// that snapshot and carry its revision: the diff viewer would find nothing
/// otherwise.
pub fn read_detail(
    runner: &GitRunner,
    worktree: &Path,
    entry: &StashEntry,
) -> Result<CommitDetail, AppError> {
    let base = entry
        .parents
        .first()
        .ok_or_else(|| AppError::internal("stash sans commit de base"))?;
    let (mut files, mut files_truncated) =
        read_changed_files(runner, worktree, Some(base), &entry.sha, None)?;
    let untracked = entry.parents.get(2).cloned();
    if let Some(snapshot) = untracked.as_deref() {
        let (extra, extra_truncated) =
            read_changed_files(runner, worktree, None, snapshot, Some(snapshot))?;
        files_truncated |= extra_truncated;
        for file in extra {
            if files.len() >= MAX_FILES {
                files_truncated = true;
                break;
            }
            if !files.iter().any(|existing| existing.path == file.path) {
                files.push(file);
            }
        }
    }
    Ok(CommitDetail {
        summary: entry.summary(),
        message: entry.message.clone(),
        files,
        files_truncated,
        message_truncated: false,
        stash: Some(StashSnapshot {
            selector: entry.selector.clone(),
            untracked,
        }),
        signature: None,
    })
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
        if fields.len() < 10 {
            return Err(format!("ligne incomplète: {line:?}"));
        }
        let number = |value: &str| {
            value
                .parse::<i64>()
                .map_err(|_| "horodatage invalide".to_owned())
        };
        entries.push(StashEntry {
            selector: fields[0].to_owned(),
            sha: fields[1].to_owned(),
            parents: fields[2].split_whitespace().map(str::to_owned).collect(),
            author: CommitIdentity {
                name: fields[3].to_owned(),
                email: fields[4].to_owned(),
                timestamp: number(fields[5])?,
            },
            committer: CommitIdentity {
                name: fields[6].to_owned(),
                email: fields[7].to_owned(),
                timestamp: number(fields[8])?,
            },
            timestamp: number(fields[8])?,
            message: stash_subject(fields[9]),
        });
    }
    Ok(entries)
}

/// `git stash list` reports the reflog subject, which prefixes the entry with
/// the branch it was taken on. The benchmark client labels the node with the message the
/// user typed, so the prefix is dropped; the default `WIP on` message also
/// carries the base SHA, which is not part of that message.
fn stash_subject(reflog: &str) -> String {
    if let Some(rest) = reflog.strip_prefix("WIP on ") {
        let Some((_, message)) = rest.split_once(": ") else {
            return reflog.to_owned();
        };
        return match message.split_once(' ') {
            Some((sha, message))
                if (7..=40).contains(&sha.len())
                    && sha.chars().all(|character| character.is_ascii_hexdigit()) =>
            {
                message.to_owned()
            }
            _ => message.to_owned(),
        };
    }
    if let Some(rest) = reflog.strip_prefix("On ") {
        if let Some((_, message)) = rest.split_once(": ") {
            return message.to_owned();
        }
    }
    reflog.to_owned()
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
        let entries = parse_list(
            "stash@{0}\u{1f}abcdef\u{1f}abcdef 0123456\u{1f}Alice\u{1f}alice@example.test\u{1f}1700000001\u{1f}Alice\u{1f}alice@example.test\u{1f}1700000000\u{1f}WIP on main: 0123456 fix graph lanes\n",
        )
        .expect("parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].selector, "stash@{0}");
        assert_eq!(entries[0].sha, "abcdef");
        assert_eq!(entries[0].parents, vec!["abcdef", "0123456"]);
        // The branch and base SHA prefixes belong to the reflog, not the label.
        assert_eq!(entries[0].message, "fix graph lanes");
        assert_eq!(entries[0].timestamp, 1_700_000_000);
        assert_eq!(entries[0].author.name, "Alice");
        let summary = entries[0].summary();
        // The graph node points at the base only: the stash is one commit.
        assert_eq!(summary.parents, vec!["abcdef"]);
        assert_eq!(summary.subject, "fix graph lanes");
        assert!(summary.refs.is_empty());
    }

    #[test]
    fn keeps_an_explicit_stash_message_whole() {
        assert_eq!(
            stash_subject("On develop: BeeBranch stash"),
            "BeeBranch stash"
        );
        assert_eq!(
            stash_subject("On feature/x: WIP: api: retry"),
            "WIP: api: retry"
        );
        // A message that already looks like a SHA keeps its words.
        assert_eq!(
            stash_subject("On main: deadbeef troubleshooting"),
            "deadbeef troubleshooting"
        );
        // `WIP on` without a base SHA still drops only the branch prefix.
        assert_eq!(stash_subject("WIP on main: fix"), "fix");
    }
}
