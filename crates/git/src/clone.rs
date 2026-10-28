//! Repository cloning through the single Git process layer.
//!
//! The destination must be an absolute path that does not exist yet, inside an
//! existing parent directory. Credentials embedded in the URL are refused, and
//! a failed clone never deletes or rewrites user files: the partial directory
//! is reported for manual cleanup.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory};

use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::refs_admin::validate_remote_url;
use crate::GitSubcommand;

const CLONE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloneOptions {
    pub branch: Option<String>,
    pub depth: Option<u32>,
    pub recurse_submodules: bool,
    /// Credentials for an HTTPS clone of the active GitLab instance.
    ///
    /// The token is written to a 0600 temporary file; Git reads it through a
    /// generated `GIT_ASKPASS` helper. It is never placed in argv, the URL or
    /// the process environment.
    pub https_auth: Option<HttpsAuth>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HttpsAuth {
    pub username: String,
    pub token: String,
}

impl std::fmt::Debug for HttpsAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpsAuth")
            .field("username", &self.username)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

struct Askpass {
    _directory: tempfile::TempDir,
    script: PathBuf,
    token_file: PathBuf,
}

fn askpass(auth: &HttpsAuth) -> Result<Askpass, AppError> {
    let directory = tempfile::tempdir()
        .map_err(|error| AppError::internal(format!("répertoire askpass de clone : {error}")))?;
    let token_file = directory.path().join("token");
    std::fs::write(&token_file, auth.token.as_bytes()).map_err(|error| {
        AppError::new(
            "clone.askpass_failed",
            ErrorCategory::Permission,
            "Impossible de préparer l'authentification HTTPS du clone.",
        )
        .with_detail(error.to_string())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::internal(format!("permissions token : {error}")))?;
    }

    #[cfg(unix)]
    let (script, content) = (
        directory.path().join("askpass.sh"),
        format!(
            "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%s\\n' {} ;;\n  *) cat \"$BEEBRANCH_CLONE_TOKEN_FILE\" ;;\nesac\n",
            shell_single_quote(&auth.username)
        ),
    );
    #[cfg(windows)]
    let (script, content) = (
        directory.path().join("askpass.bat"),
        "@echo off\r\necho %1 | findstr /I \"Username\" >nul\r\nif %errorlevel%==0 (echo oauth2) else (type \"%BEEBRANCH_CLONE_TOKEN_FILE%\")\r\n".to_owned(),
    );

    std::fs::write(&script, content.as_bytes())
        .map_err(|error| AppError::internal(format!("écriture askpass : {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| AppError::internal(format!("permissions askpass : {error}")))?;
    }

    Ok(Askpass {
        _directory: directory,
        script,
        token_file,
    })
}

#[cfg(unix)]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn validate_destination(destination: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(destination);
    if destination.trim().is_empty() {
        return Err(AppError::invalid_input(
            "Le dossier de destination est vide.".to_owned(),
        ));
    }
    if !path.is_absolute() {
        return Err(AppError::invalid_input(
            "Le dossier de destination doit être un chemin absolu.".to_owned(),
        ));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "Le chemin de destination ne peut pas remonter avec `..`.".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "Le clone ne peut pas être créé dans un dossier `.git`.".to_owned(),
                ));
            }
            _ => {}
        }
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::invalid_input("Le dossier parent de la destination est introuvable.".to_owned())
    })?;
    if !parent.is_dir() {
        return Err(AppError::invalid_input(format!(
            "Le dossier parent n'existe pas : {}",
            parent.display()
        ))
        .with_remediation("Créez le dossier parent ou choisissez un autre emplacement."));
    }
    if path.exists() {
        return Err(AppError::new(
            "clone.destination_exists",
            ErrorCategory::Input,
            "La destination existe déjà.",
        )
        .with_detail(path.display().to_string())
        .with_remediation("Choisissez un dossier inexistant pour éviter d'écraser des fichiers."));
    }
    Ok(path.to_path_buf())
}

/// Clone `url` into `destination` and return the canonical worktree path.
pub fn clone(
    runner: &GitRunner,
    url: &str,
    destination: &str,
    options: &CloneOptions,
) -> Result<PathBuf, AppError> {
    validate_remote_url(url)?;
    let target = validate_destination(destination)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::internal("clone sans dossier parent"))?
        .to_path_buf();

    let mut spec = CommandSpec::new(GitSubcommand::Clone, &parent)
        .arg("--progress")
        .timeout(CLONE_TIMEOUT)
        .capture_limits(CaptureLimits {
            stdout: 2 * 1024 * 1024,
            stderr: 2 * 1024 * 1024,
        });
    if let Some(depth) = options.depth {
        if !(1..=10_000).contains(&depth) {
            return Err(AppError::invalid_input(
                "La profondeur de clone doit être comprise entre 1 et 10 000.".to_owned(),
            ));
        }
        spec = spec.arg(format!("--depth={depth}"));
    }
    if let Some(branch) = options.branch.as_deref() {
        crate::branches::validate_branch_name(runner, &parent, branch)?;
        spec = spec.arg("--branch").arg(branch);
    }
    if options.recurse_submodules {
        spec = spec.arg("--recurse-submodules");
    }
    let askpass = options.https_auth.as_ref().map(askpass).transpose()?;
    if let Some(helper) = askpass.as_ref() {
        spec = spec
            .env("GIT_ASKPASS", helper.script.as_os_str())
            .env("GIT_ASKPASS_REQUIRE", "force")
            .env("BEEBRANCH_CLONE_TOKEN_FILE", helper.token_file.as_os_str());
    }
    spec = spec.arg(url).arg(target.as_os_str());

    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        let output = format!("{}{}", outcome.stdout.redacted(), outcome.stderr.redacted());
        let error = if output.contains("Host key verification failed") {
            AppError::new(
                "clone.host_key",
                ErrorCategory::Auth,
                "La clé d'hôte SSH du serveur n'est pas vérifiée.",
            )
            .with_remediation(
                "Ajoutez l'empreinte de l'hôte à known_hosts, ou clonez en HTTPS avec la connexion GitLab.",
            )
        } else if output.contains("Permission denied (publickey)") {
            AppError::new(
                "clone.ssh_auth",
                ErrorCategory::Auth,
                "Le serveur SSH a refusé la clé publique.",
            )
            .with_remediation(
                "Chargez la clé dans l'agent SSH, vérifiez que la clé publique est déclarée dans GitLab, ou utilisez HTTPS.",
            )
        } else if output.contains("Authentication failed")
            || output.contains("could not read Username")
            || output.contains("terminal prompts disabled")
        {
            AppError::new(
                "clone.https_auth",
                ErrorCategory::Auth,
                "L'authentification HTTPS du dépôt a échoué.",
            )
            .with_remediation(
                "Connectez l'instance GitLab pour utiliser son token, ou choisissez SSH avec une clé déclarée.",
            )
        } else {
            beebranch_core::classify_git_failure(outcome.exit_code(), &output)
        };
        return Err(error.with_detail(output).with_remediation(
            "Vérifiez l'URL et vos droits. Un dossier partiel peut subsister à la destination.",
        ));
    }
    let canonical = target.canonicalize().map_err(|error| {
        AppError::new(
            "clone.destination_missing",
            ErrorCategory::GitState,
            "Le clone s'est terminé sans worktree lisible.",
        )
        .with_detail(error.to_string())
    })?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "clone.not_a_repository",
            ErrorCategory::GitState,
            "Le dossier cloné n'est pas un worktree.",
        )
        .with_detail(canonical.display().to_string()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_existing_destinations() {
        assert!(validate_destination("relative/path").is_err());
        assert!(validate_destination("/tmp/../escape").is_err());
        let existing = std::env::temp_dir();
        assert!(validate_destination(&existing.display().to_string()).is_err());
    }

    #[test]
    fn rejects_credentials_in_url() {
        assert!(validate_remote_url("https://user:secret@example.test/repo.git").is_err());
        assert!(validate_remote_url("https://example.test/repo.git").is_ok());
    }
}

#[cfg(all(test, unix))]
mod askpass_tests {
    use super::*;

    #[test]
    fn askpass_returns_oauth2_username_and_the_token() {
        let auth = HttpsAuth {
            username: "oauth2".to_owned(),
            token: "glpat-secret".to_owned(),
        };
        let helper = askpass(&auth).expect("askpass");
        let run = |prompt: &str| {
            std::process::Command::new(&helper.script)
                .arg(prompt)
                .env("BEEBRANCH_CLONE_TOKEN_FILE", &helper.token_file)
                .output()
                .expect("run askpass")
        };
        let username = run("Username for 'https://gitlab.example.test': ");
        assert_eq!(String::from_utf8_lossy(&username.stdout).trim(), "oauth2");
        let password = run("Password for 'https://oauth2@gitlab.example.test': ");
        assert_eq!(
            String::from_utf8_lossy(&password.stdout).trim(),
            "glpat-secret"
        );
    }
}
