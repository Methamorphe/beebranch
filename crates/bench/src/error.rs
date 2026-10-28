//! Errors surfaced by the benchmark harness.
//!
//! Every message is user-facing and written in French; stable codes are kept
//! in the `Display` output so CI logs can be grepped.

use beebranch_core::AppError;
use beebranch_git::GitError;

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, BenchError>;

/// Failure of the harness itself (not of the measured operation).
#[derive(Debug, thiserror::Error)]
pub enum BenchError {
    /// Invalid command line.
    #[error("usage invalide : {0}")]
    Usage(String),
    /// Corpus generation or validation failure.
    #[error("corpus : {0}")]
    Corpus(String),
    /// Git invocation failure.
    #[error("git : {0}")]
    Git(String),
    /// Scenario failure.
    #[error("scénario : {0}")]
    Scenario(String),
    /// Filesystem failure.
    #[error("entrées/sorties : {0}")]
    Io(#[from] std::io::Error),
    /// JSON (de)serialization failure.
    #[error("JSON : {0}")]
    Json(#[from] serde_json::Error),
}

impl From<GitError> for BenchError {
    fn from(error: GitError) -> Self {
        let mut text = format!("{} ({})", error.message(), error.code());
        if let Some(detail) = error.detail() {
            text.push_str(" : ");
            text.push_str(detail);
        }
        Self::Git(text)
    }
}

impl From<AppError> for BenchError {
    fn from(error: AppError) -> Self {
        let mut text = format!("{} [{}]", error.message, error.code);
        if let Some(detail) = error.detail {
            text.push_str(" : ");
            text.push_str(&detail);
        }
        Self::Scenario(text)
    }
}
