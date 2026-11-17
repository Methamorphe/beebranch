//! Explicit branch-to-branch integration used by drag and drop.
//!
//! Dropping branch `source` onto branch `target` means:
//! - merge: check out `target`, then merge `source` into it;
//! - rebase: check out `source`, then rebase `source` onto `target`.
//!
//! Either side may be a remote-tracking ref (`refs/remotes/upstream/main`).
//! The branch that would be checked out — the merge target, or the rebase
//! source — must be a local branch. Merging into a remote-tracking ref is
//! refused here; the caller creates or selects the local branch that
//! represents it, then pushes that branch back.
//!
//! The preview performs no mutation and reports every blocking reason. A merge
//! starts by stashing tracked changes (`git stash push`) so the checkout and
//! the merge never refuse on a dirty worktree; the stash is popped as soon as
//! the merge allows it, exactly like the benchmark client's automatic stash. A rebase
//! still refuses tracked changes. The start command also refuses another
//! in-progress operation, a branch already checked out in another worktree, and
//! identical endpoints.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory, InProgressOperation, RepoState};
use serde::{Deserialize, Serialize};

use crate::branches::{self, BranchComparison};
use crate::discover::discover;
use crate::history::{self, HistoryOutcome, MergeFastForward};
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
    /// Whether the operation checked out its working branch (source for rebase).
    /// The field name is retained for IPC compatibility.
    pub checked_out_target: bool,
    pub original_branch: Option<String>,
    /// `Some` when tracked changes were stashed for the integration.
    pub auto_stash: Option<AutoStashOutcome>,
    pub outcome: HistoryOutcome,
}

/// A local branch or a remote-tracking ref that names a real branch.
fn is_endpoint(entry: &crate::refs::RefEntry) -> bool {
    matches!(entry.kind, RefKind::Branch | RefKind::RemoteBranch) && entry.symref.is_none()
}

/// Revision Git should receive. A remote-tracking ref is passed in full so
/// `upstream/main` cannot be read as a local branch of that name.
fn git_revision(entry: &crate::refs::RefEntry) -> String {
    if entry.kind == RefKind::RemoteBranch {
        entry.full_name.clone()
    } else {
        entry.name.clone()
    }
}

/// Resolve `name` to a local branch or a remote-tracking ref.
///
/// A full ref (`refs/heads/…`, `refs/remotes/…`) matches that ref only. A
/// short name prefers the local branch, then a single remote-tracking ref.
fn resolve_endpoint<'a>(
    refs: &'a crate::refs::RefsSnapshot,
    name: &str,
) -> Option<&'a crate::refs::RefEntry> {
    if let Some(entry) = refs
        .entries
        .iter()
        .find(|entry| entry.full_name == name && is_endpoint(entry))
    {
        return Some(entry);
    }
    if name.starts_with("refs/") {
        return None;
    }
    refs.entries
        .iter()
        .find(|entry| entry.kind == RefKind::Branch && entry.name == name)
        .or_else(|| {
            refs.entries.iter().find(|entry| {
                entry.kind == RefKind::RemoteBranch && entry.symref.is_none() && entry.name == name
            })
        })
}

fn missing_endpoint(code: &'static str, name: &str) -> AppError {
    let (role, param) = if code == "branch.source_missing" {
        ("source", "source")
    } else {
        ("cible", "target")
    };
    AppError::new(
        code,
        ErrorCategory::Input,
        format!("La branche {role} {name} n'existe pas."),
    )
    .with_param(param, name)
    .with_remediation(
        "Rafraîchissez la liste des branches : elle a peut-être été renommée ou supprimée.",
    )
}

/// Compute the preview without mutating the repository.
pub fn preview(
    runner: &GitRunner,
    worktree: &Path,
    source: &str,
    target: &str,
    mode: IntegrationMode,
) -> Result<BranchIntegrationPreview, AppError> {
    if !source.starts_with("refs/") {
        branches::validate_branch_name(runner, worktree, source)?;
    }
    if !target.starts_with("refs/") {
        branches::validate_branch_name(runner, worktree, target)?;
    }
    let refs = read_refs(runner, worktree)?;
    let source_entry = resolve_endpoint(&refs, source)
        .ok_or_else(|| missing_endpoint("branch.source_missing", source))?;
    let target_entry = resolve_endpoint(&refs, target)
        .ok_or_else(|| missing_endpoint("branch.target_missing", target))?;
    let source_revision = git_revision(source_entry);
    let target_revision = git_revision(target_entry);

    let comparison = branches::compare(runner, worktree, &target_revision, &source_revision)?;
    let status = read_status(runner, worktree, Some(1))?;
    let discovery = discover(runner, worktree)?;
    let detected = detect(runner, &discovery, Some(1))?;
    let current_branch = status
        .branch
        .head
        .clone()
        .filter(|_| !status.branch.detached);
    let updates_local = match mode {
        IntegrationMode::Merge => target_entry.kind == RefKind::Branch,
        IntegrationMode::Rebase => source_entry.kind == RefKind::Branch,
    };
    // Checkout always uses the local short name. A remote-tracking ref is not
    // a branch that can be checked out; that case is refused below.
    let branch_to_update = match mode {
        IntegrationMode::Merge => target_entry.name.as_str(),
        IntegrationMode::Rebase => source_entry.name.as_str(),
    };
    let canonical_worktree =
        std::fs::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let checked_out_elsewhere = worktree::list(runner, worktree, false)?
        .entries
        .iter()
        .find(|entry| {
            entry.branch.as_deref() == Some(branch_to_update)
                && std::fs::canonicalize(&entry.path)
                    .map(|path| path != canonical_worktree)
                    .unwrap_or(false)
        })
        .map(|entry| entry.path.clone());

    let dirty = status.counts.is_dirty();
    let tracked_changes = status.counts.staged > 0 || status.counts.unstaged > 0;
    let operation = detected.state.operation;
    let remote_blocks = if updates_local {
        None
    } else {
        Some(match mode {
            IntegrationMode::Merge => format!(
                "La cible {} est une branche distante. Fusionnez dans la branche locale qui la suit, ou créez-la, puis poussez cette branche.",
                target_entry.name
            ),
            IntegrationMode::Rebase => format!(
                "La source {} est une branche distante et ne peut pas être réécrite.",
                source_entry.name
            ),
        })
    };
    let blocked_reason = if source_entry.full_name == target_entry.full_name {
        Some("La source et la cible sont la même branche.".to_owned())
    } else if let Some(reason) = remote_blocks {
        Some(reason)
    } else if operation.is_some() {
        Some("Une opération Git est déjà en cours.".to_owned())
    } else if !detected.state.conflicts.is_empty() {
        Some("Le dépôt contient des conflits non résolus.".to_owned())
    } else if tracked_changes && mode == IntegrationMode::Rebase {
        Some("Des modifications locales empêchent le rebase.".to_owned())
    } else if let Some(path) = &checked_out_elsewhere {
        Some(format!(
            "La branche à modifier est déjà extraite dans le worktree {path}."
        ))
    } else if status.branch.detached {
        Some("HEAD est détaché ; basculez sur une branche.".to_owned())
    } else {
        None
    };

    Ok(BranchIntegrationPreview {
        source: source_revision,
        target: target_revision,
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
        requires_checkout: updates_local && current_branch.as_deref() != Some(branch_to_update),
        worktree_dirty: dirty,
        stash_required: tracked_changes && mode == IntegrationMode::Merge,
        checked_out_elsewhere,
        operation,
        applicable: blocked_reason.is_none(),
        blocked_reason,
    })
}

/// Merge `source` into `target`, or rebase `source` onto `target`.
///
/// Tracked changes are stashed before the checkout and popped once the merge
/// completes. The stash is left in place when the merge pauses on conflicts or
/// when the pop itself conflicts, and the outcome says so.
///
/// `fast_forward` only applies to a merge: it selects `--ff-only`, `--ff` or
/// `--no-ff`. `Only` refuses before touching the repository when the target
/// cannot fast-forward, so the caller gets a typed reason instead of an
/// unexpected merge commit.
pub fn start(
    runner: &GitRunner,
    worktree: &Path,
    source: &str,
    target: &str,
    mode: IntegrationMode,
    fast_forward: MergeFastForward,
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
    if mode == IntegrationMode::Merge
        && fast_forward == MergeFastForward::Only
        && preview.behind > 0
    {
        return Err(merge_not_fast_forward(&preview));
    }
    let original_branch = preview.current_branch.clone();
    let source_revision = preview.source.clone();
    let target_revision = preview.target.clone();
    let stashed = if preview.stash_required {
        let message = auto_stash_message(mode, &source_revision, &target_revision);
        Some(stash_worktree(runner, worktree, &message)?)
    } else {
        None
    };

    // The preview stored the local short name on the side that is checked out
    // (merge target, rebase source). The other side may be a remote-tracking ref.
    let branch_to_update = match mode {
        IntegrationMode::Merge => target_revision.clone(),
        IntegrationMode::Rebase => source_revision.clone(),
    };
    let mut checked_out = false;
    if preview.requires_checkout {
        if let Err(error) = branches::checkout(runner, worktree, Some(&branch_to_update), None) {
            return Err(restore_stash_on_failure(runner, worktree, error, &stashed));
        }
        checked_out = true;
    }
    let result = match mode {
        IntegrationMode::Merge => history::merge(runner, worktree, &source_revision, fast_forward),
        IntegrationMode::Rebase => history::rebase(runner, worktree, &target_revision),
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
            // The target may have moved between the preview and the merge
            // (concurrent fetch or commit). Git then refuses with the generic
            // pull wording; report the merge-specific reason instead.
            let error = if mode == IntegrationMode::Merge
                && fast_forward == MergeFastForward::Only
                && error.code == "git.pull_not_fast_forward"
            {
                merge_not_fast_forward(&preview)
            } else {
                error
            };
            let error = restore_stash_on_failure(runner, worktree, error, &stashed);
            if checked_out {
                let detail = error.detail.clone().unwrap_or_default();
                Err(error.with_detail(format!(
                    "{detail} ; le dépôt est maintenant sur la branche {branch_to_update}."
                )))
            } else {
                Err(error)
            }
        }
    }
}

/// Typed refusal for a requested fast-forward that the target cannot honour.
fn merge_not_fast_forward(preview: &BranchIntegrationPreview) -> AppError {
    AppError::new(
        "git.merge_not_fast_forward",
        ErrorCategory::GitState,
        format!(
            "L'avance rapide de {} vers {} est impossible : {} possède {} commit(s) absents de {}.",
            preview.target, preview.source, preview.target, preview.behind, preview.source
        ),
    )
    .with_detail(format!("ahead={} behind={}", preview.ahead, preview.behind))
    .with_remediation("Choisissez un commit de fusion, ou rebasez la branche source sur la cible.")
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
    stash::create(runner, worktree, message, false, &[])?;
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
