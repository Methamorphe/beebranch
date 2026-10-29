//! Git hooks: discovery only.
//!
//! BeeBranch never executes a hook itself: every subcommand goes to the `git`
//! binary without `--no-verify`, so Git runs the hooks it resolves. This module
//! only reads that resolution so the UI can announce which hooks are about to
//! run and attribute their streamed output.

use std::path::{Path, PathBuf};

use beebranch_core::AppError;

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Git operation a hook belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookPoint {
    Commit,
    Push,
}

impl HookPoint {
    /// Hooks Git executes for this point, in execution order.
    pub const fn names(self) -> &'static [&'static str] {
        match self {
            Self::Commit => &["pre-commit", "prepare-commit-msg", "commit-msg"],
            Self::Push => &["pre-push"],
        }
    }
}

/// Executable hook Git will run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveHook {
    pub name: String,
    pub path: PathBuf,
}

/// Hooks Git will run for `point`, in execution order.
///
/// The directory comes from `git rev-parse --git-path hooks`, so
/// `core.hooksPath` (relative, absolute or `~`) and linked worktrees are
/// resolved exactly as Git resolves them. Files without the executable bit are
/// skipped because Git skips them too.
pub fn active(
    runner: &GitRunner,
    worktree: &Path,
    point: HookPoint,
) -> Result<Vec<ActiveHook>, AppError> {
    let directory = directory(runner, worktree)?;
    Ok(point
        .names()
        .iter()
        .map(|name| (name, directory.join(name)))
        .filter(|(_, path)| is_executable(path))
        .map(|(name, path)| ActiveHook {
            name: (*name).to_owned(),
            path,
        })
        .collect())
}

fn directory(runner: &GitRunner, worktree: &Path) -> Result<PathBuf, AppError> {
    let outcome = runner
        .run(&CommandSpec::new(GitSubcommand::RevParse, worktree).args(["--git-path", "hooks"]))?;
    let raw = outcome.stdout.text_lossy();
    let path = PathBuf::from(raw.trim());
    if !outcome.success() || path.as_os_str().is_empty() {
        return Err(AppError::new(
            "hooks.unresolved",
            beebranch_core::ErrorCategory::GitExit,
            "Impossible de résoudre le répertoire des hooks Git.",
        )
        .with_detail(outcome.stderr.text_lossy())
        .with_remediation("Vérifiez core.hooksPath et l'état du dépôt."));
    }
    Ok(if path.is_absolute() {
        path
    } else {
        worktree.join(path)
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}
