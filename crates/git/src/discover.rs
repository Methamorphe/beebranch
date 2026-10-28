//! Repository, worktree, submodule and bare discovery.

use std::path::{Path, PathBuf};

use beebranch_core::{AppError, ErrorCategory};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Structural location information for a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoDiscovery {
    /// Working tree root. `None` for a bare repository or a `.git` directory.
    pub worktree: Option<PathBuf>,
    /// Absolute per-worktree Git directory.
    pub git_dir: PathBuf,
    /// Common directory shared by every worktree.
    pub common_dir: PathBuf,
    pub bare: bool,
    pub inside_worktree: bool,
    /// True for a linked worktree (`git worktree add`).
    pub linked_worktree: bool,
    /// True when this repository is a submodule of another repository.
    pub submodule: bool,
    pub superproject: Option<PathBuf>,
    /// Shallow repositories are supported read-only.
    pub shallow: bool,
}

impl RepoDiscovery {
    pub fn worktree(&self) -> Result<&Path, AppError> {
        self.worktree.as_deref().ok_or_else(|| {
            AppError::new(
                "repo.bare",
                ErrorCategory::Repo,
                "Le dépôt n'a pas de worktree.",
            )
            .with_remediation("Ouvrez un worktree associé, ou un dépôt non bare.")
        })
    }
}

/// Discover a repository from a filesystem path.
///
/// The path must exist and be a directory. A path that is not a Git
/// repository returns `repo.not_git`.
pub fn discover(runner: &GitRunner, path: impl AsRef<Path>) -> Result<RepoDiscovery, AppError> {
    let requested = path.as_ref();
    let canonical = std::fs::canonicalize(requested).map_err(|error| {
        AppError::new(
            "repo.not_git",
            ErrorCategory::Repo,
            "Le dossier n'existe pas ou n'est pas accessible.",
        )
        .with_detail(format!("{}: {error}", requested.display()))
        .with_remediation("Vérifiez le chemin du dépôt.")
    })?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "repo.not_git",
            ErrorCategory::Repo,
            "Le chemin n'est pas un dossier.",
        )
        .with_detail(canonical.display().to_string())
        .with_remediation("Sélectionnez le dossier d'un dépôt Git."));
    }

    let primary = run_rev_parse(
        runner,
        &canonical,
        &[
            "--path-format=absolute",
            "--absolute-git-dir",
            "--git-common-dir",
            "--is-bare-repository",
            "--is-inside-work-tree",
            "--is-shallow-repository",
        ],
    )?;

    let lines: Vec<&str> = primary.lines().collect();
    if lines.len() < 5 {
        return Err(not_a_repository(&canonical, "sortie rev-parse incomplète"));
    }

    let git_dir = PathBuf::from(lines[0]);
    let common_dir = PathBuf::from(lines[1]);
    let bare = lines[2] == "true";
    let inside_worktree = lines[3] == "true";
    let shallow = lines.get(4).is_some_and(|value| *value == "true");

    let worktree = if bare {
        None
    } else if inside_worktree {
        let top = run_rev_parse(runner, &canonical, &["--show-toplevel"])?;
        let top = top.trim();
        if top.is_empty() {
            Some(canonical.clone())
        } else {
            Some(PathBuf::from(top))
        }
    } else {
        None
    };

    let superproject_output =
        run_rev_parse_optional(runner, &canonical, &["--show-superproject-working-tree"]);
    let superproject = superproject_output
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    Ok(RepoDiscovery {
        linked_worktree: git_dir != common_dir,
        submodule: superproject.is_some(),
        superproject,
        worktree,
        git_dir,
        common_dir,
        bare,
        inside_worktree,
        shallow,
    })
}

fn not_a_repository(path: &Path, detail: &str) -> AppError {
    AppError::new(
        "repo.not_git",
        ErrorCategory::Repo,
        "Le dossier n'est pas un dépôt Git.",
    )
    .with_detail(format!("{}: {detail}", path.display()))
    .with_remediation("Sélectionnez un dépôt Git ou initialisez-en un.")
}

fn run_rev_parse(runner: &GitRunner, cwd: &Path, args: &[&str]) -> Result<String, AppError> {
    let spec = CommandSpec::new(GitSubcommand::RevParse, cwd).args(args.iter().copied());
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        return Err(not_a_repository(cwd, &outcome.stderr.diagnostic()));
    }
    Ok(outcome.stdout.text_lossy())
}

fn run_rev_parse_optional(runner: &GitRunner, cwd: &Path, args: &[&str]) -> Option<String> {
    let spec = CommandSpec::new(GitSubcommand::RevParse, cwd).args(args.iter().copied());
    let outcome = runner.run(&spec).ok()?;
    if outcome.success() {
        Some(outcome.stdout.text_lossy())
    } else {
        None
    }
}
