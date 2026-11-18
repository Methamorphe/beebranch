use std::collections::BTreeMap;
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
    pub message: Box<str>,
    pub detail: Option<String>,
    pub remediation: Option<String>,
    pub retryable: bool,
    pub operation_id: Option<String>,
    /// Values the interface interpolates into the catalogue (`host`, `branch`, `seconds`).
    /// Empty for a static sentence. Never contains a secret. Boxed so `AppError`
    /// stays under clippy's `result_large_err` limit.
    #[serde(default, skip_serializing_if = "params_are_empty")]
    pub params: Box<BTreeMap<String, String>>,
}

#[allow(clippy::borrowed_box)]
fn params_are_empty(params: &Box<BTreeMap<String, String>>) -> bool {
    params.is_empty()
}

impl AppError {
    pub fn new(code: &'static str, category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            code,
            category,
            message: message.into().into_boxed_str(),
            detail: None,
            remediation: None,
            retryable: false,
            operation_id: None,
            params: Box::new(BTreeMap::new()),
        }
    }

    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = code;
        self
    }

    pub fn with_param(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        let value = value.into();
        if !value.is_empty() {
            self.params.insert(key.into(), value);
        }
        self
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
            "Git refuse ce dossier parce qu'il appartient à un autre compte.",
            "Si vous faites confiance à ce dossier, ajoutez-le explicitement à safe.directory. La commande est dans les détails.",
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
            "Un autre programme Git utilise ce dépôt.",
            "Attendez qu'il se termine, puis réessayez. Le fichier de verrou n'est jamais supprimé automatiquement.",
            stderr,
        )
        .retryable(true);
    }
    if haystack.contains("host key verification failed") {
        return git_error(
            "auth.host_key",
            ErrorCategory::Auth,
            "Ce serveur SSH n'est pas encore reconnu.",
            "Vérifiez son empreinte, puis acceptez-la une première fois.",
            stderr,
        );
    }
    if haystack.contains("permission denied (publickey)") {
        return git_error(
            "auth.ssh_key",
            ErrorCategory::Auth,
            "La clé SSH a été refusée.",
            "Déverrouillez la clé ou ajoutez-la à l'agent, puis réessayez. Les commandes sont dans les détails.",
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
            "Vérifiez le jeton ou l'identifiant enregistré pour cet hôte.",
            stderr,
        );
    }
    if looks_like_tls(&haystack) {
        return git_error(
            "tls.ca_required",
            ErrorCategory::Tls,
            "La connexion sécurisée a échoué.",
            "Importez le certificat de l'autorité dans les réglages, puis réessayez.",
            stderr,
        );
    }
    if looks_like_network(&haystack) {
        return git_error(
            "network.unreachable",
            ErrorCategory::Network,
            "Le serveur est injoignable.",
            "Vérifiez l'adresse, le proxy et la connexion, puis réessayez.",
            stderr,
        )
        .retryable(true);
    }
    if haystack.contains("untracked working tree files would be overwritten") {
        return git_error(
            "git.untracked_collision",
            ErrorCategory::Conflict,
            "Des fichiers non suivis seraient écrasés.",
            "Déplacez ou renommez ces fichiers, puis réessayez.",
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
            "Des fichiers modifiés seraient écrasés.",
            "Enregistrez-les dans un commit ou un remisage, puis recommencez.",
            stderr,
        );
    }
    if haystack.contains("unrelated histories") {
        return git_error(
            "git.unrelated_histories",
            ErrorCategory::GitState,
            "Ces historiques n'ont aucun commit en commun.",
            "Ne les fusionnez que si vous le décidez explicitement. L'option Git est dans les détails.",
            stderr,
        );
    }
    if haystack.contains("not possible to fast-forward")
        || haystack.contains("diverging branches can't be fast-forwarded")
    {
        return git_error(
            "git.pull_not_fast_forward",
            ErrorCategory::GitState,
            "La branche locale et la branche distante ont divergé.",
            "Intégrez les commits distants, puis réessayez.",
            stderr,
        );
    }
    if haystack.contains("need to specify how to reconcile divergent branches") {
        return git_error(
            "git.pull_strategy_missing",
            ErrorCategory::GitState,
            "Git ne sait pas comment réunir ces branches divergentes.",
            "Choisissez une stratégie de pull dans BeeBranch.",
            stderr,
        );
    }
    // "failed to push some refs" is only the summary line. The reason in
    // parentheses decides the recovery, so a hook is not reported as a
    // fast-forward failure.
    if haystack.contains("stale info") {
        return git_error(
            "git.push_lease_stale",
            ErrorCategory::GitState,
            "Quelqu'un a modifié la branche distante pendant l'envoi.",
            "Relancez l'envoi : la référence distante est relue juste avant.",
            stderr,
        )
        .retryable(true);
    }
    if looks_like_remote_rejection(&haystack) {
        return git_error(
            "git.push_rejected",
            ErrorCategory::GitState,
            "Le serveur a refusé l'envoi.",
            "Lisez le motif dans les détails : une branche protégée ou un hook peut bloquer l'envoi.",
            stderr,
        );
    }
    if haystack.contains("non-fast-forward") || haystack.contains("fetch first") {
        return git_error(
            "git.non_fast_forward",
            ErrorCategory::GitState,
            "La branche distante a des commits que vous n'avez pas.",
            "Récupérez-les, puis renvoyez votre branche.",
            stderr,
        );
    }
    if haystack.contains("unmerged files") || haystack.contains("unmerged path") {
        return git_error(
            "git.unresolved_conflicts",
            ErrorCategory::Conflict,
            "Il reste des conflits à résoudre.",
            "Corrigez les fichiers signalés, puis continuez l'opération.",
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
            "L'opération s'est arrêtée sur un conflit.",
            "Résolvez les conflits, puis continuez ou abandonnez l'opération.",
            stderr,
        );
    }
    if haystack.contains("unable to auto-detect email")
        || haystack.contains("author identity unknown")
        || haystack.contains("empty ident name")
        || haystack.contains("please tell me who you are")
    {
        return git_error(
            "git.identity_missing",
            ErrorCategory::Input,
            "Git ne connaît pas votre nom ou votre e-mail.",
            "Renseignez-les dans les profils, puis recommencez.",
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
            "Vérifiez la clé de signature et l'agent qui la détient.",
            stderr,
        );
    }
    if haystack.contains("must be run in a work tree") {
        return git_error(
            "repo.bare",
            ErrorCategory::Repo,
            "Cette opération a besoin d'une copie de travail.",
            "Ouvrez un dossier de travail lié à ce dépôt.",
            stderr,
        );
    }
    if haystack.contains("no such remote")
        || haystack.contains("does not appear to be a git repository")
    {
        return git_error(
            "git.remote_missing",
            ErrorCategory::Input,
            "Ce dépôt distant n'existe pas.",
            "Vérifiez le nom du remote dans la configuration.",
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
            "Ce chemin ne correspond à aucun fichier.",
            "Vérifiez le chemin, y compris les caractères spéciaux.",
            stderr,
        );
    }
    if haystack.contains("not currently on a branch") {
        return git_error(
            "git.detached",
            ErrorCategory::GitState,
            "Vous n'êtes sur aucune branche.",
            "Créez une branche, puis recommencez.",
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
            "Ce dépôt n'a qu'une partie de l'historique.",
            "Récupérez l'historique complet, puis recommencez. La commande est dans les détails.",
            stderr,
        );
    }
    if haystack.contains("not a git repository") {
        return git_error(
            "repo.not_git",
            ErrorCategory::Repo,
            "Ce dossier n'est pas un dépôt Git.",
            "Vérifiez le chemin, ou créez un dépôt.",
            stderr,
        );
    }

    let code = exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "inconnu".to_owned());
    AppError::new(
        "git.exit_unknown",
        ErrorCategory::GitExit,
        "L'opération Git a échoué.",
    )
    .with_detail(format!("code de sortie : {code}\n{stderr}"))
    .with_remediation("Le message de Git est dans les détails.")
    .with_param("code", code)
}

fn looks_like_tls(haystack: &str) -> bool {
    haystack.contains("ssl certificate problem")
        || haystack.contains("server certificate verification failed")
        || haystack.contains("unable to get local issuer certificate")
        || haystack.contains("certificate verify failed")
        || haystack.contains("self signed certificate")
        || haystack.contains("unknown ca")
}

fn looks_like_network(haystack: &str) -> bool {
    haystack.contains("could not resolve host")
        || haystack.contains("could not resolve hostname")
        || haystack.contains("name or service not known")
        || haystack.contains("temporary failure in name resolution")
        || haystack.contains("failed to connect")
        || haystack.contains("connection timed out")
        || haystack.contains("operation timed out")
        || haystack.contains("connection refused")
        || haystack.contains("network is unreachable")
        || haystack.contains("the remote end hung up unexpectedly")
}

/// A remote refused the update for a reason other than fast-forward.
fn looks_like_remote_rejection(haystack: &str) -> bool {
    haystack.contains("[remote rejected]")
        || haystack.contains("hook declined")
        || haystack.contains("protected branch")
        || haystack.contains("pre-receive hook")
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
                " ! [rejected] main -> main (stale info)\nerror: failed to push some refs",
                "git.push_lease_stale",
            ),
            (
                "fatal: Not possible to fast-forward, aborting.",
                "git.pull_not_fast_forward",
            ),
            (
                "fatal: Need to specify how to reconcile divergent branches.",
                "git.pull_strategy_missing",
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
            (
                "! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs",
                "git.push_rejected",
            ),
            (
                "remote: protected branch hook declined\nerror: failed to push some refs to 'origin'",
                "git.push_rejected",
            ),
            (
                "fatal: unable to access 'https://example.test/': Could not resolve host: example.test",
                "network.unreachable",
            ),
            (
                "fatal: unable to access 'https://example.test/': SSL certificate problem: unable to get local issuer certificate",
                "tls.ca_required",
            ),
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
        assert_eq!(
            error.detail.as_deref(),
            Some("code de sortie : 7\nsomething unexpected")
        );
        assert_eq!(error.params.get("code").map(String::as_str), Some("7"));
        assert!(!error.retryable);

        let summary_only = classify_git_failure(
            Some(1),
            "error: failed to push some refs to 'https://example.test/repo.git'",
        );
        assert_eq!(summary_only.code, "git.exit_unknown");

        let network = classify_git_failure(
            Some(128),
            "fatal: unable to access 'https://example.test/': Failed to connect to example.test",
        );
        assert!(network.retryable);
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
