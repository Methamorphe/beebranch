//! Stable GitHub error taxonomy.
//!
//! The `code` string is the contract consumed by the UI; the message is
//! French, bounded and always safe to display. Details are redacted with
//! [`beebranch_core::redaction`] before being stored, and `Debug` redacts
//! again so a token can never leak through a log line.

use std::fmt;

use beebranch_core::redaction;
use thiserror::Error;

/// Maximum number of characters kept in a diagnostic detail.
pub const MAX_DETAIL_CHARS: usize = 2000;

/// Error returned by the GitHub client.
#[derive(Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct GithubError {
    code: &'static str,
    message: String,
    status: Option<u16>,
    retryable: bool,
    detail: Option<String>,
}

impl GithubError {
    /// Stable machine-readable code, e.g. `auth.failed`.
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// French message safe for display.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// HTTP status when the error comes from a GitHub response.
    pub fn status(&self) -> Option<u16> {
        self.status
    }

    /// Whether an idempotent request may be attempted again.
    pub fn retryable(&self) -> bool {
        self.retryable
    }

    /// Redacted diagnostic detail, bounded to [`MAX_DETAIL_CHARS`].
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: None,
            retryable: false,
            detail: None,
        }
    }

    pub(crate) fn invalid_url(message: impl Into<String>) -> Self {
        Self::new("github.invalid_url", message)
    }

    pub(crate) fn insecure_url(message: impl Into<String>) -> Self {
        Self::new("github.insecure_url", message)
    }

    pub(crate) fn url_credentials(message: impl Into<String>) -> Self {
        Self::new("github.url_credentials", message)
    }

    /// The client could not be configured (token, CA bundle, HTTP builder).
    pub(crate) fn configuration(message: impl Into<String>) -> Self {
        Self::new("github.configuration", message)
    }

    /// The provided CA bundle could not be parsed.
    pub(crate) fn invalid_ca(message: impl Into<String>) -> Self {
        Self::new("tls.ca_invalid", message)
    }

    /// The response body is not the JSON expected by the client.
    pub(crate) fn invalid_response(detail: impl Into<String>) -> Self {
        Self {
            code: "github.invalid_response",
            message: "La réponse de GitHub est illisible.".to_owned(),
            status: None,
            retryable: false,
            detail: bounded_detail(detail.into()),
        }
    }

    /// Map a non-success HTTP status and its body to a stable error.
    ///
    /// `rate_limited` is set by the client when a `403` carries an exhausted
    /// rate-limit bucket: GitHub uses `403` for both permission failures and
    /// quota exhaustion.
    pub(crate) fn from_status(status: u16, body: &str, rate_limited: bool) -> Self {
        let (code, message, retryable) = match (status, rate_limited) {
            (401, _) => (
                "auth.failed",
                "Authentification GitHub refusée : le jeton est invalide ou expiré.",
                false,
            ),
            (403, true) | (429, _) => (
                "github.rate_limited",
                "GitHub limite temporairement les requêtes.",
                true,
            ),
            (403, false) => (
                "github.forbidden",
                "Accès refusé par GitHub : le jeton n'a pas les droits nécessaires.",
                false,
            ),
            (404, _) => (
                "github.not_found",
                "La ressource GitHub demandée est introuvable.",
                false,
            ),
            (409, _) => (
                "github.conflict",
                "Conflit avec l'état actuel de la ressource GitHub.",
                false,
            ),
            (422, _) => (
                "github.validation",
                "GitHub a refusé la requête : un champ est invalide.",
                false,
            ),
            (405, _) => (
                "github.not_allowed",
                "GitHub refuse cette opération dans l'état actuel de la ressource.",
                false,
            ),
            (500..=599, _) => (
                "github.server",
                "Le serveur GitHub a rencontré une erreur.",
                true,
            ),
            _ => (
                "github.request_failed",
                "La requête GitHub a échoué.",
                false,
            ),
        };

        Self {
            code,
            message: message.to_owned(),
            status: Some(status),
            retryable,
            detail: bounded_detail(format!("HTTP {status} : {body}")),
        }
    }

    pub(crate) fn network(host: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "network.unreachable",
            message: format!("Le serveur GitHub {host} est injoignable."),
            status: None,
            retryable: true,
            detail: bounded_detail(detail.into()),
        }
    }

    pub(crate) fn timeout(host: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "network.unreachable",
            message: format!("La requête vers GitHub {host} a expiré."),
            status: None,
            retryable: true,
            detail: bounded_detail(detail.into()),
        }
    }

    pub(crate) fn tls(host: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "tls.ca_required",
            message: format!(
                "La connexion TLS à {host} a échoué. Importez le certificat CA de l'instance dans les réglages."
            ),
            status: None,
            retryable: false,
            detail: bounded_detail(detail.into()),
        }
    }
}

impl fmt::Debug for GithubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = self
            .detail
            .as_deref()
            .map(|detail| redaction::redact(detail).into_owned());

        formatter
            .debug_struct("GithubError")
            .field("code", &self.code)
            .field("message", &redaction::redact(&self.message))
            .field("status", &self.status)
            .field("retryable", &self.retryable)
            .field("detail", &detail)
            .finish()
    }
}

fn bounded_detail(detail: String) -> Option<String> {
    let bounded = redaction::redact_bounded(&detail, MAX_DETAIL_CHARS);
    let trimmed = bounded.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_statuses_to_stable_codes() {
        let cases = [
            (401, false, "auth.failed", false),
            (403, false, "github.forbidden", false),
            (403, true, "github.rate_limited", true),
            (404, false, "github.not_found", false),
            (409, false, "github.conflict", false),
            (422, false, "github.validation", false),
            (429, false, "github.rate_limited", true),
            (500, false, "github.server", true),
            (418, false, "github.request_failed", false),
        ];

        for (status, limited, code, retryable) in cases {
            let error = GithubError::from_status(status, "{}", limited);
            assert_eq!(error.code(), code, "status {status}");
            assert_eq!(error.status(), Some(status));
            assert_eq!(error.retryable(), retryable, "status {status}");
        }
    }

    #[test]
    fn details_are_redacted_before_storage() {
        let error = GithubError::from_status(
            401,
            r#"{"message":"token ghp_secret-value rejected for https://user:pass@host/x"}"#,
            false,
        );

        let detail = error.detail().expect("detail");
        assert!(!detail.contains("ghp_secret-value"));
        assert!(!detail.contains("user:pass"));
        assert!(!format!("{error:?}").contains("ghp_secret-value"));
    }

    #[test]
    fn tls_errors_are_explicit_and_terminal() {
        let error = GithubError::tls("github.example.test", "unknown issuer");
        assert_eq!(error.code(), "tls.ca_required");
        assert!(!error.retryable());
        assert!(error.message().contains("github.example.test"));
    }
}
