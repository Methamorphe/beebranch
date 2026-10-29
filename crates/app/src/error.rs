use beebranch_core::{AppError, ErrorCategory};
use beebranch_store::StoreError;

/// Convert a persistence failure into the stable application error payload.
pub fn store_error(error: StoreError) -> AppError {
    AppError::new(error.code(), ErrorCategory::Internal, error.to_string())
        .with_detail(error.detail())
        .with_remediation("Vérifiez les permissions du dossier de données de l'application.")
}

/// Convert a JSON serialization failure.
pub fn json_error(error: serde_json::Error) -> AppError {
    AppError::internal(format!("sérialisation: {error}"))
}

/// Map a GitLab client failure preserving its stable code and remediation.
pub fn gitlab_error(error: beebranch_gitlab::GitlabError) -> AppError {
    let category = match error.code() {
        code if code.starts_with("auth.") => ErrorCategory::Auth,
        code if code.starts_with("tls.") => ErrorCategory::Tls,
        "network.unreachable" | "gitlab.rate_limited" | "gitlab.server" => ErrorCategory::Network,
        "gitlab.conflict" => ErrorCategory::Conflict,
        _ => ErrorCategory::Input,
    };
    let mut mapped =
        AppError::new(error.code(), category, error.message()).retryable(error.retryable());
    if let Some(detail) = error.detail() {
        mapped = mapped.with_detail(detail);
    }
    match error.code() {
        "auth.failed" => mapped.with_remediation(
            "Vérifiez le Personal Access Token, ses scopes (api, read_user) et son expiration.",
        ),
        "tls.ca_required" | "tls.ca_invalid" => mapped.with_remediation(
            "Importez le certificat PEM de l'autorité interne de l'instance GitLab.",
        ),
        "network.unreachable" => mapped
            .with_remediation("Vérifiez l'adresse de l'instance, le proxy et la connexion réseau."),
        "gitlab.rate_limited" => mapped.with_remediation("Patientez avant de relancer la requête."),
        _ => mapped,
    }
}

/// Map a GitHub client failure preserving its stable code and remediation.
pub fn github_error(error: beebranch_github::GithubError) -> AppError {
    let category = match error.code() {
        code if code.starts_with("auth.") => ErrorCategory::Auth,
        code if code.starts_with("tls.") => ErrorCategory::Tls,
        "network.unreachable" | "github.rate_limited" | "github.server" => ErrorCategory::Network,
        "github.conflict" => ErrorCategory::Conflict,
        _ => ErrorCategory::Input,
    };
    let mut mapped =
        AppError::new(error.code(), category, error.message()).retryable(error.retryable());
    if let Some(detail) = error.detail() {
        mapped = mapped.with_detail(detail);
    }
    match error.code() {
        "auth.failed" => mapped.with_remediation(
            "Vérifiez le Personal Access Token GitHub, ses scopes (repo, read:user, checks:read) et son expiration.",
        ),
        "tls.ca_required" | "tls.ca_invalid" => mapped.with_remediation(
            "Importez le certificat PEM de l'autorité interne de l'instance GitHub Enterprise.",
        ),
        "network.unreachable" => mapped
            .with_remediation("Vérifiez l'adresse de l'instance, le proxy et la connexion réseau."),
        "github.rate_limited" => mapped.with_remediation("Patientez avant de relancer la requête."),
        _ => mapped,
    }
}

/// Convert a blocking-task join failure.
pub fn join_error(error: tauri::Error) -> AppError {
    AppError::internal(format!("tâche bloquante interrompue: {error}"))
}
