use std::fmt;

use serde::Serialize;

use crate::redaction;

/// Maximum size of a diagnostic detail (16 KiB).
pub const MAX_DETAIL_BYTES: usize = 16 * 1024;

/// Stable error categories used by the UI for grouping and wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Input,
    Repo,
    GitState,
    GitExit,
    Auth,
    Network,
    Tls,
    Conflict,
    Permission,
    Busy,
    Internal,
    Cancelled,
}

/// Application-wide error payload.
///
/// `code` is the contract: the UI may rely on it, never on the message text.
/// `detail` is bounded, redacted and optional. No error is ever swallowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub category: ErrorCategory,
    pub message: String,
    pub detail: Option<String>,
    pub remediation: Option<String>,
    pub retryable: bool,
    pub operation_id: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str, category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            code,
            category,
            message: message.into(),
            detail: None,
            remediation: None,
            retryable: false,
            operation_id: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = bounded_detail(detail.into());
        self
    }

    pub fn with_remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_operation(mut self, operation_id: impl Into<String>) -> Self {
        self.operation_id = Some(operation_id.into());
        self
    }

    pub fn cancelled(detail: impl Into<String>) -> Self {
        Self::new(
            "op.cancelled",
            ErrorCategory::Cancelled,
            "L'opération a été annulée.",
        )
        .with_detail(detail)
    }

    pub fn invalid_input(detail: impl Into<String>) -> Self {
        Self::new(
            "input.invalid",
            ErrorCategory::Input,
            "Les données fournies sont invalides.",
        )
        .with_detail(detail)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("resource.not_found", ErrorCategory::Input, message)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(
            "app.internal",
            ErrorCategory::Internal,
            "Une erreur interne est survenue.",
        )
        .with_detail(detail)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

/// Classify a failed Git invocation into a stable application error.
///
/// Unknown failures keep `git.exit_unknown` and the redacted stderr tail.
pub fn classify_git_failure(exit_code: Option<i32>, stderr: &str) -> AppError {
    let haystack = stderr.to_ascii_lowercase();

    if haystack.contains("dubious ownership") {
        return git_error(
            "repo.safe_directory",
            ErrorCategory::Permission,
            "Le dépôt appartient à un autre utilisateur.",
            "Ajoutez explicitement le dépôt à safe.directory si vous lui faites confiance.",
            stderr,
        );
    }
    if haystack.contains("index.lock")
        || haystack.contains("head.lock")
        || haystack.contains("another git process seems to be running")
        || haystack.contains("unable to create") && haystack.contains(".lock")
    {
        return git_error(
            "repo.busy",
            ErrorCategory::Busy,
            "Un autre processus Git utilise ce dépôt.",
            "Vérifiez qu'aucun Git n'est en cours, puis réessayez. Le verrou n'est jamais supprimé automatiquement.",
            stderr,
        );
    }
    if haystack.contains("host key verification failed") {
        return git_error(
            "auth.host_key",
            ErrorCategory::Auth,
            "La clé d'hôte SSH n'est pas vérifiée.",
            "Vérifiez known_hosts ou connectez-vous une première fois en SSH.",
            stderr,
        );
    }
    if haystack.contains("permission denied (publickey)") {
        return git_error(
            "auth.ssh_key",
            ErrorCategory::Auth,
            "La clé SSH a été refusée.",
            "Vérifiez votre agent SSH et testez `ssh -T git@<hôte>`.",
            stderr,
        );
    }
    if haystack.contains("authentication failed")
        || haystack.contains("could not read username")
        || haystack.contains("could not read password")
        || haystack.contains("invalid username or password")
        || haystack.contains("http 401")
    {
        return git_error(
            "auth.failed",
            ErrorCategory::Auth,
            "L'authentification Git a échoué.",
            "Vérifiez le token ou le credential helper associé.",
            stderr,
        );
    }
    if haystack.contains("untracked working tree files would be overwritten") {
        return git_error(
            "git.untracked_collision",
            ErrorCategory::Conflict,
            "Des fichiers non suivis seraient écrasés.",
            "Déplacez ou renommez les fichiers non suivis concernés, puis réessayez.",
            stderr,
        );
    }
    if haystack.contains("your local changes")
        || haystack.contains("please commit your changes or stash")
        || haystack.contains("would be overwritten by checkout")
        || haystack.contains("would be overwritten by merge")
    {
        return git_error(
            "git.dirty_worktree",
            ErrorCategory::GitState,
            "Des modifications locales empêchent l'opération.",
            "Committez ou stashez les modifications, puis réessayez.",
            stderr,
        );
    }
    if haystack.contains("unrelated histories") {
        return git_error(
            "git.unrelated_histories",
            ErrorCategory::GitState,
            "Les historiques ne partagent aucun ancêtre.",
            "Décidez explicitement d'autoriser `--allow-unrelated-histories`.",
            stderr,
        );
    }
    if haystack.contains("non-fast-forward")
        || haystack.contains("fetch first")
        || haystack.contains("failed to push some refs")
    {
        return git_error(
            "git.non_fast_forward",
            ErrorCategory::GitState,
            "Le push n'est pas un fast-forward.",
            "Fetchez puis mergez ou rebasez avant de pousser.",
            stderr,
        );
    }
    if haystack.contains("unmerged files") || haystack.contains("unmerged path") {
        return git_error(
            "git.unresolved_conflicts",
            ErrorCategory::Conflict,
            "Des conflits ne sont pas résolus.",
            "Résolvez les fichiers en conflit, ajoutez-les, puis continuez.",
            stderr,
        );
    }
    if haystack.contains("conflict")
        || haystack.contains("automatic merge failed")
        || haystack.contains("could not apply")
    {
        return git_error(
            "git.conflict",
            ErrorCategory::Conflict,
            "L'opération a produit un conflit.",
            "Résolvez les conflits, puis continuez ou abandonnez l'opération.",
            stderr,
        );
    }
    if haystack.contains("unable to auto-detect email")
        || haystack.contains("author identity unknown")
        || haystack.contains("empty ident name")
    {
        return git_error(
            "git.identity_missing",
            ErrorCategory::Input,
            "L'identité Git est incomplète.",
            "Configurez user.name et user.email.",
            stderr,
        );
    }
    if haystack.contains("gpg failed to sign")
        || haystack.contains("failed to write commit object") && haystack.contains("sign")
    {
        return git_error(
            "git.signing_failed",
            ErrorCategory::Auth,
            "La signature du commit a échoué.",
            "Vérifiez la clé de signature et l'agent GPG/SSH.",
            stderr,
        );
    }
    if haystack.contains("must be run in a work tree") {
        return git_error(
            "repo.bare",
            ErrorCategory::Repo,
            "Cette opération exige un worktree.",
            "Ouvrez un worktree associé au dépôt.",
            stderr,
        );
    }
    if haystack.contains("no such remote")
        || haystack.contains("does not appear to be a git repository")
    {
        return git_error(
            "git.remote_missing",
            ErrorCategory::Input,
            "Le remote demandé n'existe pas.",
            "Vérifiez la configuration des remotes.",
            stderr,
        );
    }
    if haystack.contains("did not match any file")
        || haystack.contains("pathspec")
        || haystack.contains("path '") && haystack.contains("does not exist")
    {
        return git_error(
            "git.pathspec",
            ErrorCategory::Input,
            "Le chemin demandé ne correspond à aucun fichier.",
            "Vérifiez le chemin et son encodage.",
            stderr,
        );
    }
    if haystack.contains("not currently on a branch") {
        return git_error(
            "git.detached",
            ErrorCategory::GitState,
            "HEAD est détaché.",
            "Créez une branche avant cette opération.",
            stderr,
        );
    }
    if haystack.contains("bad object")
        || haystack.contains("invalid reference")
        || haystack.contains("unknown revision")
        || haystack.contains("ambiguous argument")
    {
        return git_error(
            "git.bad_ref",
            ErrorCategory::Input,
            "La référence Git est inconnue.",
            "Vérifiez le nom de la branche, du tag ou du SHA.",
            stderr,
        );
    }
    if haystack.contains("shallow") {
        return git_error(
            "git.shallow_unsupported",
            ErrorCategory::Repo,
            "Le dépôt est shallow et ne permet pas cette opération.",
            "Récupérez l'historique complet (`git fetch --unshallow`).",
            stderr,
        );
    }
    if haystack.contains("not a git repository") {
        return git_error(
            "repo.not_git",
            ErrorCategory::Repo,
            "Le dossier n'est pas un dépôt Git.",
            "Vérifiez le chemin ou initialisez un dépôt.",
            stderr,
        );
    }

    let code = exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "inconnu".to_owned());
    AppError::new(
        "git.exit_unknown",
        ErrorCategory::GitExit,
        format!("La commande Git a échoué (code {code})."),
    )
    .with_detail(stderr)
    .with_remediation("Consultez le détail pour la sortie Git complète.")
}

fn git_error(
    code: &'static str,
    category: ErrorCategory,
    message: &str,
    remediation: &str,
    stderr: &str,
) -> AppError {
    AppError::new(code, category, message)
        .with_detail(stderr)
        .with_remediation(remediation)
}

/// Bound and redact a detail before storage.
pub fn bounded_detail(detail: String) -> Option<String> {
    let redacted = redaction::redact(&detail);
    let trimmed = redacted.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(redaction::redact_bounded(trimmed, MAX_DETAIL_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_git_failures() {
        let cases = [
            (
                "fatal: not a git repository (or any of the parent directories)",
                "repo.not_git",
            ),
            (
                "fatal: Authentication failed for 'https://x'",
                "auth.failed",
            ),
            ("git@x: Permission denied (publickey).", "auth.ssh_key"),
            (
                "fatal: unable to auto-detect email address",
                "git.identity_missing",
            ),
            (
                "fatal: Unable to create '/r/.git/index.lock': File exists.",
                "repo.busy",
            ),
            (
                "! [rejected] main -> main (non-fast-forward)",
                "git.non_fast_forward",
            ),
            (
                "CONFLICT (content): Merge conflict in a.txt",
                "git.conflict",
            ),
            (
                "error: Your local changes to the following files would be overwritten",
                "git.dirty_worktree",
            ),
            (
                "fatal: detected dubious ownership in repository",
                "repo.safe_directory",
            ),
            ("error: gpg failed to sign the data", "git.signing_failed"),
        ];

        for (stderr, expected) in cases {
            let error = classify_git_failure(Some(128), stderr);
            assert_eq!(error.code, expected, "input: {stderr}");
        }
    }

    #[test]
    fn unknown_failures_stay_visible() {
        let error = classify_git_failure(Some(7), "something unexpected");
        assert_eq!(error.code, "git.exit_unknown");
        assert_eq!(error.detail.as_deref(), Some("something unexpected"));
        assert!(!error.retryable);
    }

    #[test]
    fn details_are_redacted_and_bounded() {
        let stderr = format!(
            "fatal: https://user:glpat-secret@host/repo.git {}",
            "x".repeat(40_000)
        );
        let error = classify_git_failure(Some(1), &stderr);
        let detail = error.detail.expect("detail");
        assert!(!detail.contains("glpat-secret"));
        assert!(detail.len() <= MAX_DETAIL_BYTES);
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let error = AppError::new("repo.not_git", ErrorCategory::Repo, "nope")
            .with_detail("detail")
            .with_operation("op_1");
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["code"], "repo.not_git");
        assert_eq!(json["category"], "repo");
        assert_eq!(json["operationId"], "op_1");
        assert!(json.get("operation_id").is_none());
    }
}
