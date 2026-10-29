//! Merge, rebase and conflict operations with intermediate-state recovery.
//!
//! Every mutation is followed by a full state detection. A command that exits
//! non-zero because of a conflict is reported as a state, not as an opaque
//! failure; `abort`, `continue` and `skip` are explicit commands.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory, InProgressOperation, RepoState, SequencerKind};
use serde::{Deserialize, Serialize};

use crate::discover::discover;
use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::state::{detect, DetectedState};
use crate::status::read_status;
use crate::GitSubcommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOutcome {
    pub state: RepoState,
    /// Combined redacted output, including conflict hints.
    pub output: String,
    /// True when the operation paused on conflicts.
    pub conflicted: bool,
}

/// How a merge may move the target branch.
///
/// The flag is always passed explicitly so the result never depends on the
/// repository's `merge.ff` configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeFastForward {
    /// Fast-forward when the target is an ancestor of the source, merge commit
    /// otherwise (`--ff`).
    #[default]
    Auto,
    /// Require a fast-forward (`--ff-only`): Git refuses to create a merge
    /// commit when the target has commits the source lacks.
    Only,
    /// Always create a merge commit, even when a fast-forward is possible
    /// (`--no-ff`).
    Never,
}

impl MergeFastForward {
    /// Explicit Git flag: the repository configuration cannot override it.
    pub const fn flag(self) -> &'static str {
        match self {
            Self::Auto => "--ff",
            Self::Only => "--ff-only",
            Self::Never => "--no-ff",
        }
    }
}

/// Refuse to start a new history operation while another is in progress.
pub fn ensure_idle(runner: &GitRunner, worktree: &Path) -> Result<RepoState, AppError> {
    let detected = detect_state(runner, worktree)?;
    if detected.state.operation.is_some() || !detected.state.conflicts.is_empty() {
        return Err(AppError::new(
            "operation.in_progress",
            ErrorCategory::GitState,
            "Une opération Git est déjà en cours.",
        )
        .with_remediation("Terminez-la (continue/abort) avant d'en démarrer une autre."));
    }
    Ok(detected.state)
}

/// Start a merge. A conflicting merge is returned as an outcome, not an error.
///
/// The fast-forward behaviour is explicit (`--ff`, `--ff-only` or `--no-ff`),
/// so a local `merge.ff` setting can never change what the caller asked for.
pub fn merge(
    runner: &GitRunner,
    worktree: &Path,
    target: &str,
    fast_forward: MergeFastForward,
) -> Result<HistoryOutcome, AppError> {
    crate::log::validate_revision(target)?;
    ensure_idle(runner, worktree)?;
    let spec = CommandSpec::new(GitSubcommand::Merge, worktree)
        .arg("--no-edit")
        .arg(fast_forward.flag())
        .capture_limits(output_limits())
        .arg(target);
    run_stateful(runner, worktree, spec)
}

/// Start a rebase. Requires a clean worktree.
pub fn rebase(
    runner: &GitRunner,
    worktree: &Path,
    upstream: &str,
) -> Result<HistoryOutcome, AppError> {
    crate::log::validate_revision(upstream)?;
    ensure_idle(runner, worktree)?;
    let status = read_status(runner, worktree, Some(1))?;
    if status.counts.staged > 0 || status.counts.unstaged > 0 {
        return Err(AppError::new(
            "git.dirty_worktree",
            ErrorCategory::GitState,
            "Des modifications locales empêchent le rebase.",
        )
        .with_remediation("Committez ou stashez vos modifications, puis relancez le rebase."));
    }
    let spec = CommandSpec::new(GitSubcommand::Rebase, worktree)
        .capture_limits(output_limits())
        .arg(upstream);
    run_stateful(runner, worktree, spec)
}

/// Reset modes that remain reversible. `--hard` is deliberately refused:
/// it destroys uncommitted tracked content and is not an undoable operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReversibleResetMode {
    Soft,
    Mixed,
}

/// Move HEAD (and, for `mixed`, the index) to `revision`.
pub fn reset(
    runner: &GitRunner,
    worktree: &Path,
    revision: &str,
    mode: ReversibleResetMode,
) -> Result<HistoryOutcome, AppError> {
    crate::log::validate_revision(revision)?;
    ensure_idle(runner, worktree)?;
    let flag = match mode {
        ReversibleResetMode::Soft => "--soft",
        ReversibleResetMode::Mixed => "--mixed",
    };
    let spec = CommandSpec::new(GitSubcommand::Reset, worktree)
        .arg(flag)
        .arg(revision)
        .capture_limits(output_limits());
    run_stateful(runner, worktree, spec)
}

/// Continue the operation currently in progress.
pub fn continue_operation(runner: &GitRunner, worktree: &Path) -> Result<HistoryOutcome, AppError> {
    let detected = detect_state(runner, worktree)?;
    let command = continue_command(&detected.state).ok_or_else(no_operation)?;
    let spec = CommandSpec::new(command, worktree)
        .arg("--continue")
        .env("GIT_EDITOR", "true")
        .capture_limits(output_limits());
    run_stateful(runner, worktree, spec)
}

/// Skip the current commit of a rebase, cherry-pick or revert.
pub fn skip_operation(runner: &GitRunner, worktree: &Path) -> Result<HistoryOutcome, AppError> {
    let detected = detect_state(runner, worktree)?;
    let command = skip_command(&detected.state).ok_or_else(|| {
        AppError::new(
            "operation.skip_unsupported",
            ErrorCategory::GitState,
            "Cette opération ne peut pas être sautée.",
        )
    })?;
    let spec = CommandSpec::new(command, worktree)
        .arg("--skip")
        .capture_limits(output_limits());
    run_stateful(runner, worktree, spec)
}

/// Abort the operation currently in progress.
///
/// The caller must enforce a typed confirmation: resolutions are discarded and
/// there is no application backup.
pub fn abort_operation(runner: &GitRunner, worktree: &Path) -> Result<HistoryOutcome, AppError> {
    let detected = detect_state(runner, worktree)?;
    let command = abort_command(&detected.state).ok_or_else(no_operation)?;
    let spec = CommandSpec::new(command, worktree)
        .arg("--abort")
        .capture_limits(output_limits());
    let outcome = run_stateful(runner, worktree, spec)?;
    if outcome.state.operation.is_some() {
        return Err(AppError::new(
            "operation.abort_failed",
            ErrorCategory::GitState,
            "L'opération n'a pas pu être abandonnée.",
        )
        .with_detail(outcome.output)
        .with_remediation("Inspectez l'état du dépôt avant toute autre action."));
    }
    Ok(outcome)
}

/// Mark a conflicted path as resolved by adding it to the index.
pub fn mark_resolved(runner: &GitRunner, worktree: &Path, path: &str) -> Result<(), AppError> {
    crate::diff::validate_relative_path(path)?;
    let detected = detect_state(runner, worktree)?;
    if !detected
        .state
        .conflicts
        .files
        .iter()
        .any(|candidate| candidate == path)
    {
        return Err(AppError::invalid_input(format!(
            "{path} n'est pas un fichier en conflit"
        )));
    }
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Add, worktree)
                .arg("-A")
                .path(path),
        )?
        .ensure_success()?;
    Ok(())
}

/// Content of a path in the index (`git show :path`), if present.
pub fn index_content(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    crate::diff::validate_relative_path(path)?;
    blob(runner, worktree, &format!(":{path}"))
}

/// Content of a path in HEAD, if present.
pub fn head_content(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    crate::diff::validate_relative_path(path)?;
    blob(runner, worktree, &format!("HEAD:{path}"))
}

/// Content of a path at an arbitrary revision (`git show <revision>:<path>`).
///
/// The revision is validated by the same rules as every other revspec so a
/// caller can never turn it into an option or a shell argument.
pub fn revision_content(
    runner: &GitRunner,
    worktree: &Path,
    revision: &str,
    path: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    crate::diff::validate_relative_path(path)?;
    crate::log::validate_revision(revision)?;
    blob(runner, worktree, &format!("{revision}:{path}"))
}

fn blob(runner: &GitRunner, worktree: &Path, spec: &str) -> Result<Option<Vec<u8>>, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Show, worktree)
            .arg(spec)
            .capture_limits(CaptureLimits {
                stdout: 8 * 1024 * 1024,
                stderr: 16 * 1024,
            }),
    )?;
    if !outcome.success() {
        return Ok(None);
    }
    Ok(Some(outcome.stdout.bytes().to_vec()))
}

/// Base, ours and theirs blob contents for one conflicted path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStages {
    pub path: String,
    pub base: Option<Vec<u8>>,
    pub ours: Option<Vec<u8>>,
    pub theirs: Option<Vec<u8>>,
}

/// Read the conflict stages of a path (`git show :1:path`, `:2:`, `:3:`).
pub fn conflict_stages(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
) -> Result<ConflictStages, AppError> {
    crate::diff::validate_relative_path(path)?;
    let read = |stage: u8| -> Result<Option<Vec<u8>>, AppError> {
        let spec = CommandSpec::new(GitSubcommand::Show, worktree)
            .arg(format!(":{stage}:{path}"))
            .capture_limits(CaptureLimits {
                stdout: 8 * 1024 * 1024,
                stderr: 16 * 1024,
            });
        let outcome = runner.run(&spec)?;
        if !outcome.success() {
            return Ok(None);
        }
        Ok(Some(outcome.stdout.bytes().to_vec()))
    };
    Ok(ConflictStages {
        path: path.to_owned(),
        base: read(1)?,
        ours: read(2)?,
        theirs: read(3)?,
    })
}

/// One step of an interactive rebase plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
    Edit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub sha: String,
    pub action: RebaseAction,
    /// Replacement message for `reword`, concatenated message for `squash`.
    pub message: Option<String>,
}

/// Commits that an interactive rebase would replay, oldest first.
pub fn rebase_candidates(
    runner: &GitRunner,
    worktree: &Path,
    upstream: &str,
) -> Result<Vec<String>, AppError> {
    crate::log::validate_revision(upstream)?;
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::RevList, worktree)
            .arg("--reverse")
            .arg("--no-merges")
            .arg(format!("{upstream}..HEAD")),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "rebase.candidates_failed",
            ErrorCategory::GitState,
            "La liste des commits à rebaser n'a pas pu être lue.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(outcome
        .stdout
        .text_lossy()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
        .collect())
}

/// Candidates with their subject, author and time, in replay order.
pub fn rebase_candidates_detail(
    runner: &GitRunner,
    worktree: &Path,
    upstream: &str,
) -> Result<Vec<crate::log::CommitSummary>, AppError> {
    let candidates = rebase_candidates(runner, worktree, upstream)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut spec = CommandSpec::new(GitSubcommand::Log, worktree)
        .arg("--no-walk")
        .arg(format!("--format={}", crate::search::LOG_FORMAT))
        .capture_limits(CaptureLimits {
            stdout: 4 * 1024 * 1024,
            stderr: 64 * 1024,
        });
    for sha in &candidates {
        spec = spec.arg(sha);
    }
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        return Err(AppError::new(
            "rebase.candidates_failed",
            ErrorCategory::GitState,
            "Les commits à rebaser n'ont pas pu être lus.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    let commits = crate::log::parse_log(&outcome.stdout.text_lossy()).map_err(|message| {
        AppError::internal(format!("lecture des commits de rebase: {message}"))
    })?;
    let mut ordered = Vec::with_capacity(candidates.len());
    for sha in candidates {
        if let Some(commit) = commits.iter().find(|commit| commit.sha == sha) {
            ordered.push(commit.clone());
        }
    }
    Ok(ordered)
}

/// Run an interactive rebase from an explicit plan.
///
/// The plan must contain exactly the commits returned by
/// [`rebase_candidates`], in the same order, with unique SHAs. The generated
/// todo replaces Git's default todo through `GIT_SEQUENCE_EDITOR`. Reword and
/// squash messages are applied with `git commit --amend -F`, so no editor is
/// launched and the plan is deterministic.
pub fn rebase_interactive(
    runner: &GitRunner,
    worktree: &Path,
    upstream: &str,
    plan: &[RebaseStep],
) -> Result<HistoryOutcome, AppError> {
    if plan.is_empty() {
        return Err(AppError::invalid_input(
            "Le plan de rebase est vide.".to_owned(),
        ));
    }
    ensure_idle(runner, worktree)?;
    let status = read_status(runner, worktree, Some(1))?;
    if status.counts.staged > 0 || status.counts.unstaged > 0 {
        return Err(AppError::new(
            "git.dirty_worktree",
            ErrorCategory::GitState,
            "Des modifications locales empêchent le rebase.",
        )
        .with_remediation("Committez ou stashez vos modifications, puis relancez le rebase."));
    }
    let candidates = rebase_candidates(runner, worktree, upstream)?;
    if candidates.is_empty() {
        return Err(AppError::new(
            "rebase.nothing_to_do",
            ErrorCategory::GitState,
            "Aucun commit ne peut être rebasé sur cette base.",
        ));
    }
    validate_plan(&candidates, plan)?;

    let directory = tempfile::tempdir().map_err(|error| {
        AppError::internal(format!("répertoire temporaire de rebase : {error}"))
    })?;
    let mut todo = String::new();
    let mut acknowledged_pick = false;
    let mut group_base: Option<String> = None;
    let mut group_messages: Vec<String> = Vec::new();

    for (index, step) in plan.iter().enumerate() {
        match step.action {
            RebaseAction::Drop => {
                todo.push_str(&format!("drop {}\n", step.sha));
                acknowledged_pick = true;
                group_base = None;
                group_messages.clear();
            }
            RebaseAction::Pick => {
                todo.push_str(&format!("pick {}\n", step.sha));
                acknowledged_pick = true;
                group_base = None;
                group_messages.clear();
            }
            RebaseAction::Reword => {
                let message = step
                    .message
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| commit_message(runner, worktree, &step.sha).ok())
                    .ok_or_else(|| {
                        AppError::invalid_input(
                            "Un reword nécessite un message de remplacement.".to_owned(),
                        )
                    })?;
                todo.push_str(&format!("pick {}\n", step.sha));
                let file = write_message(&directory, index, &message)?;
                todo.push_str(&format!(
                    "exec git commit --amend -F {} --cleanup=strip\n",
                    shell_quote(&file)
                ));
                acknowledged_pick = true;
                group_base = None;
                group_messages.clear();
            }
            RebaseAction::Fixup => {
                if !acknowledged_pick {
                    return Err(plan_error("fixup", "aucun commit précédent à fusionner"));
                }
                todo.push_str(&format!("fixup {}\n", step.sha));
            }
            RebaseAction::Squash => {
                if !acknowledged_pick {
                    return Err(plan_error("squash", "aucun commit précédent à fusionner"));
                }
                if group_base.is_none() {
                    if let Some(previous) = plan[..index]
                        .iter()
                        .rev()
                        .find(|step| step.action != RebaseAction::Drop)
                    {
                        group_base = Some(
                            previous
                                .message
                                .clone()
                                .filter(|value| !value.trim().is_empty())
                                .or_else(|| commit_message(runner, worktree, &previous.sha).ok())
                                .unwrap_or_default(),
                        );
                    }
                }
                let message = step
                    .message
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| commit_message(runner, worktree, &step.sha).ok())
                    .unwrap_or_default();
                if !message.trim().is_empty() {
                    group_messages.push(message.trim_end().to_owned());
                }
                todo.push_str(&format!("fixup {}\n", step.sha));
                let mut combined: Vec<String> = Vec::new();
                if let Some(base) = group_base.as_ref().filter(|base| !base.trim().is_empty()) {
                    combined.push(base.trim_end().to_owned());
                }
                combined.extend(group_messages.iter().cloned());
                if !combined.is_empty() {
                    let file = write_message(&directory, index, &combined.join("\n\n"))?;
                    todo.push_str(&format!(
                        "exec git commit --amend -F {} --cleanup=strip\n",
                        shell_quote(&file)
                    ));
                }
            }
            RebaseAction::Edit => {
                todo.push_str(&format!("edit {}\n", step.sha));
                acknowledged_pick = true;
                group_base = None;
                group_messages.clear();
            }
        }
    }

    let todo_file = directory.path().join("todo");
    std::fs::write(&todo_file, todo.as_bytes())
        .map_err(|error| AppError::internal(format!("écriture du todo de rebase : {error}")))?;
    let editor = format!("cp {}", shell_quote(&todo_file.to_string_lossy()));
    let spec = CommandSpec::new(GitSubcommand::Rebase, worktree)
        .arg("-i")
        .arg("--no-autosquash")
        .arg(upstream)
        .env("GIT_SEQUENCE_EDITOR", editor)
        .env("GIT_EDITOR", "true")
        .capture_limits(output_limits());
    run_stateful(runner, worktree, spec)
}

fn validate_plan(candidates: &[String], plan: &[RebaseStep]) -> Result<(), AppError> {
    let mut seen = std::collections::BTreeSet::new();
    for step in plan {
        if !seen.insert(step.sha.clone()) {
            return Err(plan_error("plan", "un commit apparaît deux fois"));
        }
        if !candidates.iter().any(|candidate| candidate == &step.sha) {
            return Err(
                plan_error("plan", "le commit n'appartient pas à la plage de rebase")
                    .with_detail(step.sha.clone()),
            );
        }
    }
    if plan.len() != candidates.len() {
        return Err(plan_error(
            "plan",
            "le plan ne contient pas exactement les commits de la plage",
        ));
    }
    let _ = candidates;
    Ok(())
}

fn plan_error(what: &str, reason: &str) -> AppError {
    AppError::new(
        "rebase.plan_invalid",
        ErrorCategory::Input,
        format!("Plan de rebase invalide ({what}) : {reason}."),
    )
}

fn commit_message(runner: &GitRunner, worktree: &Path, sha: &str) -> Result<String, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Show, worktree)
            .arg("-s")
            .arg("--format=%B")
            .arg(sha)
            .capture_limits(CaptureLimits {
                stdout: 64 * 1024,
                stderr: 16 * 1024,
            }),
    )?;
    if !outcome.success() {
        return Err(AppError::new(
            "rebase.message_failed",
            ErrorCategory::GitState,
            "Le message du commit n'a pas pu être lu.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(outcome.stdout.text_lossy())
}

fn write_message(
    directory: &tempfile::TempDir,
    index: usize,
    message: &str,
) -> Result<String, AppError> {
    let path = directory.path().join(format!("message-{index}.txt"));
    std::fs::write(&path, message.as_bytes())
        .map_err(|error| AppError::internal(format!("écriture du message : {error}")))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Quote a path for Git's shell-based editor/exec invocation.
///
/// Paths are generated under a temporary directory; quoting keeps spaces and
/// shell metacharacters inert on POSIX shells used by Git for Windows too.
fn shell_quote(value: &str) -> String {
    let normalized = if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.to_owned()
    };
    format!("'{}'", normalized.replace('\'', "'\\''"))
}

/// Cherry-pick a list of commits in order. The caller supplies the selection
/// order; conflicts pause the sequencer and are returned as state.
pub fn cherry_pick(
    runner: &GitRunner,
    worktree: &Path,
    shas: &[String],
) -> Result<HistoryOutcome, AppError> {
    sequence_by_commits(runner, worktree, shas, GitSubcommand::CherryPick)
}

/// Revert a list of commits in order.
pub fn revert(
    runner: &GitRunner,
    worktree: &Path,
    shas: &[String],
) -> Result<HistoryOutcome, AppError> {
    sequence_by_commits(runner, worktree, shas, GitSubcommand::Revert)
}

fn sequence_by_commits(
    runner: &GitRunner,
    worktree: &Path,
    shas: &[String],
    command: GitSubcommand,
) -> Result<HistoryOutcome, AppError> {
    if shas.is_empty() {
        return Err(AppError::invalid_input(
            "Sélectionnez au moins un commit.".to_owned(),
        ));
    }
    ensure_idle(runner, worktree)?;
    let status = read_status(runner, worktree, Some(1))?;
    if status.counts.staged > 0 || status.counts.unstaged > 0 {
        return Err(AppError::new(
            "git.dirty_worktree",
            ErrorCategory::GitState,
            "Des modifications locales empêchent l'opération.",
        )
        .with_remediation("Committez ou stashez vos modifications, puis relancez l'opération."));
    }
    let mut spec = CommandSpec::new(command, worktree)
        .arg("--no-edit")
        .capture_limits(output_limits());
    for sha in shas {
        crate::log::validate_revision(sha)?;
        spec = spec.arg(sha);
    }
    run_stateful(runner, worktree, spec)
}

fn run_stateful(
    runner: &GitRunner,
    worktree: &Path,
    spec: CommandSpec,
) -> Result<HistoryOutcome, AppError> {
    let outcome = runner.run(&spec)?;
    let output = join_output(outcome.stdout.redacted(), outcome.stderr.redacted());
    let detected = detect_state(runner, worktree)?;
    let conflicted = !detected.state.conflicts.is_empty();
    if outcome.success() || conflicted {
        return Ok(HistoryOutcome {
            state: detected.state,
            output,
            conflicted,
        });
    }
    let mut error = beebranch_core::classify_git_failure(outcome.exit_code(), &output);
    if error.code == "git.exit_unknown" {
        error = AppError::new(
            "git.operation_failed",
            ErrorCategory::GitExit,
            "L'opération Git a échoué.",
        );
    }
    Err(error
        .with_detail(output)
        .with_remediation("Lisez la sortie, vérifiez l'état du dépôt, puis réessayez."))
}

fn detect_state(runner: &GitRunner, worktree: &Path) -> Result<DetectedState, AppError> {
    let discovery = discover(runner, worktree)?;
    detect(runner, &discovery, None)
}

fn continue_command(state: &RepoState) -> Option<GitSubcommand> {
    match state.operation {
        Some(InProgressOperation::Merge) => Some(GitSubcommand::Merge),
        Some(InProgressOperation::Rebase { .. }) => Some(GitSubcommand::Rebase),
        Some(InProgressOperation::CherryPick) => Some(GitSubcommand::CherryPick),
        Some(InProgressOperation::Revert) => Some(GitSubcommand::Revert),
        Some(InProgressOperation::Sequencer { sequencer }) => Some(match sequencer {
            SequencerKind::CherryPick => GitSubcommand::CherryPick,
            SequencerKind::Revert => GitSubcommand::Revert,
        }),
        _ => None,
    }
}

fn skip_command(state: &RepoState) -> Option<GitSubcommand> {
    match state.operation {
        Some(InProgressOperation::Rebase { .. }) => Some(GitSubcommand::Rebase),
        Some(InProgressOperation::CherryPick) => Some(GitSubcommand::CherryPick),
        Some(InProgressOperation::Revert) => Some(GitSubcommand::Revert),
        Some(InProgressOperation::Sequencer { sequencer }) => Some(match sequencer {
            SequencerKind::CherryPick => GitSubcommand::CherryPick,
            SequencerKind::Revert => GitSubcommand::Revert,
        }),
        _ => None,
    }
}

fn abort_command(state: &RepoState) -> Option<GitSubcommand> {
    match state.operation {
        Some(InProgressOperation::Merge) => Some(GitSubcommand::Merge),
        Some(InProgressOperation::Rebase { .. }) => Some(GitSubcommand::Rebase),
        Some(InProgressOperation::CherryPick) => Some(GitSubcommand::CherryPick),
        Some(InProgressOperation::Revert) => Some(GitSubcommand::Revert),
        Some(InProgressOperation::Sequencer { sequencer }) => Some(match sequencer {
            SequencerKind::CherryPick => GitSubcommand::CherryPick,
            SequencerKind::Revert => GitSubcommand::Revert,
        }),
        _ => None,
    }
}

fn no_operation() -> AppError {
    AppError::new(
        "operation.none",
        ErrorCategory::GitState,
        "Aucune opération Git n'est en cours.",
    )
}

fn output_limits() -> CaptureLimits {
    CaptureLimits {
        stdout: 1024 * 1024,
        stderr: 1024 * 1024,
    }
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
    fn maps_operation_to_command() {
        let merge = RepoState {
            operation: Some(InProgressOperation::Merge),
            ..RepoState::default()
        };
        assert_eq!(continue_command(&merge), Some(GitSubcommand::Merge));
        assert_eq!(abort_command(&merge), Some(GitSubcommand::Merge));
        assert_eq!(skip_command(&merge), None);

        let rebase = RepoState {
            operation: Some(InProgressOperation::Rebase {
                variant: beebranch_core::RebaseVariant::Merge,
            }),
            ..RepoState::default()
        };
        assert_eq!(continue_command(&rebase), Some(GitSubcommand::Rebase));
        assert_eq!(skip_command(&rebase), Some(GitSubcommand::Rebase));
    }
}
