//! Local repository creation through the single Git process layer.
//!
//! The destination may be a new directory or an existing directory that is not
//! already a Git worktree. Existing files are never moved, overwritten or
//! deleted: `git init` only adds the Git metadata, and those files stay
//! untracked.

use std::path::{Component, Path, PathBuf};

use beebranch_core::{AppError, ErrorCategory};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitOptions {
    /// Optional initial branch. When omitted, Git applies `init.defaultBranch`
    /// and its own fallback.
    pub initial_branch: Option<String>,
}

fn has_git_metadata(path: &Path) -> bool {
    path.join(".git").exists()
        || (path.join("HEAD").is_file()
            && path.join("objects").is_dir()
            && path.join("refs").is_dir()
            && path.join("config").is_file())
}

fn validate_destination(destination: &str) -> Result<PathBuf, AppError> {
    if destination.trim().is_empty() {
        return Err(AppError::invalid_input(
            "Le dossier du nouveau dépôt est vide.".to_owned(),
        ));
    }
    let path = Path::new(destination);
    if !path.is_absolute() {
        return Err(AppError::invalid_input(
            "Le dossier du nouveau dépôt doit être un chemin absolu.".to_owned(),
        ));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "Le chemin du nouveau dépôt ne peut pas remonter avec `..`.".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "Le nouveau dépôt ne peut pas être créé dans un dossier `.git`.".to_owned(),
                ));
            }
            _ => {}
        }
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::invalid_input("Le dossier parent du nouveau dépôt est introuvable.".to_owned())
    })?;
    if !parent.is_dir() {
        return Err(AppError::new(
            "init.parent_missing",
            ErrorCategory::Input,
            "Le dossier parent n'existe pas.",
        )
        .with_detail(parent.display().to_string())
        .with_remediation("Créez le dossier parent ou choisissez un autre emplacement."));
    }
    if path.exists() {
        if !path.is_dir() {
            return Err(AppError::new(
                "init.destination_not_directory",
                ErrorCategory::Input,
                "La destination existe mais n'est pas un dossier.",
            )
            .with_detail(path.display().to_string())
            .with_remediation("Choisissez un autre emplacement."));
        }
        if has_git_metadata(path) {
            return Err(AppError::new(
                "init.already_repository",
                ErrorCategory::Repo,
                "Ce dossier contient déjà un dépôt Git.",
            )
            .with_detail(path.display().to_string())
            .with_remediation("Ouvrez ce dépôt au lieu de le réinitialiser."));
        }
    }
    Ok(path.to_path_buf())
}

/// Initialize a repository at `destination` and return its canonical worktree.
pub fn init(
    runner: &GitRunner,
    destination: &str,
    options: &InitOptions,
) -> Result<PathBuf, AppError> {
    let target = validate_destination(destination)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::internal("création de dépôt sans dossier parent"))?
        .to_path_buf();

    let initial_branch = options
        .initial_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty());

    let mut spec = CommandSpec::new(GitSubcommand::Init, &parent).arg("--quiet");
    if let Some(branch) = initial_branch {
        crate::branches::validate_branch_name(runner, &parent, branch)?;
        spec = spec.arg(format!("--initial-branch={branch}"));
    }
    spec = spec.arg(&target);

    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        let output = format!("{}{}", outcome.stdout.redacted(), outcome.stderr.redacted());
        let error = beebranch_core::classify_git_failure(outcome.exit_code(), &output);
        return Err(error.with_detail(output).with_remediation(
            "Vérifiez que le dossier parent est accessible en écriture et que le chemin est valide.",
        ));
    }

    let canonical = target.canonicalize().map_err(|error| {
        AppError::new(
            "init.destination_missing",
            ErrorCategory::GitState,
            "La création du dépôt s'est terminée sans dossier lisible.",
        )
        .with_detail(error.to_string())
    })?;
    if !canonical.is_dir() || !canonical.join(".git").exists() {
        return Err(AppError::new(
            "init.not_a_repository",
            ErrorCategory::GitState,
            "Le dossier créé n'est pas un dépôt Git.",
        )
        .with_detail(canonical.display().to_string()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> GitRunner {
        GitRunner::detect().expect("git")
    }

    #[test]
    fn rejects_relative_dot_git_and_missing_parents() {
        assert!(validate_destination("relative/path").is_err());
        assert!(validate_destination("/tmp/../escape").is_err());
        assert!(validate_destination("/tmp/repo/.git").is_err());
        let missing = std::env::temp_dir()
            .join("beebranch-missing-parent")
            .join("repo");
        assert_eq!(
            validate_destination(&missing.display().to_string())
                .expect_err("missing parent")
                .code,
            "init.parent_missing"
        );
    }

    #[test]
    fn rejects_a_file_and_an_existing_repository() {
        let root = tempfile::tempdir().expect("tempdir");
        let file = root.path().join("file");
        std::fs::write(&file, b"x").expect("file");
        assert_eq!(
            validate_destination(&file.display().to_string())
                .expect_err("file")
                .code,
            "init.destination_not_directory"
        );

        let repository = root.path().join("repo");
        init(
            &runner(),
            &repository.display().to_string(),
            &InitOptions::default(),
        )
        .expect("init");
        assert_eq!(
            init(
                &runner(),
                &repository.display().to_string(),
                &InitOptions::default()
            )
            .expect_err("already initialised")
            .code,
            "init.already_repository"
        );
    }
}
