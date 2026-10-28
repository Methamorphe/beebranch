use std::fmt;
use std::io;
use std::time::Duration;

use crate::redaction;

/// Stable error codes exposed by the process layer.
///
/// P0-T09 maps these codes into the application-wide `AppError`. The string
/// value is the contract: never change it without a migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitErrorCode {
    /// The `git` executable could not be located or is not executable.
    ProgramNotFound,
    /// The process could not be spawned.
    SpawnFailed,
    /// An argument is missing, malformed, or outside the allowlist.
    InvalidArgument,
    /// An environment variable is rejected by the controlled environment.
    InvalidEnvironment,
    /// An I/O error occurred around the process.
    Io,
    /// The command exceeded its timeout.
    Timeout,
    /// The operation was cancelled by the caller.
    Cancelled,
    /// Git exited with a non-zero status.
    ExitFailure,
    /// The detected Git version is below the supported floor.
    UnsupportedVersion,
    /// The version output could not be parsed.
    VersionUnparsable,
    /// An internal invariant failed.
    Internal,
}

impl GitErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProgramNotFound => "git.program_not_found",
            Self::SpawnFailed => "git.spawn_failed",
            Self::InvalidArgument => "git.invalid_argument",
            Self::InvalidEnvironment => "git.invalid_environment",
            Self::Io => "git.io",
            Self::Timeout => "git.timeout",
            Self::Cancelled => "op.cancelled",
            Self::ExitFailure => "git.exit_failure",
            Self::UnsupportedVersion => "git.version_unsupported",
            Self::VersionUnparsable => "git.version_unparsable",
            Self::Internal => "git.internal",
        }
    }
}

impl fmt::Display for GitErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned by the Git process layer.
///
/// `detail` is always bounded and redacted before being stored, so it is safe
/// to log or display. Raw process output stays in [`crate::Captured`] for
/// parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitError {
    code: GitErrorCode,
    message: String,
    detail: Option<String>,
    retryable: bool,
}

impl GitError {
    pub fn code(&self) -> GitErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn retryable(&self) -> bool {
        self.retryable
    }

    pub(crate) fn with_detail(
        code: GitErrorCode,
        message: impl Into<String>,
        detail: Option<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            detail: detail.and_then(bounded_detail),
            retryable: false,
        }
    }

    pub(crate) fn invalid_argument(detail: impl Into<String>) -> Self {
        Self::with_detail(
            GitErrorCode::InvalidArgument,
            "Argument Git refusé.",
            Some(detail.into()),
        )
    }

    pub(crate) fn invalid_environment(detail: impl Into<String>) -> Self {
        Self::with_detail(
            GitErrorCode::InvalidEnvironment,
            "Variable d'environnement Git refusée.",
            Some(detail.into()),
        )
    }

    pub(crate) fn program_not_found(detail: impl Into<String>) -> Self {
        Self::with_detail(
            GitErrorCode::ProgramNotFound,
            "Git est introuvable ou n'est pas exécutable.",
            Some(detail.into()),
        )
    }

    pub(crate) fn spawn_failed(error: io::Error) -> Self {
        Self::with_detail(
            GitErrorCode::SpawnFailed,
            "Impossible de lancer le processus Git.",
            Some(error.to_string()),
        )
    }

    pub(crate) fn io(context: &str, error: impl fmt::Display) -> Self {
        Self::with_detail(
            GitErrorCode::Io,
            "Erreur d'entrée/sortie pendant l'exécution de Git.",
            Some(format!("{context}: {error}")),
        )
    }

    pub(crate) fn timeout(after: Duration, detail: Option<String>) -> Self {
        Self::with_detail(
            GitErrorCode::Timeout,
            format!(
                "La commande Git a dépassé le délai de {:.1} s.",
                after.as_secs_f64()
            ),
            detail,
        )
    }

    pub(crate) fn cancelled(detail: Option<String>) -> Self {
        Self::with_detail(
            GitErrorCode::Cancelled,
            "L'opération Git a été annulée.",
            detail,
        )
    }

    pub(crate) fn exit_failure(exit_code: Option<i32>, detail: String) -> Self {
        let code = exit_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "inconnu".to_owned());
        Self::with_detail(
            GitErrorCode::ExitFailure,
            format!("La commande Git a échoué (code {code})."),
            Some(detail),
        )
    }

    pub(crate) fn unsupported_version(detected: &str) -> Self {
        Self::with_detail(
            GitErrorCode::UnsupportedVersion,
            "Version de Git non prise en charge (minimum 2.34).",
            Some(format!("version détectée : {detected}")),
        )
    }

    pub(crate) fn version_unparsable(detail: String) -> Self {
        Self::with_detail(
            GitErrorCode::VersionUnparsable,
            "La version de Git n'a pas pu être déterminée.",
            Some(detail),
        )
    }

    pub(crate) fn internal(detail: impl Into<String>) -> Self {
        Self::with_detail(
            GitErrorCode::Internal,
            "Erreur interne du moteur Git.",
            Some(detail.into()),
        )
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for GitError {}

impl From<GitError> for beebranch_core::AppError {
    fn from(error: GitError) -> Self {
        use beebranch_core::{classify_git_failure, AppError, ErrorCategory};

        let detail = error.detail.clone().unwrap_or_default();
        match error.code {
            GitErrorCode::ExitFailure => classify_git_failure(None, &detail),
            GitErrorCode::Cancelled => AppError::cancelled(detail),
            GitErrorCode::Timeout => {
                AppError::new("git.timeout", ErrorCategory::GitExit, error.message)
                    .with_detail(detail)
                    .with_remediation("Vérifiez le réseau ou le dépôt, puis réessayez.")
                    .retryable(true)
            }
            GitErrorCode::ProgramNotFound => {
                AppError::new("git.program_not_found", ErrorCategory::Input, error.message)
                    .with_detail(detail)
                    .with_remediation("Installez Git 2.34 ou supérieur et vérifiez PATH.")
            }
            GitErrorCode::UnsupportedVersion => AppError::new(
                "git.version_unsupported",
                ErrorCategory::Input,
                error.message,
            )
            .with_detail(detail)
            .with_remediation("Mettez Git à jour vers la version 2.34 minimum."),
            GitErrorCode::InvalidArgument => {
                AppError::new("git.invalid_argument", ErrorCategory::Input, error.message)
                    .with_detail(detail)
            }
            GitErrorCode::InvalidEnvironment => AppError::new(
                "git.invalid_environment",
                ErrorCategory::Internal,
                error.message,
            )
            .with_detail(detail),
            GitErrorCode::SpawnFailed => {
                AppError::new("git.spawn_failed", ErrorCategory::Internal, error.message)
                    .with_detail(detail)
            }
            GitErrorCode::Io => {
                AppError::new("git.io", ErrorCategory::Internal, error.message).with_detail(detail)
            }
            GitErrorCode::VersionUnparsable => AppError::new(
                "git.version_unparsable",
                ErrorCategory::Internal,
                error.message,
            )
            .with_detail(detail),
            GitErrorCode::Internal => {
                AppError::new("app.internal", ErrorCategory::Internal, error.message)
                    .with_detail(detail)
            }
        }
    }
}

const MAX_DETAIL_CHARS: usize = 16 * 1024;

fn bounded_detail(detail: String) -> Option<String> {
    let redacted = redaction::redact(&detail);
    let trimmed = redacted.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_DETAIL_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(GitErrorCode::Cancelled.as_str(), "op.cancelled");
        assert_eq!(GitErrorCode::Timeout.as_str(), "git.timeout");
        assert_eq!(GitErrorCode::ExitFailure.as_str(), "git.exit_failure");
    }

    #[test]
    fn details_are_redacted_before_storage() {
        let error = GitError::invalid_argument(
            "https://oauth2:glpat-secret@example.test/repo.git".to_owned(),
        );

        let detail = error.detail().expect("detail");
        assert!(!detail.contains("glpat-secret"));
        assert!(detail.contains("***@example.test"));
    }

    #[test]
    fn empty_details_are_dropped() {
        let error = GitError::cancelled(Some("   \n".to_owned()));
        assert!(error.detail().is_none());
    }
}
