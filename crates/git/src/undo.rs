//! Explicit, Git-only undo/redo.
//!
//! This module owns the reversibility matrix of `docs/04-undo-redo.md`:
//! fingerprints of the observable repository state, typed inverse actions and
//! step-by-step restoration. It never copies working-tree files: every inverse
//! is a Git command (`reset`, `read-tree`, `update-ref`, `switch`, `stash`,
//! `worktree`, `remote`, `tag`).
//!
//! Irreversible actions (discard, `reset --hard`, stash drop/apply/pop, fetch,
//! push, submodule update) are deliberately absent from [`ReversibleAction`]:
//! they cannot be recorded and must be presented as irreversible by the UI.
#![allow(clippy::result_large_err)] // the error is shown verbatim in the recovery panel

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use beebranch_core::{AppError, ErrorCategory, InProgressOperation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::discover::RepoDiscovery;
use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::state::detect;
use crate::GitSubcommand;

/// Maximum number of records kept per repository.
pub const UNDO_STACK_LIMIT: usize = 50;

/// Observable state used to refuse an undo that would overwrite user work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    /// Current branch name, `None` when detached or unborn.
    pub head_branch: Option<String>,
    /// `HEAD` commit, `None` on an unborn branch.
    pub head_sha: Option<String>,
    pub detached: bool,
    /// `git write-tree` of the index; `None` when the index is unmerged.
    pub index_tree: Option<String>,
    /// SHA-256 of `git status --porcelain=v2 -z`.
    pub status_hash: String,
    pub operation: Option<InProgressOperation>,
    /// Touched refs, with `absent` when they did not exist.
    pub refs: BTreeMap<String, String>,
    /// Hashes of explicitly affected working-tree files.
    pub affected_files: BTreeMap<String, String>,
}

impl Fingerprint {
    /// Explain the first meaningful divergence between two fingerprints.
    pub fn compare(expected: &Self, current: &Self) -> Result<(), String> {
        if expected.head_branch != current.head_branch
            || expected.head_sha != current.head_sha
            || expected.detached != current.detached
        {
            return Err(format!(
                "HEAD a changé (attendu {:?}/{:?}, actuel {:?}/{:?}).",
                expected.head_branch,
                expected.head_sha.as_deref().unwrap_or("aucun"),
                current.head_branch,
                current.head_sha.as_deref().unwrap_or("aucun")
            ));
        }
        if expected.index_tree != current.index_tree {
            return Err("L'index a changé depuis l'opération.".to_owned());
        }
        if expected.status_hash != current.status_hash {
            return Err("Le worktree a changé depuis l'opération.".to_owned());
        }
        if expected.operation != current.operation {
            return Err("Une autre opération Git est en cours.".to_owned());
        }
        for (reference, value) in &expected.refs {
            if current.refs.get(reference) != Some(value) {
                return Err(format!(
                    "La référence `{reference}` a changé (attendu {value}, actuel {}).",
                    current
                        .refs
                        .get(reference)
                        .cloned()
                        .unwrap_or_else(|| "absente".to_owned())
                ));
            }
        }
        for (path, value) in &expected.affected_files {
            if current.affected_files.get(path) != Some(value) {
                return Err(format!("Le fichier `{path}` a changé depuis l'opération."));
            }
        }
        Ok(())
    }
}

/// Head target described by a fingerprint.
pub fn head_target(fingerprint: &Fingerprint) -> HeadTarget {
    match (&fingerprint.head_branch, &fingerprint.head_sha) {
        (Some(name), _) => HeadTarget::Branch { name: name.clone() },
        (None, Some(sha)) => HeadTarget::Detached { sha: sha.clone() },
        (None, None) => HeadTarget::Unborn {
            branch: fingerprint.head_branch.clone(),
        },
    }
}

/// Action that restores a fingerprint's HEAD and index.
pub fn restore_to(fingerprint: &Fingerprint, mode: RestoreMode) -> ReversibleAction {
    ReversibleAction::RestoreHead {
        target: head_target(fingerprint),
        sha: fingerprint.head_sha.clone(),
        mode,
        index_tree: fingerprint.index_tree.clone(),
    }
}

/// Capture the current fingerprint.
///
/// `touched_refs` are full ref names; `affected_files` are worktree-relative
/// paths. Both lists are bounded by the caller.
pub fn capture(
    runner: &GitRunner,
    discovery: &RepoDiscovery,
    touched_refs: &[String],
    affected_files: &[String],
) -> Result<Fingerprint, AppError> {
    let worktree = discovery.worktree()?;
    let head_sha = rev_parse(runner, worktree, "HEAD").ok();
    let head_branch = current_head(runner, worktree)
        .and_then(|(kind, value)| (kind == "branch").then_some(value))
        .filter(|_| head_sha.is_some());
    let detached = head_sha.is_some() && head_branch.is_none();
    let index_tree = write_tree(runner, worktree).ok();
    let status_hash = status_hash(runner, worktree)?;
    let operation = detect(runner, discovery, Some(1))
        .map(|detected| detected.state.operation)
        .unwrap_or(None);

    let mut refs = BTreeMap::new();
    for reference in touched_refs {
        let value = rev_parse(runner, worktree, reference).unwrap_or_else(|_| "absent".to_owned());
        refs.insert(reference.clone(), value);
    }

    let mut files = BTreeMap::new();
    for path in affected_files {
        files.insert(path.clone(), hash_file(worktree.join(path))?);
    }

    Ok(Fingerprint {
        head_branch,
        head_sha,
        detached,
        index_tree,
        status_hash,
        operation,
        refs,
        affected_files: files,
    })
}

/// Refuse restoration when a Git lock exists or an operation is in progress
/// that the inverse does not explicitly own.
pub fn ensure_restorable(
    runner: &GitRunner,
    discovery: &RepoDiscovery,
    action: &ReversibleAction,
) -> Result<(), AppError> {
    for lock in [
        discovery.common_dir.join("index.lock"),
        discovery.common_dir.join("HEAD.lock"),
        discovery.git_dir.join("HEAD.lock"),
    ] {
        if lock.exists() {
            return Err(AppError::new(
                "undo.locked",
                ErrorCategory::Busy,
                "Un verrou Git empêche l'annulation.",
            )
            .with_detail(lock.display().to_string())
            .with_remediation("Attendez la fin du processus Git, puis réessayez."));
        }
    }
    let state = detect(runner, discovery, Some(1))?.state;
    if let Some(operation) = state.operation {
        if !contains_abort(action) {
            return Err(AppError::new(
                "undo.operation_in_progress",
                ErrorCategory::GitState,
                "Une opération Git est en cours.",
            )
            .with_detail(format!("{operation:?}"))
            .with_remediation(
                "Terminez ou abandonnez explicitement l'opération avant d'annuler.",
            ));
        }
    }
    Ok(())
}

fn contains_abort(action: &ReversibleAction) -> bool {
    match action {
        ReversibleAction::AbortOperation { .. } => true,
        ReversibleAction::Sequence { actions } => actions.iter().any(contains_abort),
        _ => false,
    }
}

/// Target of a head movement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadTarget {
    Branch { name: String },
    Detached { sha: String },
    Unborn { branch: Option<String> },
}

/// How a head movement restores the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// `reset --soft` + index tree: commits and index only.
    Soft,
    /// `reset --mixed` + index tree: index only, worktree untouched.
    Mixed,
    /// `reset --hard` + index tree: typed inverse for history operations that
    /// changed tracked working-tree content (merge, rebase, cherry-pick).
    Hard,
}

/// Typed inverse of a recorded operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReversibleAction {
    /// Several inverses executed in order (e.g. branch creation + checkout).
    Sequence {
        actions: Vec<ReversibleAction>,
    },
    RestoreHead {
        target: HeadTarget,
        /// Commit to move HEAD to while staying on `target`'s branch. `None`
        /// resets to the target ref's current tip.
        sha: Option<String>,
        mode: RestoreMode,
        index_tree: Option<String>,
    },
    Checkout {
        target: HeadTarget,
    },
    /// Check out `branch` while resetting its tip to `sha`.
    CheckoutReset {
        branch: String,
        sha: String,
    },
    /// Move an existing ref from `expected` back to `sha`.
    UpdateRef {
        reference: String,
        expected: String,
        sha: String,
    },
    CreateRef {
        reference: String,
        sha: String,
        /// Restored upstream when the reference is a local branch.
        upstream: Option<String>,
    },
    DeleteRef {
        reference: String,
        expected: String,
    },
    RenameRef {
        from: String,
        to: String,
    },
    AbortOperation {
        operation: InProgressOperation,
    },
    CreateTag {
        name: String,
        object: String,
        message: Option<String>,
        tagger: Option<String>,
        tagger_email: Option<String>,
        tagger_time: Option<i64>,
    },
    DeleteTag {
        name: String,
        expected: String,
    },
    AddRemote {
        name: String,
        urls: Vec<String>,
        push_urls: Vec<String>,
        fetch: Vec<String>,
    },
    RemoveRemote {
        name: String,
        expected_urls: Vec<String>,
    },
    ApplyStash {
        selector: String,
        expected_sha: String,
        drop: bool,
        /// Status hash that the restored worktree must match before the stash
        /// is dropped. Prevents losing a stash on a partial application.
        expected_status_hash: Option<String>,
    },
    AddWorktree {
        path: String,
        reference: String,
        new_branch: Option<String>,
        detach: bool,
    },
    RemoveWorktree {
        path: String,
        force: bool,
    },
}

/// A restoration step, journaled before it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStep {
    pub step: String,
    /// Exact command shown to the user on failure.
    pub command: String,
    /// Recovery SHA when the step moves a ref.
    pub sha: Option<String>,
}

/// Partial failure with the exact step and command that failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub step: String,
    pub command: String,
    pub sha: Option<String>,
    pub detail: String,
    pub error: AppError,
}

impl RestoreFailure {
    pub fn into_error(self) -> AppError {
        self.error
            .with_detail(format!(
                "étape {} · commande `{}`{} · {}",
                self.step,
                self.command,
                self.sha
                    .as_deref()
                    .map(|sha| format!(" · sha {sha}"))
                    .unwrap_or_default(),
                self.detail
            ))
            .with_remediation(
                "Aucune sauvegarde applicative n'existe. Inspectez `git reflog` et le SHA ci-dessus.",
            )
    }
}

/// Execute an inverse. `on_step` is called before every Git command and can
/// abort the restoration; it is also used by tests to inject failures.
pub fn apply(
    runner: &GitRunner,
    discovery: &RepoDiscovery,
    action: &ReversibleAction,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let worktree = discovery
        .worktree()
        .map_err(|error| failure("prepare", "—", None, error))?;
    match action {
        ReversibleAction::Sequence { actions } => {
            for part in actions {
                apply(runner, discovery, part, on_step)?;
            }
            Ok(())
        }
        ReversibleAction::RestoreHead {
            target,
            sha,
            mode,
            index_tree,
        } => restore_head(
            runner,
            worktree,
            target,
            sha.as_deref(),
            *mode,
            index_tree.as_deref(),
            on_step,
        ),
        ReversibleAction::Checkout { target } => checkout(runner, worktree, target, on_step),
        ReversibleAction::CheckoutReset { branch, sha } => exec(
            runner,
            CommandSpec::new(GitSubcommand::Switch, worktree)
                .arg("-C")
                .arg(branch)
                .arg(sha),
            "checkout-reset",
            format!("git switch -C {branch} {sha}"),
            Some(sha.clone()),
            on_step,
        ),
        ReversibleAction::UpdateRef {
            reference,
            expected,
            sha,
        } => {
            let current = rev_parse(runner, worktree, reference).map_err(|_| {
                failure(
                    "update-ref",
                    format!("git update-ref {reference} {sha}"),
                    Some(sha.clone()),
                    AppError::new(
                        "undo.precondition",
                        ErrorCategory::GitState,
                        "La référence n'existe plus.",
                    )
                    .with_detail(reference.clone()),
                )
            })?;
            if &current != expected {
                return Err(failure(
                    "update-ref",
                    format!("git update-ref {reference} {sha}"),
                    Some(sha.clone()),
                    AppError::new(
                        "undo.precondition",
                        ErrorCategory::GitState,
                        "La référence ne pointe plus au commit attendu.",
                    )
                    .with_detail(format!("attendu {expected}, actuel {current}")),
                ));
            }
            exec(
                runner,
                CommandSpec::new(GitSubcommand::UpdateRef, worktree)
                    .arg(reference)
                    .arg(sha),
                "update-ref",
                format!("git update-ref {reference} {sha}"),
                Some(sha.clone()),
                on_step,
            )
        }
        ReversibleAction::CreateRef {
            reference,
            sha,
            upstream,
        } => {
            if rev_parse(runner, worktree, reference).is_ok() {
                return Err(failure(
                    "create-ref",
                    format!("git update-ref {reference} {sha}"),
                    Some(sha.clone()),
                    AppError::new(
                        "undo.precondition",
                        ErrorCategory::GitState,
                        "La référence existe déjà.",
                    )
                    .with_detail(reference.clone()),
                ));
            }
            exec(
                runner,
                CommandSpec::new(GitSubcommand::UpdateRef, worktree)
                    .arg(reference)
                    .arg(sha),
                "create-ref",
                format!("git update-ref {reference} {sha}"),
                Some(sha.clone()),
                on_step,
            )?;
            if let (Some(upstream), Some(name)) =
                (upstream.as_deref(), reference.strip_prefix("refs/heads/"))
            {
                exec(
                    runner,
                    CommandSpec::new(GitSubcommand::Branch, worktree)
                        .arg(format!("--set-upstream-to={upstream}"))
                        .arg(name),
                    "restore-upstream",
                    format!("git branch --set-upstream-to={upstream} {name}"),
                    None,
                    on_step,
                )?;
            }
            Ok(())
        }
        ReversibleAction::DeleteRef {
            reference,
            expected,
        } => exec(
            runner,
            CommandSpec::new(GitSubcommand::UpdateRef, worktree)
                .arg("-d")
                .arg(reference)
                .arg(expected),
            "delete-ref",
            format!("git update-ref -d {reference} {expected}"),
            Some(expected.clone()),
            on_step,
        ),
        ReversibleAction::RenameRef { from, to } => exec(
            runner,
            CommandSpec::new(GitSubcommand::Branch, worktree)
                .arg("-m")
                .arg(from)
                .arg(to),
            "rename-ref",
            format!("git branch -m {from} {to}"),
            None,
            on_step,
        ),
        ReversibleAction::AbortOperation { operation } => {
            abort_operation(runner, worktree, operation, on_step)
        }
        ReversibleAction::CreateTag {
            name,
            object,
            message,
            tagger,
            tagger_email,
            tagger_time,
        } => create_tag(
            runner,
            worktree,
            name,
            object,
            message.as_deref(),
            tagger.as_deref(),
            tagger_email.as_deref(),
            *tagger_time,
            on_step,
        ),
        ReversibleAction::DeleteTag { name, expected } => {
            let current =
                rev_parse(runner, worktree, &format!("refs/tags/{name}")).map_err(|_| {
                    failure(
                        "delete-tag",
                        format!("git tag -d {name}"),
                        None,
                        AppError::new(
                            "undo.precondition",
                            ErrorCategory::GitState,
                            "Le tag n'existe plus.",
                        )
                        .with_detail(name.clone()),
                    )
                })?;
            if &current != expected {
                return Err(failure(
                    "delete-tag",
                    format!("git tag -d {name}"),
                    Some(expected.clone()),
                    AppError::new(
                        "undo.precondition",
                        ErrorCategory::GitState,
                        "Le tag ne pointe plus au même objet.",
                    )
                    .with_detail(format!("attendu {expected}, actuel {current}")),
                ));
            }
            exec(
                runner,
                CommandSpec::new(GitSubcommand::Tag, worktree)
                    .arg("-d")
                    .arg(name),
                "delete-tag",
                format!("git tag -d {name}"),
                Some(expected.clone()),
                on_step,
            )
        }
        ReversibleAction::AddRemote {
            name,
            urls,
            push_urls,
            fetch,
        } => add_remote(runner, worktree, name, urls, push_urls, fetch, on_step),
        ReversibleAction::RemoveRemote {
            name,
            expected_urls,
        } => remove_remote(runner, worktree, name, expected_urls, on_step),
        ReversibleAction::ApplyStash {
            selector,
            expected_sha,
            drop,
            expected_status_hash,
        } => apply_stash(
            runner,
            worktree,
            selector,
            expected_sha,
            *drop,
            expected_status_hash.as_deref(),
            on_step,
        ),
        ReversibleAction::AddWorktree {
            path,
            reference,
            new_branch,
            detach,
        } => add_worktree(
            runner,
            worktree,
            path,
            reference,
            new_branch.as_deref(),
            *detach,
            on_step,
        ),
        ReversibleAction::RemoveWorktree { path, force } => {
            remove_worktree(runner, worktree, path, *force, on_step)
        }
    }
}

fn restore_head(
    runner: &GitRunner,
    worktree: &Path,
    target: &HeadTarget,
    sha: Option<&str>,
    mode: RestoreMode,
    index_tree: Option<&str>,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    match target {
        HeadTarget::Branch { name } => {
            if current_head(runner, worktree) != Some(("branch".to_owned(), name.clone())) {
                checkout_target(
                    runner,
                    worktree,
                    &HeadTarget::Branch { name: name.clone() },
                    on_step,
                )?;
            }
        }
        HeadTarget::Detached { sha } => {
            if current_head(runner, worktree) != Some(("detached".to_owned(), sha.clone())) {
                checkout_target(
                    runner,
                    worktree,
                    &HeadTarget::Detached { sha: sha.clone() },
                    on_step,
                )?;
            }
        }
        HeadTarget::Unborn { branch } => {
            let command = branch
                .as_ref()
                .map(|branch| format!("git switch --orphan {branch}"))
                .unwrap_or_else(|| "git update-ref -d HEAD".to_owned());
            if let Some(branch) = branch {
                exec(
                    runner,
                    CommandSpec::new(GitSubcommand::Switch, worktree)
                        .arg("--orphan")
                        .arg(branch),
                    "restore-unborn",
                    command,
                    None,
                    on_step,
                )?;
            } else {
                exec(
                    runner,
                    CommandSpec::new(GitSubcommand::UpdateRef, worktree)
                        .arg("-d")
                        .arg("HEAD"),
                    "restore-unborn",
                    command,
                    None,
                    on_step,
                )?;
            }
            return restore_index(runner, worktree, index_tree, on_step, "restore-index");
        }
    }

    let sha = match sha {
        Some(sha) => sha.to_owned(),
        None => rev_parse(runner, worktree, "HEAD")
            .map_err(|error| failure("restore-head", "git reset".to_owned(), None, error))?,
    };
    match mode {
        RestoreMode::Soft => exec(
            runner,
            CommandSpec::new(GitSubcommand::Reset, worktree)
                .arg("--soft")
                .arg(&sha),
            "restore-head",
            format!("git reset --soft {sha}"),
            Some(sha.clone()),
            on_step,
        )?,
        RestoreMode::Mixed => exec(
            runner,
            CommandSpec::new(GitSubcommand::Reset, worktree)
                .arg("--mixed")
                .arg(&sha),
            "restore-head",
            format!("git reset --mixed {sha}"),
            Some(sha.clone()),
            on_step,
        )?,
        RestoreMode::Hard => exec(
            runner,
            CommandSpec::new(GitSubcommand::Reset, worktree)
                .arg("--hard")
                .arg(&sha),
            "restore-head",
            format!("git reset --hard {sha}"),
            Some(sha.clone()),
            on_step,
        )?,
    }
    restore_index(runner, worktree, index_tree, on_step, "restore-index")
}

fn checkout_target(
    runner: &GitRunner,
    worktree: &Path,
    target: &HeadTarget,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    match target {
        HeadTarget::Branch { name } => exec(
            runner,
            CommandSpec::new(GitSubcommand::Switch, worktree).arg(name),
            "checkout",
            format!("git switch {name}"),
            None,
            on_step,
        ),
        HeadTarget::Detached { sha } => exec(
            runner,
            CommandSpec::new(GitSubcommand::Switch, worktree)
                .arg("--detach")
                .arg(sha),
            "checkout",
            format!("git switch --detach {sha}"),
            Some(sha.clone()),
            on_step,
        ),
        HeadTarget::Unborn { branch } => match branch {
            Some(branch) => exec(
                runner,
                CommandSpec::new(GitSubcommand::Switch, worktree)
                    .arg("--orphan")
                    .arg(branch),
                "checkout",
                format!("git switch --orphan {branch}"),
                None,
                on_step,
            ),
            None => exec(
                runner,
                CommandSpec::new(GitSubcommand::UpdateRef, worktree)
                    .arg("-d")
                    .arg("HEAD"),
                "checkout",
                "git update-ref -d HEAD".to_owned(),
                None,
                on_step,
            ),
        },
    }
}

fn checkout(
    runner: &GitRunner,
    worktree: &Path,
    target: &HeadTarget,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    checkout_target(runner, worktree, target, on_step)
}

fn restore_index(
    runner: &GitRunner,
    worktree: &Path,
    index_tree: Option<&str>,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
    step: &str,
) -> Result<(), RestoreFailure> {
    match index_tree {
        Some(tree) => exec(
            runner,
            CommandSpec::new(GitSubcommand::ReadTree, worktree).arg(tree),
            step,
            format!("git read-tree {tree}"),
            Some(tree.to_owned()),
            on_step,
        ),
        None => exec(
            runner,
            CommandSpec::new(GitSubcommand::ReadTree, worktree).arg("--empty"),
            step,
            "git read-tree --empty".to_owned(),
            None,
            on_step,
        ),
    }
}

/// Current head as `(kind, value)` where kind is `branch` or `detached`.
fn current_head(runner: &GitRunner, worktree: &Path) -> Option<(String, String)> {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, worktree)
                .arg("--abbrev-ref")
                .arg("HEAD"),
        )
        .ok()?;
    if !outcome.success() {
        return None;
    }
    let branch = outcome.stdout.text_lossy().trim().to_owned();
    if branch.is_empty() {
        return None;
    }
    if branch == "HEAD" {
        let sha = rev_parse(runner, worktree, "HEAD").ok()?;
        Some(("detached".to_owned(), sha))
    } else {
        Some(("branch".to_owned(), branch))
    }
}

fn abort_operation(
    runner: &GitRunner,
    worktree: &Path,
    operation: &InProgressOperation,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let (subcommand, label) = match operation {
        InProgressOperation::Merge => (GitSubcommand::Merge, "merge"),
        InProgressOperation::Rebase { .. } => (GitSubcommand::Rebase, "rebase"),
        InProgressOperation::CherryPick
        | InProgressOperation::Sequencer {
            sequencer: beebranch_core::SequencerKind::CherryPick,
        } => (GitSubcommand::CherryPick, "cherry-pick"),
        InProgressOperation::Revert
        | InProgressOperation::Sequencer {
            sequencer: beebranch_core::SequencerKind::Revert,
        } => (GitSubcommand::Revert, "revert"),
        InProgressOperation::Bisect => {
            return Err(failure(
                "abort",
                "git bisect reset".to_owned(),
                None,
                AppError::new(
                    "undo.unsupported",
                    ErrorCategory::GitState,
                    "L'abandon d'un bisect n'est pas annulable.",
                ),
            ))
        }
    };
    exec(
        runner,
        CommandSpec::new(subcommand, worktree).arg("--abort"),
        "abort-operation",
        format!("git {label} --abort"),
        None,
        on_step,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_tag(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    object: &str,
    message: Option<&str>,
    tagger: Option<&str>,
    tagger_email: Option<&str>,
    tagger_time: Option<i64>,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    if rev_parse(runner, worktree, &format!("refs/tags/{name}")).is_ok() {
        return Err(failure(
            "create-tag",
            format!("git tag {name} {object}"),
            Some(object.to_owned()),
            AppError::new(
                "undo.precondition",
                ErrorCategory::GitState,
                "Le tag existe déjà.",
            )
            .with_detail(name.to_owned()),
        ));
    }
    let mut spec = CommandSpec::new(GitSubcommand::Tag, worktree);
    if let Some(message) = message {
        spec = spec.arg("-a").arg(name).arg("-m").arg(message);
    } else {
        spec = spec.arg(name);
    }
    spec = spec.arg(object);
    if let Some(tagger) = tagger {
        spec = spec.env("GIT_COMMITTER_NAME", tagger);
    }
    if let Some(email) = tagger_email {
        spec = spec.env("GIT_COMMITTER_EMAIL", email);
    }
    if let Some(time) = tagger_time {
        spec = spec.env("GIT_COMMITTER_DATE", format!("@{time} +0000"));
    }
    exec(
        runner,
        spec,
        "create-tag",
        format!("git tag {name} {object}"),
        Some(object.to_owned()),
        on_step,
    )
}

fn add_remote(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    urls: &[String],
    push_urls: &[String],
    fetch: &[String],
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let Some(first) = urls.first() else {
        return Err(failure(
            "add-remote",
            format!("git remote add {name}"),
            None,
            AppError::invalid_input("Aucune URL de remote à restaurer.".to_owned()),
        ));
    };
    if remote_urls(runner, worktree, name).is_ok() {
        return Err(failure(
            "add-remote",
            format!("git remote add {name} {first}"),
            None,
            AppError::new(
                "undo.precondition",
                ErrorCategory::GitState,
                "Le remote existe déjà.",
            )
            .with_detail(name.to_owned()),
        ));
    }
    exec(
        runner,
        CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("add")
            .arg(name)
            .arg(first),
        "add-remote",
        format!("git remote add {name} {first}"),
        None,
        on_step,
    )?;
    for url in urls.iter().skip(1) {
        exec(
            runner,
            CommandSpec::new(GitSubcommand::Remote, worktree)
                .arg("set-url")
                .arg("--add")
                .arg(name)
                .arg(url),
            "add-remote-url",
            format!("git remote set-url --add {name} {url}"),
            None,
            on_step,
        )?;
    }
    for url in push_urls {
        exec(
            runner,
            CommandSpec::new(GitSubcommand::Remote, worktree)
                .arg("set-url")
                .arg("--add")
                .arg("--push")
                .arg(name)
                .arg(url),
            "add-remote-push-url",
            format!("git remote set-url --add --push {name} {url}"),
            None,
            on_step,
        )?;
    }
    for refspec in fetch {
        exec(
            runner,
            CommandSpec::new(GitSubcommand::Config, worktree)
                .arg("--add")
                .arg(format!("remote.{name}.fetch"))
                .arg(refspec),
            "add-remote-fetch",
            format!("git config --add remote.{name}.fetch {refspec}"),
            None,
            on_step,
        )?;
    }
    Ok(())
}

fn remove_remote(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
    expected_urls: &[String],
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let current = remote_urls(runner, worktree, name).map_err(|error| {
        failure(
            "remove-remote",
            format!("git remote remove {name}"),
            None,
            error,
        )
    })?;
    if !expected_urls.is_empty() && current != expected_urls {
        return Err(failure(
            "remove-remote",
            format!("git remote remove {name}"),
            None,
            AppError::new(
                "undo.precondition",
                ErrorCategory::GitState,
                "Les URL du remote ont changé.",
            )
            .with_detail(format!("attendu {expected_urls:?}, actuel {current:?}")),
        ));
    }
    exec(
        runner,
        CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("remove")
            .arg(name),
        "remove-remote",
        format!("git remote remove {name}"),
        None,
        on_step,
    )
}

fn apply_stash(
    runner: &GitRunner,
    worktree: &Path,
    selector: &str,
    expected_sha: &str,
    drop: bool,
    expected_status_hash: Option<&str>,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    exec(
        runner,
        CommandSpec::new(GitSubcommand::Stash, worktree)
            .arg("apply")
            .arg("--index")
            .arg(expected_sha),
        "stash-apply",
        format!("git stash apply --index {expected_sha}"),
        Some(expected_sha.to_owned()),
        on_step,
    )?;
    if drop {
        if let Some(expected) = expected_status_hash {
            let actual = status_hash(runner, worktree).map_err(|error| {
                failure("stash-verify", "git status --porcelain=v2", None, error)
            })?;
            if actual != expected {
                return Err(failure(
                    "stash-verify",
                    "git status --porcelain=v2".to_owned(),
                    Some(expected_sha.to_owned()),
                    AppError::new(
                        "undo.stash_not_exact",
                        ErrorCategory::GitState,
                        "Le stash appliqué ne correspond pas exactement à l'état attendu ; il n'a pas été supprimé.",
                    )
                    .with_detail(format!("attendu {expected}, actuel {actual}")),
                ));
            }
        }
        exec(
            runner,
            CommandSpec::new(GitSubcommand::Stash, worktree)
                .arg("drop")
                .arg(selector),
            "stash-drop",
            format!("git stash drop {selector}"),
            Some(expected_sha.to_owned()),
            on_step,
        )?;
    }
    Ok(())
}

fn add_worktree(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    reference: &str,
    new_branch: Option<&str>,
    detach: bool,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let target = Path::new(path);
    if target.exists() {
        return Err(failure(
            "add-worktree",
            format!("git worktree add {path} {reference}"),
            None,
            AppError::new(
                "undo.precondition",
                ErrorCategory::GitState,
                "Le chemin du worktree est déjà occupé.",
            )
            .with_detail(path.to_owned()),
        ));
    }
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("add");
    if detach {
        spec = spec.arg("--detach");
    }
    if let Some(branch) = new_branch {
        spec = spec.arg("-b").arg(branch);
    }
    spec = spec.arg(path).arg(reference);
    exec(
        runner,
        spec,
        "add-worktree",
        format!("git worktree add {path} {reference}"),
        None,
        on_step,
    )
}

fn remove_worktree(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    force: bool,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let mut spec = CommandSpec::new(GitSubcommand::Worktree, worktree).arg("remove");
    if force {
        spec = spec.arg("--force");
    }
    spec = spec.arg(path);
    exec(
        runner,
        spec,
        "remove-worktree",
        format!(
            "git worktree remove {}{path}",
            if force { "--force " } else { "" }
        ),
        None,
        on_step,
    )
}

fn exec(
    runner: &GitRunner,
    spec: CommandSpec,
    step: &str,
    command: String,
    sha: Option<String>,
    on_step: &mut dyn FnMut(&RestoreStep) -> Result<(), AppError>,
) -> Result<(), RestoreFailure> {
    let record = RestoreStep {
        step: step.to_owned(),
        command: command.clone(),
        sha: sha.clone(),
    };
    on_step(&record).map_err(|error| failure(step, command.clone(), sha.clone(), error))?;
    let outcome = runner
        .run(&spec)
        .map_err(|error| failure(step, command.clone(), sha.clone(), AppError::from(error)))?;
    if !outcome.success() {
        let detail = format!("{}{}", outcome.stdout.redacted(), outcome.stderr.redacted());
        let error = beebranch_core::classify_git_failure(outcome.exit_code(), &detail);
        return Err(failure(step, command, sha, error.with_detail(detail)));
    }
    Ok(())
}

fn failure(
    step: &str,
    command: impl Into<String>,
    sha: Option<String>,
    error: AppError,
) -> RestoreFailure {
    RestoreFailure {
        step: step.to_owned(),
        command: command.into(),
        sha,
        detail: error
            .detail
            .clone()
            .unwrap_or_else(|| error.message.clone()),
        error,
    }
}

fn rev_parse(runner: &GitRunner, worktree: &Path, revision: &str) -> Result<String, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::RevParse, worktree)
            .arg("--verify")
            .arg("--quiet")
            .arg(revision),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "git.revision_missing",
            ErrorCategory::GitState,
            "La révision est introuvable.",
        )
        .with_detail(revision.to_owned()));
    }
    Ok(outcome.stdout.text_lossy().trim().to_owned())
}

fn write_tree(runner: &GitRunner, worktree: &Path) -> Result<String, AppError> {
    let outcome = runner.run(&CommandSpec::new(GitSubcommand::WriteTree, worktree))?;
    if !outcome.success() {
        return Err(AppError::new(
            "undo.index_unmerged",
            ErrorCategory::GitState,
            "L'index contient des conflits non résolus.",
        ));
    }
    Ok(outcome.stdout.text_lossy().trim().to_owned())
}

fn status_hash(runner: &GitRunner, worktree: &Path) -> Result<String, AppError> {
    let outcome = runner.run(&CommandSpec::new(GitSubcommand::Status, worktree).args([
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--find-renames",
    ]))?;
    let outcome = outcome.ensure_success()?;
    let digest = Sha256::digest(outcome.stdout.bytes());
    Ok(format!("{digest:x}"))
}

fn hash_file(path: PathBuf) -> Result<String, AppError> {
    match std::fs::read(&path) {
        Ok(bytes) => {
            let digest = Sha256::digest(&bytes);
            Ok(format!("{digest:x}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("absent".to_owned()),
        Err(error) => Err(AppError::new(
            "undo.file_unreadable",
            ErrorCategory::Permission,
            "Un fichier affecté n'a pas pu être lu.",
        )
        .with_detail(format!("{}: {error}", path.display()))),
    }
}

/// URLs and fetch refspecs of a remote, used to record its removal.
pub type RemoteConfig = (Vec<String>, Vec<String>, Vec<String>);

pub fn remote_config(
    runner: &GitRunner,
    worktree: &Path,
    name: &str,
) -> Result<RemoteConfig, AppError> {
    let urls = remote_urls(runner, worktree, name)?;
    let mut fetch = Vec::new();
    let mut push = Vec::new();
    for (key, destination) in [
        (format!("remote.{name}.fetch"), &mut fetch),
        (format!("remote.{name}.pushurl"), &mut push),
    ] {
        let outcome = runner.run(
            &CommandSpec::new(GitSubcommand::Config, worktree)
                .arg("--get-all")
                .arg(&key),
        )?;
        if outcome.success() {
            for line in outcome.stdout.text_lossy().lines() {
                if !line.trim().is_empty() {
                    destination.push(line.trim().to_owned());
                }
            }
        }
    }
    Ok((urls, push, fetch))
}

fn remote_urls(runner: &GitRunner, worktree: &Path, name: &str) -> Result<Vec<String>, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Remote, worktree)
            .arg("-v")
            .capture_limits(CaptureLimits {
                stdout: 1024 * 1024,
                stderr: 16 * 1024,
            }),
    )?;
    let outcome = outcome.ensure_success()?;
    let mut urls: Vec<String> = Vec::new();
    for line in outcome.stdout.text_lossy().lines() {
        let mut fields = line.splitn(2, '\t');
        let Some(remote) = fields.next() else {
            continue;
        };
        if remote != name {
            continue;
        }
        let Some(rest) = fields.next() else {
            continue;
        };
        let Some(url) = rest
            .strip_suffix(" (fetch)")
            .or_else(|| rest.strip_suffix(" (push)"))
        else {
            continue;
        };
        if !urls.iter().any(|existing| existing == url) {
            urls.push(url.to_owned());
        }
    }
    if urls.is_empty() {
        return Err(AppError::new(
            "undo.remote_missing",
            ErrorCategory::GitState,
            "Le remote est introuvable.",
        )
        .with_detail(name.to_owned()));
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discover::discover;

    fn fixture() -> (tempfile::TempDir, GitRunner) {
        let dir = tempfile::tempdir().expect("tempdir");
        let runner = GitRunner::detect().expect("git");
        let run = |args: &[&str]| {
            let outcome = runner
                .run(&CommandSpec::new(GitSubcommand::Init, dir.path()).arg(args[0]))
                .expect("init");
            assert!(outcome.success());
            let _ = args;
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

    #[test]
    fn fingerprints_detect_a_changed_worktree() {
        let (dir, runner) = fixture();
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        runner
            .run(&CommandSpec::new(GitSubcommand::Add, dir.path()).arg("-A"))
            .expect("add");
        let discovery = discover(&runner, dir.path()).expect("discover");
        let first = capture(&runner, &discovery, &[], &["a.txt".to_owned()]).expect("capture");
        std::fs::write(dir.path().join("a.txt"), "two\n").expect("write");
        let second = capture(&runner, &discovery, &[], &["a.txt".to_owned()]).expect("capture");
        assert!(Fingerprint::compare(&first, &second).is_err());
    }

    #[test]
    fn restoration_stops_at_the_failed_step() {
        let (dir, runner) = fixture();
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        runner
            .run(&CommandSpec::new(GitSubcommand::Add, dir.path()).arg("-A"))
            .expect("add");
        runner
            .run(
                &CommandSpec::new(GitSubcommand::Commit, dir.path())
                    .arg("-F")
                    .arg("-")
                    .stdin(crate::process::StdinMode::Bytes(b"first\n".to_vec())),
            )
            .expect("commit");
        let discovery = discover(&runner, dir.path()).expect("discover");
        let head = rev_parse(&runner, dir.path(), "HEAD").expect("head");
        let branch = current_head(&runner, dir.path()).expect("branch").1;
        let mut calls = 0;
        let failure = apply(
            &runner,
            &discovery,
            &ReversibleAction::RestoreHead {
                target: HeadTarget::Branch { name: branch },
                sha: Some(head.clone()),
                mode: RestoreMode::Soft,
                index_tree: None,
            },
            &mut |step| {
                calls += 1;
                assert_eq!(step.step, "restore-head");
                Err(AppError::new(
                    "test.injected",
                    ErrorCategory::Internal,
                    "injected",
                ))
            },
        )
        .expect_err("fault injection");
        assert_eq!(calls, 1);
        assert_eq!(failure.step, "restore-head");
        assert!(failure.command.contains("reset --soft"));
        assert_eq!(rev_parse(&runner, dir.path(), "HEAD").unwrap(), head);
    }
}
