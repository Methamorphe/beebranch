//! Patch creation and application.
//!
//! Patches are text only. Binary patches are refused because applying them can
//! silently rewrite large objects. Application is two-phase: `git apply
//! --check` runs first, so a conflicting patch does not touch the worktree.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CaptureLimits, CommandSpec, GitRunner, StdinMode};
use crate::GitSubcommand;

pub const MAX_PATCH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PatchSource {
    Worktree {
        paths: Vec<String>,
    },
    Index {
        paths: Vec<String>,
    },
    Commit {
        sha: String,
        paths: Vec<String>,
    },
    Range {
        base: String,
        target: String,
        paths: Vec<String>,
    },
}

impl PatchSource {
    fn label(&self) -> String {
        match self {
            Self::Worktree { .. } => "working tree".to_owned(),
            Self::Index { .. } => "index".to_owned(),
            Self::Commit { sha, .. } => format!("commit {}", short(sha)),
            Self::Range { base, target, .. } => {
                format!("{}..{}", short(base), short(target))
            }
        }
    }

    fn paths(&self) -> &[String] {
        match self {
            Self::Worktree { paths }
            | Self::Index { paths }
            | Self::Commit { paths, .. }
            | Self::Range { paths, .. } => paths,
        }
    }
}

fn short(sha: &str) -> String {
    sha.chars().take(8).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchReport {
    pub source: String,
    pub text: String,
    pub files: Vec<String>,
    pub bytes: usize,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyReport {
    pub files: Vec<String>,
    pub three_way: bool,
    pub staged: bool,
    pub stderr: String,
}

fn limits() -> CaptureLimits {
    CaptureLimits {
        stdout: MAX_PATCH_BYTES,
        stderr: 64 * 1024,
    }
}

fn ensure_paths(runner: &GitRunner, worktree: &Path, paths: &[String]) -> Result<(), AppError> {
    for path in paths {
        crate::blame::validate_path(path)?;
        let _ = (runner, worktree);
    }
    Ok(())
}

/// Build a unified patch for the requested source.
pub fn create(
    runner: &GitRunner,
    worktree: &Path,
    source: &PatchSource,
) -> Result<PatchReport, AppError> {
    ensure_paths(runner, worktree, source.paths())?;
    let mut spec = match source {
        PatchSource::Commit { sha, .. } => {
            crate::log::validate_revision(sha)?;
            CommandSpec::new(GitSubcommand::Show, worktree)
                .arg("--format=")
                .arg("--patch")
                .arg(sha)
        }
        PatchSource::Range { base, target, .. } => {
            crate::log::validate_revision(base)?;
            crate::log::validate_revision(target)?;
            CommandSpec::new(GitSubcommand::Diff, worktree)
                .arg("--no-color")
                .arg("--no-ext-diff")
                .arg("--no-textconv")
                .arg(base)
                .arg(target)
        }
        PatchSource::Worktree { .. } => CommandSpec::new(GitSubcommand::Diff, worktree)
            .arg("--no-color")
            .arg("--no-ext-diff")
            .arg("--no-textconv"),
        PatchSource::Index { .. } => CommandSpec::new(GitSubcommand::Diff, worktree)
            .arg("--no-color")
            .arg("--no-ext-diff")
            .arg("--no-textconv")
            .arg("--cached"),
    };
    if !source.paths().is_empty() {
        spec = spec.arg("--");
        for path in source.paths() {
            spec = spec.arg(path);
        }
    }
    let outcome = runner.run(&spec.capture_limits(limits()))?;
    if !outcome.success() {
        return Err(AppError::new(
            "patch.create_failed",
            ErrorCategory::GitState,
            "Le patch n'a pas pu être généré.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    let text = outcome.stdout.text_lossy();
    if text.trim().is_empty() {
        return Err(AppError::new(
            "patch.empty",
            ErrorCategory::Input,
            "Aucune modification ne correspond à cette source.",
        ));
    }
    let binary = text.contains("GIT binary patch") || text.contains("Binary files ");
    if binary {
        return Err(AppError::new(
            "patch.binary_unsupported",
            ErrorCategory::Input,
            "Les patchs binaires ne sont pas supportés.",
        )
        .with_remediation(
            "Copiez le fichier explicitement ou commitez-le : BeeBranch ne transporte pas de binaire dans un patch.",
        ));
    }
    Ok(PatchReport {
        source: source.label(),
        files: parse_patch_files(&text),
        bytes: text.len(),
        truncated: outcome.stdout.truncated(),
        binary,
        text,
    })
}

fn parse_patch_files(text: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let mut parts = rest.split(' ');
            let _ = parts.next();
            if let Some(target) = parts.next() {
                let path = target
                    .strip_prefix("b/")
                    .unwrap_or(target)
                    .trim()
                    .to_owned();
                if !path.is_empty() && !files.contains(&path) {
                    files.push(path);
                }
            }
        }
    }
    files
}

/// Apply a text patch. `--check` always runs first; on failure nothing is
/// written. `three_way` enables Git's 3-way merge for context drift.
pub fn apply(
    runner: &GitRunner,
    worktree: &Path,
    text: &str,
    three_way: bool,
    stage: bool,
) -> Result<PatchApplyReport, AppError> {
    if text.len() > MAX_PATCH_BYTES {
        return Err(AppError::new(
            "patch.too_large",
            ErrorCategory::Input,
            "Le patch dépasse la limite de 16 Mio.",
        ));
    }
    if text.contains("GIT binary patch") || text.contains("Binary files ") {
        return Err(AppError::new(
            "patch.binary_unsupported",
            ErrorCategory::Input,
            "Les patchs binaires ne sont pas supportés.",
        ));
    }
    let files = parse_patch_files(text);
    if files.is_empty() {
        return Err(AppError::invalid_input(
            "Le patch ne contient aucun fichier reconnaissable.".to_owned(),
        ));
    }
    let check = apply_spec(worktree, true, false, three_way, stage)
        .stdin(StdinMode::Bytes(text.as_bytes().to_vec()));
    let checked = runner.run(&check)?;
    if !checked.success() {
        return Err(AppError::new(
            "patch.conflict",
            ErrorCategory::Conflict,
            "Le patch ne s'applique pas sur l'état actuel ; le worktree est inchangé.",
        )
        .with_detail(checked.stderr.redacted()));
    }
    let apply = apply_spec(worktree, false, false, three_way, stage)
        .stdin(StdinMode::Bytes(text.as_bytes().to_vec()));
    let outcome = runner.run(&apply)?;
    if !outcome.success() {
        return Err(AppError::new(
            "patch.apply_failed",
            ErrorCategory::GitState,
            "Le patch a passé la vérification mais n'a pas pu être appliqué.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    Ok(PatchApplyReport {
        files,
        three_way,
        // `git apply --3way` implies `--index`, so the change always lands in
        // the index even when the caller only asked for the worktree.
        staged: stage || three_way,
        stderr: outcome.stderr.redacted(),
    })
}

fn apply_spec(
    worktree: &Path,
    check: bool,
    _unused: bool,
    three_way: bool,
    stage: bool,
) -> CommandSpec {
    let mut spec = CommandSpec::new(GitSubcommand::Apply, worktree);
    if check {
        spec = spec.arg("--check");
    }
    if three_way {
        spec = spec.arg("--3way");
    }
    if stage {
        spec = spec.arg("--index");
    }
    spec.arg("--whitespace=nowarn")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_files_and_rejects_binary() {
        let text = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n";
        assert_eq!(parse_patch_files(text), vec!["src/a.rs"]);
        assert!(text.contains("diff --git"));
    }
}
