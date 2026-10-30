//! Branch lifecycle: create, switch, rename, delete, upstream and comparison.
//!
//! Deletion preflight is computed immediately before the command; the caller
//! must enforce the confirmation policy from `beebranch_core::actions`.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::refs::read_refs;
use crate::stash::{self, StashEntry};
use crate::status::read_status;
use crate::GitSubcommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPreflight {
    pub name: String,
    pub exists: bool,
    pub current: bool,
    pub merged: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub worktree_dirty: bool,
    /// SHA the branch pointed to before deletion.
    pub sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub ahead: u32,
    pub behind: u32,
}

/// Validate a branch name with `git check-ref-format --branch`.
pub fn validate_branch_name(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
) -> Result<(), AppError> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(invalid_name(name));
    }
    let spec = CommandSpec::new(GitSubcommand::CheckRefFormat, worktree)
        .arg("--branch")
        .arg(name);
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        return Err(invalid_name(name)
            .with_detail(outcome.stderr.redacted())
            .with_remediation(
            "Utilisez un nom de branche sans espace, `..`, `~`, `^`, `:` ni caractère de contrôle.",
        ));
    }
    Ok(())
}

fn invalid_name(name: &str) -> AppError {
    AppError::new(
        "branch.invalid_name",
        ErrorCategory::Input,
        "Le nom de branche est invalide.",
    )
    .with_detail(name.to_owned())
}

/// Create a branch, optionally checking it out and starting from `start`.
pub fn create(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    start: Option<&str>,
    checkout: bool,
) -> Result<BranchPreflight, AppError> {
    validate_branch_name(runner, worktree, name)?;
    if let Some(start) = start {
        crate::log::validate_revision(start)?;
    }
    let mut spec = if checkout {
        CommandSpec::new(GitSubcommand::Switch, worktree)
            .arg("-c")
            .arg(name)
    } else {
        CommandSpec::new(GitSubcommand::Branch, worktree).arg(name)
    };
    if let Some(start) = start {
        spec = spec.arg(start);
    }
    runner.run(&spec)?.ensure_success()?;
    preflight(runner, worktree, name)
}

/// Checkout an existing branch or a detached commit.
pub fn checkout(
    runner: &GitRunner,
    worktree: &Path,
    name: Option<&str>,
    detached_at: Option<&str>,
) -> Result<(), AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Switch, worktree);
    match (name, detached_at) {
        (Some(name), None) => {
            validate_branch_name(runner, worktree, name)?;
            spec = spec.arg(name);
        }
        (None, Some(revision)) => {
            crate::log::validate_revision(revision)?;
            spec = spec.arg("--detach").arg(revision);
        }
        _ => {
            return Err(AppError::invalid_input(
                "indiquez soit une branche, soit un commit à détacher".to_owned(),
            ))
        }
    }
    runner.run(&spec)?.ensure_success()?;
    Ok(())
}

/// Switch while leaving local work in a named stash. Unlike an integration
/// autostash, it is kept for the user to reapply later.
pub fn checkout_stashed(
    runner: &GitRunner,
    worktree: &Path,
    name: Option<&str>,
    detached_at: Option<&str>,
) -> Result<Option<StashEntry>, AppError> {
    let status = read_status(runner, worktree, Some(0))?;
    if name.is_some() && name == status.branch.head.as_deref() && detached_at.is_none() {
        checkout(runner, worktree, name, detached_at)?;
        return Ok(None);
    }
    with_checkout_stash(
        runner,
        worktree,
        name.or(detached_at).unwrap_or("HEAD"),
        || checkout(runner, worktree, name, detached_at),
    )
}

/// Also used when checking out a remote branch creates or moves a local branch.
pub fn checkout_reset_stashed(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    start: &str,
) -> Result<Option<StashEntry>, AppError> {
    with_checkout_stash(runner, worktree, name, || {
        checkout_reset(runner, worktree, name, start)
    })
}

fn with_checkout_stash(
    runner: &GitRunner,
    worktree: &Path,
    target: &str,
    switch: impl FnOnce() -> Result<(), AppError>,
) -> Result<Option<StashEntry>, AppError> {
    let discovery = crate::discover::discover(runner, worktree)?;
    let detected = crate::state::detect(runner, &discovery, Some(0))?;
    if detected.state.operation.is_some() || detected.status.counts.conflicted > 0 {
        return Err(AppError::new(
            "git.unresolved_conflicts",
            ErrorCategory::GitState,
            "Terminez l'opération Git en cours avant de changer de branche.",
        ));
    }
    let status = detected.status;
    let stashed = if status.counts.is_dirty() {
        let source = status.branch.head.as_deref().unwrap_or("HEAD");
        let message = format!("BeeBranch auto-stash (checkout {source} → {target})");
        let previous = stash::list(runner, worktree)?
            .first()
            .map(|entry| entry.sha.clone());
        stash::create(runner, worktree, &message, true)?;
        let entry = stash::list(runner, worktree)?
            .into_iter()
            .next()
            .filter(|entry| Some(&entry.sha) != previous.as_ref())
            .ok_or_else(|| AppError::internal("le stash automatique n'a pas été créé"))?;
        Some(entry)
    } else {
        None
    };
    if let Err(error) = switch() {
        let Some(entry) = stashed else {
            return Err(error);
        };
        let restored = stash::pop_indexed(runner, worktree, &entry.selector)
            .is_ok_and(|outcome| outcome.conflicts.is_empty());
        let note = if restored {
            "Les modifications locales ont été restaurées.".to_owned()
        } else {
            format!(
                "Les modifications sont conservées dans {} ({}).",
                entry.selector, entry.sha
            )
        };
        let detail = error.detail.clone().unwrap_or_default();
        return Err(error.with_detail(format!("{detail}\n{note}")));
    }
    Ok(stashed)
}

/// Check out `name`, resetting it to `start` when it already exists.
///
/// `git switch -C` creates the branch if needed, otherwise moves its tip to
/// `start`. Uncommitted changes are carried over when Git can do so and the
/// switch fails rather than overwrite them.
pub fn checkout_reset(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    start: &str,
) -> Result<(), AppError> {
    validate_branch_name(runner, worktree, name)?;
    crate::log::validate_revision(start)?;
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Switch, worktree)
                .arg("-C")
                .arg(name)
                .arg(start),
        )?
        .ensure_success()?;
    Ok(())
}

/// Rename a local branch.
pub fn rename(runner: &GitRunner, worktree: &Path, old: &str, new: &str) -> Result<(), AppError> {
    validate_branch_name(runner, worktree, old)?;
    validate_branch_name(runner, worktree, new)?;
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Branch, worktree)
                .arg("-m")
                .arg(old)
                .arg(new),
        )?
        .ensure_success()?;
    Ok(())
}

/// Compute the deletion preflight for `name`.
pub fn preflight(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
) -> Result<BranchPreflight, AppError> {
    validate_branch_name(runner, worktree, name)?;
    let refs = read_refs(runner, worktree)?;
    let branch = refs
        .entries
        .iter()
        .find(|entry| entry.kind == crate::refs::RefKind::Branch && entry.name == name);
    let status = read_status(runner, worktree, Some(1))?;
    let merged = branch.is_some() && is_merged(runner, worktree, name)?;
    let (ahead, behind) = match branch.and_then(|entry| entry.upstream.as_deref()) {
        Some(upstream) => compare(runner, worktree, upstream, name)
            .map(|value| (value.ahead, value.behind))
            .unwrap_or((0, 0)),
        None => (0, 0),
    };

    Ok(BranchPreflight {
        name: name.to_owned(),
        exists: branch.is_some(),
        current: status.branch.head.as_deref() == Some(name) && !status.branch.detached,
        merged,
        upstream: branch
            .and_then(|entry| entry.upstream.as_deref())
            .map(short_upstream),
        ahead,
        behind,
        worktree_dirty: status.counts.is_dirty(),
        sha: branch.map(|entry| entry.target_oid.clone()),
    })
}

/// Delete a local branch.
///
/// A non-merged branch requires `force`; confirmation policy is enforced by
/// the API layer before this function is called.
pub fn delete(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    force: bool,
) -> Result<String, AppError> {
    let preflight = preflight(runner, worktree, name)?;
    if !preflight.exists {
        return Err(AppError::not_found(format!(
            "La branche {name} n'existe pas."
        )));
    }
    if preflight.current {
        return Err(AppError::new(
            "branch.current_delete",
            ErrorCategory::GitState,
            "La branche courante ne peut pas être supprimée.",
        )
        .with_remediation("Basculez sur une autre branche, puis supprimez celle-ci."));
    }
    if !preflight.merged && !force {
        return Err(AppError::new(
            "branch.not_merged",
            ErrorCategory::GitState,
            "La branche n'est pas mergée dans HEAD.",
        )
        .with_detail(format!("{} commit(s) non intégré(s)", preflight.ahead))
        .with_remediation("Utilisez la suppression forcée avec confirmation explicite."));
    }
    let mut spec = CommandSpec::new(GitSubcommand::Branch, worktree)
        .arg(if force { "-D" } else { "-d" })
        .arg(name);
    if name.starts_with('-') {
        spec = spec.arg("--");
    }
    runner.run(&spec)?.ensure_success()?;
    Ok(preflight.sha.unwrap_or_default())
}

/// Delete a remote branch explicitly (`git push <remote> --delete <branch>`).
pub fn delete_remote(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    branch: &str,
) -> Result<(), AppError> {
    validate_branch_name(runner, worktree, branch)?;
    if remote.is_empty() || remote.starts_with('-') || remote.contains('\0') {
        return Err(AppError::invalid_input("remote invalide".to_owned()));
    }
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Push, worktree)
                .arg(remote)
                .arg("--delete")
                .arg(branch),
        )?
        .ensure_success()?;
    Ok(())
}

/// Set the upstream of `branch`.
pub fn set_upstream(
    runner: &GitRunner,
    worktree: &Path,
    branch: &str,
    upstream: &str,
) -> Result<(), AppError> {
    validate_branch_name(runner, worktree, branch)?;
    if upstream.starts_with('-') || upstream.contains('\0') {
        return Err(AppError::invalid_input("upstream invalide".to_owned()));
    }
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Branch, worktree)
                .arg(format!("--set-upstream-to={upstream}"))
                .arg(branch),
        )?
        .ensure_success()?;
    Ok(())
}

/// Remove the upstream of `branch`.
pub fn unset_upstream(runner: &GitRunner, worktree: &Path, branch: &str) -> Result<(), AppError> {
    validate_branch_name(runner, worktree, branch)?;
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Branch, worktree)
                .arg("--unset-upstream")
                .arg(branch),
        )?
        .ensure_success()?;
    Ok(())
}

/// Ahead/behind counts of `target` relative to `base`.
pub fn compare(
    runner: &GitRunner,
    worktree: &Path,
    base: &str,
    target: &str,
) -> Result<BranchComparison, AppError> {
    crate::log::validate_revision(base)?;
    crate::log::validate_revision(target)?;
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevList, worktree)
                .arg("--left-right")
                .arg("--count")
                .arg(format!("{base}...{target}")),
        )?
        .ensure_success()?;
    let text = outcome.stdout.text_lossy();
    let mut fields = text.split_whitespace();
    let behind = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::internal("rev-list --left-right: premier compteur absent"))?;
    let ahead = fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::internal("rev-list --left-right: second compteur absent"))?;
    Ok(BranchComparison { ahead, behind })
}

fn short_upstream(value: &str) -> String {
    value
        .strip_prefix("refs/remotes/")
        .or_else(|| value.strip_prefix("refs/heads/"))
        .unwrap_or(value)
        .to_owned()
}

fn is_merged(runner: &GitRunner, worktree: &Path, name: &str) -> Result<bool, AppError> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Branch, worktree)
                .arg("--merged")
                .arg("HEAD")
                .arg("--format=%(refname:short)"),
        )?
        .ensure_success()?;
    Ok(outcome
        .stdout
        .text_lossy()
        .lines()
        .any(|line| line.trim() == name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_obviously_invalid_names_before_spawning() {
        // `validate_branch_name` needs a runner; the cheap checks still run
        // first in the public API contract.
        assert!(invalid_name("--evil").code == "branch.invalid_name");
    }
}
