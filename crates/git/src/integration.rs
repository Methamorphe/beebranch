//! Explicit branch-to-branch integration used by drag and drop.
//!
//! Dropping branch `source` onto branch `target` means:
//! - merge: check out `target`, then merge `source` into it;
//! - rebase: check out `target`, then rebase `target` onto `source`.
//!
//! The preview performs no mutation and reports every blocking reason. A merge
//! starts by stashing tracked changes (`git stash push`) so the checkout and
//! the merge never refuse on a dirty worktree; the stash is popped as soon as
//! the merge allows it, exactly like GitKraken's automatic stash. A rebase
//! still refuses tracked changes. The start command also refuses another
//! in-progress operation, a branch already checked out in another worktree, and
//! identical endpoints.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory, InProgressOperation, RepoState};
use serde::{Deserialize, Serialize};

use crate::branches::{self, BranchComparison};
use crate::discover::discover;
use crate::history::{self, HistoryOutcome};
use crate::process::GitRunner;
use crate::refs::{read_refs, RefKind};
use crate::stash::{self, StashEntry};
use crate::state::detect;
use crate::status::read_status;
use crate::worktree;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationMode {
    Merge,
    Rebase,
}

/// Read-only description of what a drop will do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchIntegrationPreview {
    pub source: String,
    pub target: String,
    pub source_sha: String,
    pub target_sha: String,
    pub source_subject: Option<String>,
    pub target_subject: Option<String>,
    pub mode: IntegrationMode,
    /// Commits from source that target does not have.
    pub ahead: u32,
    /// Commits from target that source does not have.
    pub behind: u32,
    pub fast_forward: bool,
    pub current_branch: Option<String>,
    pub requires_checkout: bool,
    pub worktree_dirty: bool,
    /// Tracked changes will be stashed before the merge and popped after it.
    pub stash_required: bool,
    /// Another worktree already has this branch checked out.
    pub checked_out_elsewhere: Option<String>,
    pub operation: Option<InProgressOperation>,
    /// `Some` when the start command would refuse.
    pub blocked_reason: Option<String>,
    /// True when the operation can be started without changing anything.
    pub applicable: bool,
}

/// Automatic stash taken before the integration and restored right after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStashOutcome {
    pub selector: String,
    pub sha: String,
    /// True when the stash was reapplied and removed from the stash list.
    pub popped: bool,
    /// Files left in conflict by the reapplication; the stash is then kept.
    pub conflicts: Vec<String>,
}

impl AutoStashOutcome {
    fn skipped(entry: &StashEntry) -> Self {
        Self {
            selector: entry.selector.clone(),
            sha: entry.sha.clone(),
            popped: false,
            conflicts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchIntegrationOutcome {
    pub preview: BranchIntegrationPreview,
    pub checked_out_target: bool,
    pub original_branch: Option<String>,
    /// `Some` when tracked changes were stashed for the integration.
    pub auto_stash: Option<AutoStashOutcome>,
    pub outcome: HistoryOutcome,
}

/// Compute the preview without mutating the repository.
pub fn preview(
    runner: &GitRunner,
    worktree: &Path,
    source: &str,
    target: &str,
    mode: IntegrationMode,
) -> Result<BranchIntegrationPreview, AppError> {
    branches::validate_branch_name(runner, worktree, source)?;
    branches::validate_branch_name(runner, worktree, target)?;
    let refs = read_refs(runner, worktree)?;
    let find = |name: &str| {
        refs.entries
            .iter()
            .find(|entry| entry.kind == RefKind::Branch && entry.name == name)
    };
    let source_entry = find(source).ok_or_else(|| {
        AppError::new(
            "branch.source_missing",
            ErrorCategory::Input,
            format!("La branche source {source} n'existe pas."),
        )
    })?;
    let target_entry = find(target).ok_or_else(|| {
        AppError::new(
            "branch.target_missing",
            ErrorCategory::Input,
            format!("La branche cible {target} n'existe pas."),
        )
    })?;

    let comparison = branches::compare(runner, worktree, target, source)?;
    let status = read_status(runner, worktree, Some(1))?;
    let discovery = discover(runner, worktree)?;
    let detected = detect(runner, &discovery, Some(1))?;
    let current_branch = status
        .branch
        .head
        .clone()
        .filter(|_| !status.branch.detached);
    let canonical_worktree =
        std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let checked_out_elsewhere = worktree::list(runner, worktree, false)?
        .entries
        .iter()
        .find(|entry| {
            entry.branch.as_deref() == Some(target)
                && std::fs::canonicalize(&entry.path)
                    .map(|path| path != canonical_worktree)
                    .unwrap_or(false)
        })
        .map(|entry| entry.path.clone());

    let dirty = status.counts.is_dirty();
    let tracked_changes = status.counts.staged > 0 || status.counts.unstaged > 0;
    let operation = detected.state.operation;
    let blocked_reason = if source == target {
        Some("La source et la cible sont la même branche.".to_owned())
    } else if operation.is_some() {
        Some("Une opération Git est déjà en cours.".to_owned())
    } else if !detected.state.conflicts.is_empty() {
        Some("Le dépôt contient des conflits non résolus.".to_owned())
    } else if tracked_changes && mode == IntegrationMode::Rebase {
        Some("Des modifications locales empêchent le rebase.".to_owned())
    } else if let Some(path) = &checked_out_elsewhere {
        Some(format!(
            "La branche cible est déjà extraite dans le worktree {path}."
        ))
    } else if status.branch.detached {
        Some("HEAD est détaché ; basculez sur une branche.".to_owned())
    } else {
        None
    };

    Ok(BranchIntegrationPreview {
        source: source.to_owned(),
        target: target.to_owned(),
        source_sha: source_entry.target_oid.clone(),
        target_sha: target_entry.target_oid.clone(),
        source_subject: None,
        target_subject: None,
        mode,
        ahead: comparison.ahead,
        behind: comparison.behind,
        fast_forward: matches!(mode, IntegrationMode::Merge)
            && comparison.behind == 0
            && comparison.ahead > 0,
        current_branch: current_branch.clone(),
        requires_checkout: current_branch.as_deref() != Some(target),
        worktree_dirty: dirty,
        stash_required: tracked_changes && mode == IntegrationMode::Merge,
        checked_out_elsewhere,
        operation,
        applicable: blocked_reason.is_none(),
        blocked_reason,
    })
}

/// Check out `target` and integrate `source` into it.
///
/// Tracked changes are stashed before the checkout and popped once the merge
/// completes. The stash is left in place when the merge pauses on conflicts or
/// when the pop itself conflicts, and the outcome says so.
pub fn start(
    runner: &GitRunner,
    worktree: &Path,
    source: &str,
    target: &str,
    mode: IntegrationMode,
) -> Result<BranchIntegrationOutcome, AppError> {
    let preview = preview(runner, worktree, source, target, mode)?;
    if let Some(reason) = preview.blocked_reason.clone() {
        return Err(AppError::new(
            "branch.integration_blocked",
            ErrorCategory::GitState,
            "L'intégration ne peut pas démarrer.",
        )
        .with_detail(reason)
        .with_remediation("Résolvez la condition signalée puis relancez l'aperçu."));
    }
    let original_branch = preview.current_branch.clone();
    let stashed = if preview.stash_required {
        let message = auto_stash_message(mode, source, target);
        Some(stash_worktree(runner, worktree, &message)?)
    } else {
        None
    };

    let mut checked_out = false;
    if preview.requires_checkout {
        if let Err(error) = branches::checkout(runner, worktree, Some(target), None) {
            return Err(restore_stash_on_failure(runner, worktree, error, &stashed));
        }
        checked_out = true;
    }
    let result = match mode {
        IntegrationMode::Merge => history::merge(runner, worktree, source, false),
        IntegrationMode::Rebase => history::rebase(runner, worktree, source),
    };
    match result {
        Ok(mut outcome) => {
            let auto_stash = match &stashed {
                None => None,
                // The merge paused on conflicts: the index cannot receive the
                // stash yet, so it stays in the stash list untouched.
                Some(entry) if outcome.state.operation.is_some() => {
                    Some(AutoStashOutcome::skipped(entry))
                }
                Some(entry) => {
                    let applied = reapply_stash(runner, worktree, entry);
                    if let Some(state) = current_state(runner, worktree) {
                        outcome.state = state;
                    }
                    Some(applied)
                }
            };
            Ok(BranchIntegrationOutcome {
                preview,
                checked_out_target: checked_out,
                original_branch,
                auto_stash,
                outcome,
            })
        }
        Err(error) => {
            let error = restore_stash_on_failure(runner, worktree, error, &stashed);
            if checked_out {
                let detail = error.detail.clone().unwrap_or_default();
                Err(error.with_detail(format!(
                    "{detail} ; le dépôt est maintenant sur la branche {target}."
                )))
            } else {
                Err(error)
            }
        }
    }
}

fn auto_stash_message(mode: IntegrationMode, source: &str, target: &str) -> String {
    let verb = match mode {
        IntegrationMode::Merge => "merge",
        IntegrationMode::Rebase => "rebase",
    };
    format!("BeeBranch auto-stash ({verb} {source} → {target})")
}

/// Stash tracked changes and return the freshly created entry.
fn stash_worktree(
    runner: &GitRunner,
    worktree: &Path,
    message: &str,
) -> Result<StashEntry, AppError> {
    stash::create(runner, worktree, message, false)?;
    stash::list(runner, worktree)?
        .into_iter()
        .next()
        .filter(|entry| entry.message.ends_with(message))
        .ok_or_else(|| AppError::internal("le stash automatique est introuvable en tête de liste"))
}

/// Pop the automatic stash. A refusal or a conflict is reported, never raised:
/// the integration itself already succeeded and the stash stays recoverable.
fn reapply_stash(runner: &GitRunner, worktree: &Path, entry: &StashEntry) -> AutoStashOutcome {
    let popped = stash::pop_indexed(runner, worktree, &entry.selector)
        .map(|outcome| (outcome.conflicts.is_empty(), outcome.conflicts))
        .unwrap_or((false, Vec::new()));
    AutoStashOutcome {
        selector: entry.selector.clone(),
        sha: entry.sha.clone(),
        popped: popped.0,
        conflicts: popped.1,
    }
}

/// Put the stashed changes back after a failure, and say where they are when
/// Git refuses.
fn restore_stash_on_failure(
    runner: &GitRunner,
    worktree: &Path,
    error: AppError,
    stashed: &Option<StashEntry>,
) -> AppError {
    let Some(entry) = stashed else {
        return error;
    };
    let note = match stash::pop_indexed(runner, worktree, &entry.selector) {
        Ok(outcome) if outcome.conflicts.is_empty() => {
            "les modifications locales ont été restaurées".to_owned()
        }
        Ok(outcome) => format!(
            "le stash {} a été réappliqué avec des conflits ({}) ; résolvez-les, il est conservé",
            entry.selector,
            outcome.conflicts.join(", ")
        ),
        Err(_) => format!(
            "le stash {} ({}) est conservé ; réappliquez-le avec « Stash pop »",
            entry.selector, entry.sha
        ),
    };
    let detail = error.detail.clone().unwrap_or_default();
    let detail = if detail.trim().is_empty() {
        note
    } else {
        format!("{detail} ; {note}")
    };
    error.with_detail(detail)
}

fn current_state(runner: &GitRunner, worktree: &Path) -> Option<RepoState> {
    let discovery = discover(runner, worktree).ok()?;
    detect(runner, &discovery, Some(1))
        .ok()
        .map(|detected| detected.state)
}

/// Number of commits and fast-forward state are also exposed separately for
/// tests and compact UI badges.
pub fn comparison(
    runner: &GitRunner,
    worktree: &Path,
    target: &str,
    source: &str,
) -> Result<BranchComparison, AppError> {
    branches::compare(runner, worktree, target, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandSpec, GitSubcommand, StdinMode};

    fn fixture() -> (tempfile::TempDir, GitRunner) {
        let dir = tempfile::tempdir().expect("dir");
        let runner = GitRunner::detect().expect("git");
        let run = |args: &[&str]| {
            runner
                .run(&CommandSpec::new(GitSubcommand::Init, dir.path()).args(args.iter().copied()))
                .expect("init");
        };
        run(&["--quiet"]);
        for (key, value) in [("user.email", "a@b.c"), ("user.name", "Alice")] {
            runner
                .run(
                    &CommandSpec::new(GitSubcommand::Config, dir.path())
                        .arg(key)
                        .arg(value),
                )
                .expect("config");
        }
        (dir, runner)
    }

    fn commit(runner: &GitRunner, dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).expect("write");
        runner
            .run(&CommandSpec::new(GitSubcommand::Add, dir).arg("-A"))
            .expect("add");
        runner
            .run(
                &CommandSpec::new(GitSubcommand::Commit, dir)
                    .arg("-F")
                    .arg("-")
                    .stdin(StdinMode::Bytes(format!("{name}\n").into_bytes())),
            )
            .expect("commit");
    }

    #[test]
    fn preview_marks_a_dirty_worktree_for_stashing_and_refuses_identical_branches() {
        let (dir, runner) = fixture();
        commit(&runner, dir.path(), "a.txt", "one\n");
        runner
            .run(&CommandSpec::new(GitSubcommand::Branch, dir.path()).arg("feature"))
            .expect("branch");
        std::fs::write(dir.path().join("a.txt"), "dirty\n").expect("write");
        let outcome = runner
            .run(
                &CommandSpec::new(GitSubcommand::RevParse, dir.path())
                    .arg("--abbrev-ref")
                    .arg("HEAD"),
            )
            .expect("branch");
        let current = outcome.stdout.text_lossy().trim().to_owned();
        let dirty_preview = preview(
            &runner,
            dir.path(),
            "feature",
            &current,
            IntegrationMode::Merge,
        )
        .expect("preview");
        assert!(dirty_preview.applicable);
        assert!(dirty_preview.worktree_dirty);
        assert!(dirty_preview.stash_required);
        let dirty_rebase = preview(
            &runner,
            dir.path(),
            "feature",
            &current,
            IntegrationMode::Rebase,
        )
        .expect("preview rebase");
        assert!(!dirty_rebase.applicable);
        let same = preview(
            &runner,
            dir.path(),
            "feature",
            "feature",
            IntegrationMode::Merge,
        )
        .expect("preview same");
        assert!(!same.applicable);
    }
}
