//! Stable GitLab error taxonomy.
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

/// Error returned by the GitLab client.
#[derive(Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct GitlabError {
    code: &'static str,
    message: String,
    status: Option<u16>,
    retryable: bool,
    detail: Option<String>,
}

impl GitlabError {
    /// Stable machine-readable code, e.g. `auth.failed`.
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// French message safe for display.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// HTTP status when the error comes from a GitLab response.
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
        Self::new("gitlab.invalid_url", message)
    }

    pub(crate) fn insecure_url(message: impl Into<String>) -> Self {
        Self::new("gitlab.insecure_url", message)
    }

    pub(crate) fn url_credentials(message: impl Into<String>) -> Self {
        Self::new("gitlab.url_credentials", message)
    }

    /// The client could not be configured (token, CA bundle, HTTP builder).
    pub(crate) fn configuration(message: impl Into<String>) -> Self {
        Self::new("gitlab.configuration", message)
    }

    /// The provided CA bundle could not be parsed.
    pub(crate) fn invalid_ca(message: impl Into<String>) -> Self {
        Self::new("tls.ca_invalid", message)
    }

    /// The response body is not the JSON expected by the client.
    pub(crate) fn invalid_response(detail: impl Into<String>) -> Self {
        Self {
            code: "gitlab.invalid_response",
            message: "La réponse de GitLab est illisible.".to_owned(),
            status: None,
            retryable: false,
            detail: bounded_detail(detail.into()),
        }
    }

    /// Map a non-success HTTP status and its body to a stable error.
    pub(crate) fn from_status(status: u16, body: &str) -> Self {
        let (code, message, retryable) = match status {
            401 => (
                "auth.failed",
                "Authentification GitLab refusée : le jeton est invalide ou expiré.",
                false,
            ),
            403 => (
                "gitlab.forbidden",
                "Accès refusé par GitLab : le jeton n'a pas les droits nécessaires.",
                false,
            ),
            404 => (
                "gitlab.not_found",
                "La ressource GitLab demandée est introuvable.",
                false,
            ),
            409 => (
                "gitlab.conflict",
                "Conflit avec l'état actuel de la ressource GitLab.",
                false,
            ),
            422 => (
                "gitlab.validation",
                "GitLab a refusé la requête : un champ est invalide.",
                false,
            ),
            429 => (
                "gitlab.rate_limited",
                "GitLab limite temporairement les requêtes.",
                true,
            ),
            500..=599 => (
                "gitlab.server",
                "Le serveur GitLab a rencontré une erreur.",
                true,
            ),
            _ => (
                "gitlab.request_failed",
                "La requête GitLab a échoué.",
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
            message: format!("Le serveur GitLab {host} est injoignable."),
            status: None,
            retryable: true,
            detail: bounded_detail(detail.into()),
        }
    }

    pub(crate) fn timeout(host: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "network.unreachable",
            message: format!("La requête vers GitLab {host} a expiré."),
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

impl fmt::Debug for GitlabError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = self
            .detail
            .as_deref()
            .map(|detail| redaction::redact(detail).into_owned());

        formatter
            .debug_struct("GitlabError")
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
            (401, "auth.failed", false),
            (403, "gitlab.forbidden", false),
            (404, "gitlab.not_found", false),
            (409, "gitlab.conflict", false),
            (422, "gitlab.validation", false),
            (429, "gitlab.rate_limited", true),
            (500, "gitlab.server", true),
            (503, "gitlab.server", true),
            (418, "gitlab.request_failed", false),
        ];

        for (status, code, retryable) in cases {
            let error = GitlabError::from_status(status, "{}");
            assert_eq!(error.code(), code, "status {status}");
            assert_eq!(error.status(), Some(status));
            assert_eq!(error.retryable(), retryable, "status {status}");
            assert!(!error.message().is_empty());
        }
    }

    #[test]
    fn auth_errors_are_not_retryable() {
        let error = GitlabError::from_status(401, r#"{"message":"401 Unauthorized"}"#);

        assert_eq!(error.code(), "auth.failed");
        assert!(!error.retryable());
        assert!(error
            .detail()
            .is_some_and(|detail| detail.contains("Unauthorized")));
    }

    #[test]
    fn details_are_redacted_before_storage() {
        let error = GitlabError::from_status(
            401,
            r#"{"message":"token glpat-secret-value rejected for https://user:pass@host/x"}"#,
        );

        let detail = error.detail().expect("detail");
        assert!(!detail.contains("glpat-secret-value"));
        assert!(!detail.contains("user:pass"));
        assert!(!format!("{error:?}").contains("glpat-secret-value"));
    }

    #[test]
    fn debug_never_contains_the_token() {
        let error = GitlabError::network(
            "gitlab.example.com",
            "request failed: PRIVATE-TOKEN: glpat-debug-secret",
        );

        let debug = format!("{error:?}");
        assert!(!debug.contains("glpat-debug-secret"));
        assert!(debug.contains("network.unreachable"));
    }

    #[test]
    fn empty_details_are_dropped() {
        let error = GitlabError::invalid_response("   \n");

        assert_eq!(error.code(), "gitlab.invalid_response");
        assert!(error.detail().is_none());
    }

    #[test]
    fn tls_errors_are_explicit_and_terminal() {
        let error = GitlabError::tls("gitlab.example.com", "unknown issuer");

        assert_eq!(error.code(), "tls.ca_required");
        assert!(!error.retryable());
        assert!(error.message().contains("certificat CA"));
        assert!(error.message().contains("gitlab.example.com"));
    }
}
