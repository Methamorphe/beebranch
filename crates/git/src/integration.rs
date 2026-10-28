//! Explicit branch-to-branch integration used by drag and drop.
//!
//! Dropping branch `source` onto branch `target` means:
//! - merge: check out `target`, then merge `source` into it;
//! - rebase: check out `target`, then rebase `target` onto `source`.
//!
//! The preview performs no mutation and reports every blocking reason. The
//! start command refuses a dirty worktree, another in-progress operation, a
//! branch already checked out in another worktree, and identical endpoints.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory, InProgressOperation};
use serde::{Deserialize, Serialize};

use crate::branches::{self, BranchComparison};
use crate::discover::discover;
use crate::history::{self, HistoryOutcome};
use crate::process::GitRunner;
use crate::refs::{read_refs, RefKind};
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
    /// Another worktree already has this branch checked out.
    pub checked_out_elsewhere: Option<String>,
    pub operation: Option<InProgressOperation>,
    /// `Some` when the start command would refuse.
    pub blocked_reason: Option<String>,
    /// True when the operation can be started without changing anything.
    pub applicable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchIntegrationOutcome {
    pub preview: BranchIntegrationPreview,
    pub checked_out_target: bool,
    pub original_branch: Option<String>,
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
    let operation = detected.state.operation;
    let blocked_reason = if source == target {
        Some("La source et la cible sont la même branche.".to_owned())
    } else if dirty {
        Some("Le worktree contient des modifications non commitées.".to_owned())
    } else if operation.is_some() {
        Some("Une opération Git est déjà en cours.".to_owned())
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
        checked_out_elsewhere,
        operation,
        applicable: blocked_reason.is_none(),
        blocked_reason,
    })
}

/// Check out `target` and integrate `source` into it.
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
    let mut checked_out = false;
    if preview.requires_checkout {
        branches::checkout(runner, worktree, Some(target), None)?;
        checked_out = true;
    }
    let result = match mode {
        IntegrationMode::Merge => history::merge(runner, worktree, source, false),
        IntegrationMode::Rebase => history::rebase(runner, worktree, source),
    };
    match result {
        Ok(outcome) => Ok(BranchIntegrationOutcome {
            preview,
            checked_out_target: checked_out,
            original_branch,
            outcome,
        }),
        Err(error) => {
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
    fn preview_refuses_a_dirty_worktree_and_identical_branches() {
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
        assert!(!dirty_preview.applicable);
        assert!(dirty_preview.worktree_dirty);
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
