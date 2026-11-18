use beebranch_core::{AppError, ErrorCategory};
use beebranch_store::StoreError;

/// Convert a persistence failure into the stable application error payload.
pub fn store_error(error: StoreError) -> AppError {
    let (message, remediation) = match error.code() {
        "store.database" => (
            "Les données de l'application n'ont pas pu être lues.",
            "Fermez les autres fenêtres de BeeBranch, puis réessayez.",
        ),
        "store.io" => (
            "Un fichier de l'application n'a pas pu être lu ou écrit.",
            "Vérifiez que le dossier de données est accessible, puis réessayez.",
        ),
        "store.keychain" => (
            "Le trousseau du système a refusé l'accès au secret.",
            "Déverrouillez le trousseau, ou autorisez BeeBranch à l'utiliser.",
        ),
        _ => (
            "Des données enregistrées sont illisibles.",
            "Le détail technique précise ce qui est en cause.",
        ),
    };
    AppError::new(error.code(), ErrorCategory::Internal, message)
        .with_detail(error.detail())
        .with_remediation(remediation)
}

/// Convert a JSON serialization failure.
pub fn json_error(error: serde_json::Error) -> AppError {
    AppError::internal(format!("sérialisation: {error}"))
}

/// Map a GitLab client failure preserving its stable code and remediation.
pub fn gitlab_error(error: beebranch_gitlab::GitlabError) -> AppError {
    let code = if error.code() == "auth.failed" {
        "gitlab.auth_failed"
    } else {
        error.code()
    };
    let category = match code {
        code if code.starts_with("auth.") || code == "gitlab.auth_failed" => ErrorCategory::Auth,
        code if code.starts_with("tls.") => ErrorCategory::Tls,
        "network.unreachable" | "gitlab.rate_limited" | "gitlab.server" => ErrorCategory::Network,
        "gitlab.conflict" => ErrorCategory::Conflict,
        _ => ErrorCategory::Input,
    };
    let mut mapped = AppError::new(code, category, error.message()).retryable(error.retryable());
    if let Some(detail) = error.detail() {
        mapped = mapped.with_detail(detail);
    }
    for (key, value) in error.params() {
        mapped = mapped.with_param(*key, value.clone());
    }
    match code {
        "gitlab.auth_failed" => mapped.with_remediation(
            "Vérifiez le jeton d'accès personnel, ses droits (api, read_user) et sa date d'expiration.",
        ),
        "tls.ca_required" | "tls.ca_invalid" => mapped.with_remediation(
            "Importez le certificat de l'autorité de l'instance GitLab dans les réglages.",
        ),
        "network.unreachable" => mapped
            .with_remediation("Vérifiez l'adresse de l'instance, le proxy et la connexion, puis réessayez.")
            .retryable(true),
        "gitlab.rate_limited" => mapped.with_remediation("Patientez, puis relancez la requête."),
        "gitlab.device_flow_disabled" => mapped.with_remediation(
            "Sur gitlab.com, ouvrez l'application OAuth et cochez « Device authorization grant », puis enregistrez.",
        ),
        "gitlab.oauth_scope" => mapped.with_remediation(
            "Cochez les droits api, read_user et read_repository sur l'application OAuth GitLab.",
        ),
        "gitlab.oauth_configuration" => {
            mapped.with_remediation("Vérifiez l'identifiant de l'application OAuth GitLab.")
        }
        _ => mapped,
    }
}

/// Map a GitHub client failure preserving its stable code and remediation.
pub fn github_error(error: beebranch_github::GithubError) -> AppError {
    let code = if error.code() == "auth.failed" {
        "github.auth_failed"
    } else {
        error.code()
    };
    let category = match code {
        code if code.starts_with("auth.") || code == "github.auth_failed" => ErrorCategory::Auth,
        code if code.starts_with("tls.") => ErrorCategory::Tls,
        "network.unreachable" | "github.rate_limited" | "github.server" => ErrorCategory::Network,
        "github.conflict" => ErrorCategory::Conflict,
        _ => ErrorCategory::Input,
    };
    let mut mapped = AppError::new(code, category, error.message()).retryable(error.retryable());
    if let Some(detail) = error.detail() {
        mapped = mapped.with_detail(detail);
    }
    for (key, value) in error.params() {
        mapped = mapped.with_param(*key, value.clone());
    }
    if code == "github.graphql" && !mapped.params.contains_key("message") {
        mapped = mapped.with_param("message", error.message());
    }
    match code {
        "github.auth_failed" => mapped.with_remediation(
            "Vérifiez le jeton d'accès personnel GitHub, ses droits (repo, read:user) et sa date d'expiration.",
        ),
        "tls.ca_required" | "tls.ca_invalid" => mapped.with_remediation(
            "Importez le certificat de l'autorité de l'instance GitHub Enterprise dans les réglages.",
        ),
        "network.unreachable" => mapped
            .with_remediation("Vérifiez l'adresse de l'instance, le proxy et la connexion, puis réessayez.")
            .retryable(true),
        "github.rate_limited" => mapped.with_remediation("Patientez, puis relancez la requête."),
        _ => mapped,
    }
}

/// Convert a blocking-task join failure.
pub fn join_error(error: tauri::Error) -> AppError {
    AppError::internal(format!("tâche bloquante interrompue: {error}"))
}
