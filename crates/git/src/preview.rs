//! Read-only summary of an operation, shown before the user confirms it.
//!
//! Everything here runs before the mutation and changes nothing: commit and
//! file counts come from `rev-list`/`diff --numstat`, and conflict risk from
//! `git merge-tree --write-tree`, which builds the merge in memory. A preview
//! is an indication, never a promise: the operation re-checks its own
//! preconditions when it runs.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::discover::RepoDiscovery;
use crate::process::{CommandSpec, GitRunner};
use crate::status::read_status;
use crate::{log, GitSubcommand};

/// Confidence of the conflict prediction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictCheck {
    /// No conflicting path predicted.
    Clean,
    /// At least one path would conflict.
    Conflicts,
    /// The Git version cannot predict conflicts, or the operation has no merge.
    Unavailable,
}

/// Counts and risk shown in the confirmation bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPreview {
    /// Commits the operation brings, replays or removes.
    pub commits: u32,
    /// Commits already on the other side (push/pull).
    pub behind: u32,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub conflict_check: ConflictCheck,
    pub conflicted_files: Vec<String>,
    /// Local changes would be stashed by the operation (checkout).
    pub stashes_local_changes: bool,
    /// The remote branch is unknown: the first push creates it.
    pub upstream_missing: bool,
    /// Set when the operation would refuse to run right now.
    pub blocked_reason: Option<String>,
}

impl Default for OperationPreview {
    fn default() -> Self {
        Self {
            commits: 0,
            behind: 0,
            files: 0,
            additions: 0,
            deletions: 0,
            conflict_check: ConflictCheck::Unavailable,
            conflicted_files: Vec::new(),
            stashes_local_changes: false,
            upstream_missing: false,
            blocked_reason: None,
        }
    }
}

/// Operation described by the confirmation bar.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PreviewOperation {
    Pull {
        remote: String,
        branch: String,
    },
    Push {
        remote: String,
        branch: String,
    },
    Merge {
        source: String,
        target: String,
    },
    Rebase {
        upstream: String,
    },
    CherryPick {
        shas: Vec<String>,
    },
    Reset {
        revision: String,
    },
    StashPop {
        selector: String,
    },
    Checkout {
        name: Option<String>,
        detached_at: Option<String>,
    },
}

/// Compute the summary of `operation` without touching the repository.
///
/// `merge_tree` comes from the detected Git capabilities: below 2.38 the
/// conflict prediction is reported as unavailable instead of failing.
pub fn operation(
    runner: &GitRunner,
    discovery: &RepoDiscovery,
    operation: &PreviewOperation,
    merge_tree: bool,
) -> Result<OperationPreview, AppError> {
    let worktree = discovery.worktree()?;
    let status = read_status(runner, worktree, Some(1))?;
    let dirty_tracked =
        status.counts.staged > 0 || status.counts.unstaged > 0 || status.counts.conflicted > 0;
    let operation_in_progress = crate::state::detect(runner, discovery, Some(1))?
        .state
        .operation
        .is_some();
    let mut preview = OperationPreview::default();

    match operation {
        PreviewOperation::Pull { remote, branch } => {
            validate_remote(remote)?;
            log::validate_revision(branch)?;
            if dirty_tracked {
                preview.blocked_reason = Some(
                    "Des modifications locales empêchent le pull. Committez ou stashez vos modifications."
                        .to_owned(),
                );
            }
            let Some(upstream) = upstream_of(runner, worktree, branch, remote) else {
                preview.upstream_missing = true;
                preview.blocked_reason = Some(format!(
                    "La branche {remote}/{branch} est inconnue : lancez un fetch avant le pull."
                ));
                return Ok(preview);
            };
            preview.commits = count(runner, worktree, &format!("HEAD..{upstream}"))?;
            preview.behind = count(runner, worktree, &format!("{upstream}..HEAD"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &["HEAD...".to_owned() + &upstream])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            predict(
                runner,
                worktree,
                "HEAD",
                &upstream,
                merge_tree,
                &mut preview,
            )?;
        }
        PreviewOperation::Push { remote, branch } => {
            validate_remote(remote)?;
            log::validate_revision(branch)?;
            let upstream =
                resolve_opt(runner, worktree, &format!("refs/remotes/{remote}/{branch}"));
            let Some(upstream) = upstream else {
                preview.upstream_missing = true;
                return Ok(preview);
            };
            preview.commits = count(runner, worktree, &format!("{upstream}..HEAD"))?;
            preview.behind = count(runner, worktree, &format!("HEAD..{upstream}"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &[format!("{upstream}...HEAD")])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            preview.conflict_check = ConflictCheck::Unavailable;
        }
        PreviewOperation::Merge { source, target } => {
            crate::branches::validate_branch_name(runner, worktree, source)?;
            crate::branches::validate_branch_name(runner, worktree, target)?;
            preview.commits = count(runner, worktree, &format!("{target}..{source}"))?;
            preview.behind = count(runner, worktree, &format!("{source}..{target}"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &[format!("{target}...{source}")])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            predict(runner, worktree, target, source, merge_tree, &mut preview)?;
        }
        PreviewOperation::Rebase { upstream } => {
            log::validate_revision(upstream)?;
            if dirty_tracked {
                preview.blocked_reason = Some(
                    "Des modifications locales empêchent le rebase. Committez ou stashez vos modifications."
                        .to_owned(),
                );
            }
            preview.commits = count(runner, worktree, &format!("{upstream}..HEAD"))?;
            preview.behind = count(runner, worktree, &format!("HEAD..{upstream}"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &[format!("{upstream}...HEAD")])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            predict(runner, worktree, upstream, "HEAD", merge_tree, &mut preview)?;
        }
        PreviewOperation::CherryPick { shas } => {
            if shas.len() > 500 {
                return Err(AppError::invalid_input(
                    "trop de commits à appliquer (500 maximum)".to_owned(),
                ));
            }
            preview.commits = shas.len() as u32;
            let mut paths: Vec<String> = Vec::new();
            for sha in shas {
                log::validate_revision(sha)?;
                let (files, additions, deletions) = commit_stats(runner, worktree, sha)?;
                preview.files += files;
                preview.additions += additions;
                preview.deletions += deletions;
                paths.extend(changed_paths(runner, worktree, sha)?);
            }
            // `git cherry-pick` stops at the first conflict; the prediction is
            // computed for the first commit only and labelled as such.
            if let Some(first) = shas.first() {
                predict(runner, worktree, "HEAD", first, merge_tree, &mut preview)?;
            }
            preview.files = paths.len() as u32;
        }
        PreviewOperation::Reset { revision } => {
            log::validate_revision(revision)?;
            preview.commits = count(runner, worktree, &format!("{revision}..HEAD"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &[revision.clone(), "HEAD".to_owned()])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            preview.conflict_check = ConflictCheck::Clean;
        }
        PreviewOperation::StashPop { selector } => {
            let entry = crate::stash::list(runner, worktree)?
                .into_iter()
                .find(|entry| entry.selector == selector.as_str())
                .ok_or_else(|| AppError::not_found(format!("Le stash {selector} n'existe pas.")))?;
            let base = entry
                .parents
                .first()
                .cloned()
                .ok_or_else(|| AppError::internal("stash sans commit de base"))?;
            match diff_stats(runner, worktree, &[base, entry.sha.clone()]) {
                Ok((files, additions, deletions)) => {
                    preview.files = files;
                    preview.additions = additions;
                    preview.deletions = deletions;
                }
                Err(_) => preview.conflict_check = ConflictCheck::Unavailable,
            }
            // A failed merge-tree must not disable the confirming action: Git
            // re-checks conflicts when the pop actually runs.
            if predict(
                runner,
                worktree,
                "HEAD",
                &entry.sha,
                merge_tree,
                &mut preview,
            )
            .is_err()
            {
                preview.conflict_check = ConflictCheck::Unavailable;
                preview.conflicted_files.clear();
            }
        }
        PreviewOperation::Checkout { name, detached_at } => {
            let target = match (name, detached_at) {
                (Some(name), None) => {
                    crate::branches::validate_branch_name(runner, worktree, name)?;
                    resolve_opt(runner, worktree, &format!("refs/heads/{name}")).ok_or_else(
                        || {
                            AppError::new(
                                "branch.not_found",
                                ErrorCategory::Input,
                                "Cette branche n'existe plus.",
                            )
                        },
                    )?
                }
                (None, Some(revision)) => {
                    log::validate_revision(revision)?;
                    resolve(runner, worktree, revision)?
                }
                _ => {
                    return Err(AppError::invalid_input(
                        "cible de checkout invalide".to_owned(),
                    ))
                }
            };
            if operation_in_progress || status.counts.conflicted > 0 {
                preview.blocked_reason = Some(
                    "Terminez l'opération Git en cours avant de changer de branche.".to_owned(),
                );
            }
            preview.commits = count(runner, worktree, &format!("HEAD..{target}"))?;
            preview.behind = count(runner, worktree, &format!("{target}..HEAD"))?;
            let (files, additions, deletions) =
                diff_stats(runner, worktree, &["HEAD".to_owned(), target])?;
            preview.files = files;
            preview.additions = additions;
            preview.deletions = deletions;
            preview.stashes_local_changes = status.counts.is_dirty();
            preview.conflict_check = ConflictCheck::Clean;
        }
    }

    if preview.blocked_reason.is_none() && operation_in_progress {
        preview.blocked_reason = Some("Une opération Git est déjà en cours.".to_owned());
    }
    Ok(preview)
}

fn predict(
    runner: &GitRunner,
    worktree: &Path,
    ours: &str,
    theirs: &str,
    merge_tree: bool,
    preview: &mut OperationPreview,
) -> Result<(), AppError> {
    if !merge_tree {
        preview.conflict_check = ConflictCheck::Unavailable;
        return Ok(());
    }
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::MergeTree, worktree)
            .arg("--write-tree")
            .arg("--name-only")
            .arg("--no-messages")
            .arg("-z")
            .arg(ours)
            .arg(theirs),
    )?;
    match outcome.exit_code() {
        Some(0) => preview.conflict_check = ConflictCheck::Clean,
        Some(1) => {
            // First field is the result tree; the rest are conflicted paths.
            let text = outcome.stdout.text_lossy();
            let mut fields = text.split('\0');
            preview.conflicted_files = fields
                .by_ref()
                .skip(1)
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .collect();
            preview.conflict_check = ConflictCheck::Conflicts;
        }
        _ => {
            return Err(AppError::new(
                "preview.conflicts_failed",
                ErrorCategory::GitExit,
                "La prédiction des conflits a échoué.",
            )
            .with_detail(outcome.stderr.diagnostic()))
        }
    }
    Ok(())
}

fn count(runner: &GitRunner, worktree: &Path, range: &str) -> Result<u32, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::RevList, worktree)
            .arg("--count")
            .arg(range),
    )?;
    let outcome = outcome.ensure_success()?;
    Ok(outcome.stdout.text_lossy().trim().parse().unwrap_or(0))
}

fn diff_stats(
    runner: &GitRunner,
    worktree: &Path,
    revisions: &[String],
) -> Result<(u32, u32, u32), AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Diff, worktree)
        .arg("--numstat")
        .arg("--no-renames");
    for revision in revisions {
        spec = spec.arg(revision);
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    Ok(numstat_totals(&outcome.stdout.text_lossy()))
}

fn commit_stats(
    runner: &GitRunner,
    worktree: &Path,
    sha: &str,
) -> Result<(u32, u32, u32), AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::DiffTree, worktree)
            .arg("--no-commit-id")
            .arg("--numstat")
            .arg("-r")
            .arg("--root")
            .arg("--no-renames")
            .arg(sha),
    )?;
    let outcome = outcome.ensure_success()?;
    Ok(numstat_totals(&outcome.stdout.text_lossy()))
}

fn changed_paths(runner: &GitRunner, worktree: &Path, sha: &str) -> Result<Vec<String>, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::DiffTree, worktree)
            .arg("--no-commit-id")
            .arg("--name-only")
            .arg("-r")
            .arg("--root")
            .arg("--no-renames")
            .arg(sha),
    )?;
    let outcome = outcome.ensure_success()?;
    Ok(outcome
        .stdout
        .text_lossy()
        .lines()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Sum a `--numstat` output: one line per file, `-` for binary content.
fn numstat_totals(text: &str) -> (u32, u32, u32) {
    let mut files = 0;
    let mut additions = 0;
    let mut deletions = 0;
    for line in text.lines() {
        let mut fields = line.splitn(3, '\t');
        let Some(added) = fields.next() else {
            continue;
        };
        let Some(removed) = fields.next() else {
            continue;
        };
        files += 1;
        additions += added.parse::<u32>().unwrap_or(0);
        deletions += removed.parse::<u32>().unwrap_or(0);
    }
    (files, additions, deletions)
}

fn upstream_of(runner: &GitRunner, worktree: &Path, branch: &str, remote: &str) -> Option<String> {
    resolve_opt(runner, worktree, &format!("refs/remotes/{remote}/{branch}"))
        .or_else(|| resolve_opt(runner, worktree, &format!("{branch}@{{upstream}}")))
}

fn resolve(runner: &GitRunner, worktree: &Path, revision: &str) -> Result<String, AppError> {
    resolve_opt(runner, worktree, revision).ok_or_else(|| {
        AppError::new(
            "git.revision_missing",
            ErrorCategory::Input,
            "La révision est introuvable.",
        )
        .with_detail(revision.to_owned())
    })
}

fn resolve_opt(runner: &GitRunner, worktree: &Path, revision: &str) -> Option<String> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, worktree)
                .arg("--verify")
                .arg("--quiet")
                .arg(revision),
        )
        .ok()?;
    outcome
        .success()
        .then(|| outcome.stdout.text_lossy().trim().to_owned())
}

/// Remote name rules already enforced by fetch and push.
fn validate_remote(remote: &str) -> Result<(), AppError> {
    if remote.is_empty()
        || remote.contains('/')
        || remote.contains('\\')
        || remote.contains(' ')
        || remote.starts_with('-')
        || remote == "."
        || remote == ".."
    {
        return Err(AppError::invalid_input("nom de remote invalide".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{numstat_totals, PreviewOperation};

    #[test]
    fn operation_deserializes_from_the_frontend_shape() {
        let checkout: PreviewOperation =
            serde_json::from_str(r#"{"kind":"checkout","name":null,"detachedAt":"abc123"}"#)
                .expect("checkout");
        assert_eq!(
            checkout,
            PreviewOperation::Checkout {
                name: None,
                detached_at: Some("abc123".to_owned())
            }
        );
        let cherry: PreviewOperation =
            serde_json::from_str(r#"{"kind":"cherryPick","shas":["a","b"]}"#).expect("cherry");
        assert_eq!(
            cherry,
            PreviewOperation::CherryPick {
                shas: vec!["a".to_owned(), "b".to_owned()]
            }
        );
    }

    #[test]
    fn numstat_counts_files_and_lines() {
        assert_eq!(
            numstat_totals("1\t1\ta.txt\n3\t0\tb.txt\n-\t-\timage.png\n"),
            (3, 4, 1)
        );
        assert_eq!(numstat_totals(""), (0, 0, 0));
    }
}
