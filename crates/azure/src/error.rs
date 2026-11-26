//! Stable Azure DevOps error taxonomy.
//!
//! The `code` string is the contract consumed by the UI. Messages are French,
//! bounded and safe to display. `Debug` redacts the detail so a token pasted
//! into a response body cannot leak through a log line.

use std::fmt;

use beebranch_core::redaction;
use thiserror::Error;

/// Maximum number of characters kept in a diagnostic detail.
pub const MAX_DETAIL_CHARS: usize = 2000;

/// Error returned by the Azure DevOps client.
#[derive(Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct AzureError {
    code: &'static str,
    message: String,
    status: Option<u16>,
    retryable: bool,
    detail: Option<String>,
    params: Vec<(&'static str, String)>,
}

impl AzureError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }

    pub fn retryable(&self) -> bool {
        self.retryable
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn params(&self) -> &[(&'static str, String)] {
        &self.params
    }

    #[allow(dead_code)]
    pub(crate) fn with_param(mut self, key: &'static str, value: impl Into<String>) -> Self {
        let value = value.into();
        if !value.is_empty() {
            self.params.push((key, value));
        }
        self
    }

    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: None,
            retryable: false,
            detail: None,
            params: Vec::new(),
        }
    }

    pub(crate) fn invalid_url(message: impl Into<String>) -> Self {
        Self::new("azure.invalid_url", message)
    }

    pub(crate) fn insecure_url(message: impl Into<String>) -> Self {
        Self::new("azure.insecure_url", message)
    }

    pub(crate) fn url_credentials(message: impl Into<String>) -> Self {
        Self::new("azure.url_credentials", message)
    }

    pub(crate) fn configuration(message: impl Into<String>) -> Self {
        Self::new("azure.configuration", message)
    }

    pub(crate) fn invalid_ca(message: impl Into<String>) -> Self {
        Self::new("tls.ca_invalid", message)
    }

    #[allow(dead_code)]
    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self::new("azure.unsupported", message)
    }

    pub(crate) fn invalid_response(detail: impl Into<String>) -> Self {
        Self {
            code: "azure.invalid_response",
            message: "La réponse d'Azure DevOps est illisible.".to_owned(),
            status: None,
            retryable: false,
            detail: bounded_detail(detail.into()),
            params: Vec::new(),
        }
    }

    /// Map a non-success HTTP status. `203` is the sign-in page Azure returns
    /// when the token is missing or expired.
    pub(crate) fn from_status(status: u16, body: &str) -> Self {
        let (code, message, retryable) = match status {
            203 | 401 => (
                "auth.failed",
                "Authentification Azure DevOps refusée : le jeton est invalide ou expiré.",
                false,
            ),
            403 => (
                "azure.forbidden",
                "Accès refusé par Azure DevOps : le jeton n'a pas les droits nécessaires.",
                false,
            ),
            404 => (
                "azure.not_found",
                "La ressource Azure DevOps demandée est introuvable.",
                false,
            ),
            409 => (
                "azure.conflict",
                "Conflit avec l'état actuel de la ressource Azure DevOps.",
                false,
            ),
            400 | 422 => (
                "azure.validation",
                "Azure DevOps a refusé la requête : un champ est invalide.",
                false,
            ),
            429 => (
                "azure.rate_limited",
                "Azure DevOps limite temporairement les requêtes.",
                true,
            ),
            500..=599 => (
                "azure.server",
                "Le serveur Azure DevOps a rencontré une erreur.",
                true,
            ),
            _ => (
                "azure.request_failed",
                "La requête Azure DevOps a échoué.",
                false,
            ),
        };
        Self {
            code,
            message: message.to_owned(),
            status: Some(status),
            retryable,
            detail: bounded_detail(format!("HTTP {status} : {body}")),
            params: Vec::new(),
        }
    }

    pub(crate) fn network(host: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "network.unreachable",
            message: format!("Le serveur Azure DevOps {host} est injoignable."),
            status: None,
            retryable: true,
            detail: bounded_detail(detail.into()),
            params: vec![("host", host.to_owned())],
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
            params: vec![("host", host.to_owned())],
        }
    }
}

impl fmt::Debug for AzureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = self
            .detail
            .as_deref()
            .map(|detail| redaction::redact(detail).into_owned());
        formatter
            .debug_struct("AzureError")
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
            (203, "auth.failed", false),
            (403, "azure.forbidden", false),
            (404, "azure.not_found", false),
            (409, "azure.conflict", false),
            (400, "azure.validation", false),
            (429, "azure.rate_limited", true),
            (500, "azure.server", true),
            (418, "azure.request_failed", false),
        ];
        for (status, code, retryable) in cases {
            let error = AzureError::from_status(status, "{}");
            assert_eq!(error.code(), code, "status {status}");
            assert_eq!(error.retryable(), retryable, "status {status}");
        }
    }

    #[test]
    fn debug_does_not_keep_a_basic_secret() {
        let error = AzureError::from_status(
            401,
            "Authorization: Basic c2VjcmV0 rejected for https://user:pass@dev.azure.com/org",
        );
        let rendered = format!("{error:?}");
        assert!(!rendered.contains("c2VjcmV0"));
        assert!(!rendered.contains("user:pass"));
    }
}
