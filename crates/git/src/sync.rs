//! Network synchronization: fetch, pull and push.
//!
//! Commands stream progress, have no timeout (slow networks are legitimate)
//! and return a cancellable handle. Cancellation is graceful: the process gets
//! SIGTERM then a forced termination after the runner's grace period. The
//! caller revalidates the remote state afterwards.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{
    CaptureLimits, CommandSpec, GitRunner, OperationContext, ProcessEvent, RunningCommand,
};
use crate::status::read_status;
use crate::GitSubcommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    Auto,
    FfOnly,
    Rebase,
    Merge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncKind {
    Fetch,
    Pull,
    Push,
}

impl SyncKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Pull => "pull",
            Self::Push => "push",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub kind: SyncKind,
    /// Redacted tail of stdout/stderr (progress lines included).
    pub output: String,
    pub cancelled: bool,
    /// Remote SHA observed after cancellation, when it could be checked.
    pub remote_sha: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PushRequest {
    pub remote: String,
    pub branch: String,
    pub set_upstream: bool,
    /// Explicit `--force-with-lease` expected SHA. Never inferred.
    pub force_with_lease: Option<String>,
}

fn streaming_spec(
    subcommand: GitSubcommand,
    worktree: &Path,
    operation: &OperationContext,
) -> CommandSpec {
    CommandSpec::new(subcommand, worktree)
        .no_timeout()
        .streaming()
        .operation(operation.clone())
        .capture_limits(CaptureLimits {
            stdout: 1024 * 1024,
            stderr: 1024 * 1024,
        })
}

fn validate_remote(remote: &str) -> Result<(), AppError> {
    if remote.is_empty()
        || remote.starts_with('-')
        || remote.contains('\0')
        || remote.contains(char::is_whitespace)
    {
        return Err(AppError::invalid_input(format!(
            "remote invalide: {remote:?}"
        )));
    }
    Ok(())
}

fn validate_branch(branch: &str) -> Result<(), AppError> {
    if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
        return Err(AppError::invalid_input(format!(
            "branche invalide: {branch:?}"
        )));
    }
    Ok(())
}

/// Start a streaming fetch.
pub fn spawn_fetch<F>(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    operation: &OperationContext,
    on_event: F,
) -> Result<RunningCommand, AppError>
where
    F: FnMut(ProcessEvent) + Send + 'static,
{
    validate_remote(remote)?;
    let spec = streaming_spec(GitSubcommand::Fetch, worktree, operation)
        .arg("--prune")
        .arg("--progress")
        .arg(remote);
    runner.spawn(&spec, on_event).map_err(AppError::from)
}

/// Resolve the effective pull strategy, reading `pull.rebase` when `Auto`.
pub fn resolve_pull_strategy(
    runner: &GitRunner,
    worktree: &Path,
    strategy: PullStrategy,
) -> Result<PullStrategy, AppError> {
    if strategy != PullStrategy::Auto {
        return Ok(strategy);
    }
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Config, worktree)
            .arg("--get")
            .arg("pull.rebase"),
    )?;
    if !outcome.success() {
        return Ok(PullStrategy::Merge);
    }
    let value = outcome.stdout.text_lossy().trim().to_ascii_lowercase();
    Ok(match value.as_str() {
        "true" | "yes" | "on" | "1" => PullStrategy::Rebase,
        "merges" => PullStrategy::Merge,
        _ => PullStrategy::Merge,
    })
}

/// Start a streaming pull. Refuses a dirty worktree before Git runs.
pub fn spawn_pull<F>(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    branch: &str,
    strategy: PullStrategy,
    operation: &OperationContext,
    on_event: F,
) -> Result<RunningCommand, AppError>
where
    F: FnMut(ProcessEvent) + Send + 'static,
{
    validate_remote(remote)?;
    validate_branch(branch)?;
    crate::branches::validate_branch_name(runner, worktree, branch)?;
    let status = read_status(runner, worktree, Some(1))?;
    if status.counts.staged > 0 || status.counts.unstaged > 0 || status.counts.conflicted > 0 {
        return Err(AppError::new(
            "git.dirty_worktree",
            ErrorCategory::GitState,
            "Des modifications locales empêchent le pull.",
        )
        .with_remediation("Committez ou stashez vos modifications, puis relancez le pull."));
    }

    let strategy = resolve_pull_strategy(runner, worktree, strategy)?;
    let mut spec = streaming_spec(GitSubcommand::Pull, worktree, operation).arg("--progress");
    spec = match strategy {
        PullStrategy::FfOnly => spec.arg("--ff-only"),
        PullStrategy::Rebase => spec.arg("--rebase"),
        PullStrategy::Merge | PullStrategy::Auto => spec.arg("--no-rebase"),
    };
    spec = spec.arg(remote).arg(branch);
    runner.spawn(&spec, on_event).map_err(AppError::from)
}

/// Start a streaming push.
pub fn spawn_push<F>(
    runner: &GitRunner,
    worktree: &Path,
    request: &PushRequest,
    operation: &OperationContext,
    on_event: F,
) -> Result<RunningCommand, AppError>
where
    F: FnMut(ProcessEvent) + Send + 'static,
{
    validate_remote(&request.remote)?;
    validate_branch(&request.branch)?;
    crate::branches::validate_branch_name(runner, worktree, &request.branch)?;
    let mut spec = streaming_spec(GitSubcommand::Push, worktree, operation).arg("--progress");
    if request.set_upstream {
        spec = spec.arg("--set-upstream");
    }
    if let Some(expected) = &request.force_with_lease {
        if expected.is_empty()
            || expected.starts_with('-')
            || expected.contains('\0')
            || expected.contains(':')
            || expected.contains(char::is_whitespace)
        {
            return Err(AppError::invalid_input(
                "SHA attendu invalide pour --force-with-lease".to_owned(),
            ));
        }
        spec = spec.arg(format!(
            "--force-with-lease=refs/heads/{}:{expected}",
            request.branch
        ));
    }
    spec = spec.arg(&request.remote).arg(&request.branch);
    runner.spawn(&spec, on_event).map_err(AppError::from)
}

/// Wait for a sync command and convert its result.
///
/// `remote_check` is called when the operation was cancelled; it should return
/// the remote SHA for the pushed/fetched ref so the UI can state whether the
/// remote changed despite the cancellation.
pub fn finish(
    command: RunningCommand,
    kind: SyncKind,
    remote_check: impl FnOnce() -> Option<String>,
) -> Result<SyncOutcome, AppError> {
    match command.wait() {
        Ok(outcome) => {
            let output = join_output(outcome.stdout.redacted(), outcome.stderr.redacted());
            Ok(SyncOutcome {
                kind,
                output,
                cancelled: false,
                remote_sha: None,
            })
        }
        Err(error) => {
            if error.code() == crate::GitErrorCode::Cancelled {
                let remote_sha = remote_check();
                let detail = match &remote_sha {
                    Some(sha) => format!(
                        "{}\nÉtat distant revérifié : {sha}",
                        error.detail().unwrap_or_default()
                    ),
                    None => error.detail().unwrap_or_default().to_owned(),
                };
                return Err(AppError::cancelled(detail).with_remediation(
                    "Vérifiez l'état du dépôt et du remote avant de relancer l'opération.",
                ));
            }
            Err(error.into())
        }
    }
}

/// Read the SHA of a remote branch with `git ls-remote --heads`.
pub fn remote_branch_sha(
    runner: &GitRunner,
    worktree: &Path,
    remote: &str,
    branch: &str,
) -> Option<String> {
    if validate_remote(remote).is_err()
        || validate_branch(branch).is_err()
        || crate::branches::validate_branch_name(runner, worktree, branch).is_err()
    {
        return None;
    }
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::LsRemote, worktree)
                .arg("--heads")
                .arg(remote)
                .arg(format!("refs/heads/{branch}"))
                .timeout(std::time::Duration::from_secs(20)),
        )
        .ok()?;
    if !outcome.success() {
        return None;
    }
    let text = outcome.stdout.text_lossy();
    text.lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .map(str::to_owned)
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
    fn rejects_option_injection() {
        assert!(validate_remote("--upload-pack=evil").is_err());
        assert!(validate_branch("-f").is_err());
        assert!(validate_remote("origin").is_ok());
        assert!(validate_branch("feature/x").is_ok());
    }
}
