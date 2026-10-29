//! Read-only discovery of HTTPS credentials already configured for Git.
//!
//! The application never stores, logs or displays these secrets: they are read
//! from the user's Git configuration (`url.<base>.insteadOf` entries and the
//! `store` credential helper file) and, for a known host, from whichever
//! credential helper Git is configured with (`osxkeychain`, Windows
//! Credential Manager, `gh auth git-credential`, …) so an existing forge token
//! can be reused without re-entering it. Only HTTPS credentials are
//! considered; SSH keys are invisible here by design.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use beebranch_core::AppError;

use crate::process::{CommandSpec, GitRunner, StdinMode};
use crate::GitSubcommand;

/// Maximum size read from a credential store file. Real files are tiny; the
/// cap keeps a corrupted or hostile file from exhausting memory.
const STORE_FILE_LIMIT: u64 = 1024 * 1024;

/// Bound a `git credential fill` call so an interactive helper can never stall
/// startup or the onboarding screen.
const HELPER_TIMEOUT: Duration = Duration::from_secs(5);

const URL_INSTEADOF_PATTERN: &str = r"^url\..*\.insteadof$";

/// Where a credential was found. Displayed to the user, never secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialOrigin {
    /// A `url.<base>.insteadOf` entry embeds the credentials in `<base>`.
    GitConfigUrl,
    /// A `credential.helper = store` file (default `~/.git-credentials`).
    StoreFile(PathBuf),
    /// A credential returned by a configured credential helper
    /// (`osxkeychain`, `manager`, `gh auth git-credential`, …).
    Helper,
}

/// One HTTPS credential pair found in the Git configuration.
#[derive(Clone, PartialEq, Eq)]
pub struct DiscoveredCredential {
    /// Lowercase `host[:port]` without credentials.
    pub host: String,
    pub username: String,
    pub password: String,
    pub origin: CredentialOrigin,
}

impl std::fmt::Debug for DiscoveredCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveredCredential")
            .field("host", &self.host)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("origin", &self.origin)
            .finish()
    }
}

impl DiscoveredCredential {
    /// Human-readable origin, safe to show in the UI.
    pub fn source_label(&self) -> String {
        match &self.origin {
            CredentialOrigin::GitConfigUrl => "configuration Git (url.*.insteadOf)".to_owned(),
            CredentialOrigin::StoreFile(path) => {
                let text = path.display().to_string();
                match home_dir() {
                    Some(home) => {
                        let home = home.display().to_string();
                        match text.strip_prefix(&home) {
                            Some(rest) => format!("~{rest}"),
                            None => text,
                        }
                    }
                    None => text,
                }
            }
            CredentialOrigin::Helper => "helper d'identifiants Git".to_owned(),
        }
    }

    /// GitLab personal access tokens carry a `glpat-` prefix since GitLab 13.
    /// Older self-hosted instances use an opaque value, so this is only a
    /// preference signal, never a requirement.
    pub fn looks_like_gitlab_token(&self) -> bool {
        self.password.starts_with("glpat-")
            || self.password.starts_with("gloas-")
            || self.password.starts_with("glcbt-")
            || self.password.starts_with("glrt-")
            || self.password.starts_with("glft-")
            || self.password.starts_with("glptt-")
    }

    /// GitHub tokens always carry a documented prefix (`ghp_`, `github_pat_`,
    /// ...). Like GitLab detection, this is a preference signal used only
    /// when no instance is configured yet.
    pub fn looks_like_github_token(&self) -> bool {
        ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]
            .iter()
            .any(|prefix| self.password.starts_with(prefix))
    }
}

/// Discover every usable HTTPS credential without touching the network.
///
/// Sources, in order: credentials answered by the configured helpers for the
/// given `hosts`, then global and system `url.*.insteadOf` entries, then the
/// files referenced by a `store` credential helper and the default store file
/// locations. Errors from Git itself are ignored (a missing system config is
/// normal); only a broken Git process surfaces as `Err`.
pub fn discover(runner: &GitRunner, cwd: &Path) -> Result<Vec<DiscoveredCredential>, AppError> {
    discover_for_hosts(runner, cwd, &[])
}

/// Like [`discover`], but also asks the configured credential helpers for each
/// host. Passing the known instance host reaches `osxkeychain`, Windows
/// Credential Manager, `gh auth git-credential` and any other opaque helper.
pub fn discover_for_hosts(
    runner: &GitRunner,
    cwd: &Path,
    hosts: &[&str],
) -> Result<Vec<DiscoveredCredential>, AppError> {
    let mut credentials = Vec::new();
    let mut seen = BTreeSet::new();

    for host in hosts {
        if let Some(credential) = fill(runner, cwd, host)? {
            push_unique(&mut credentials, &mut seen, credential);
        }
    }

    let mut helper_files: BTreeSet<PathBuf> = BTreeSet::new();
    for scope in ["--global", "--system"] {
        for line in config_lines(runner, cwd, scope, &["--get-regexp", URL_INSTEADOF_PATTERN])? {
            let Some((raw_key, _rewrite)) = line.split_once(' ') else {
                continue;
            };
            let Some(base) = insteadof_base(raw_key) else {
                continue;
            };
            if let Some(credential) = parse_https_credential(base, CredentialOrigin::GitConfigUrl) {
                push_unique(&mut credentials, &mut seen, credential);
            }
        }
        for helper in config_lines(runner, cwd, scope, &["--get-all", "credential.helper"])? {
            if let Some(path) = store_helper_file(&helper) {
                helper_files.insert(path);
            }
        }
    }

    for path in default_store_files() {
        if path.is_file() {
            helper_files.insert(path);
        }
    }
    for path in helper_files {
        for credential in read_store_file(&path) {
            push_unique(&mut credentials, &mut seen, credential);
        }
    }

    Ok(credentials)
}

/// Ask the credential helpers configured for Git for `host`.
///
/// `git credential fill` is the only portable way to read credentials owned by
/// a helper: their stores are opaque OS keychains or files. The query travels
/// on stdin (never argv), terminal prompts are disabled, interactive helpers
/// are asked not to open a window, and the call is bounded. A missing
/// credential is `Ok(None)`, never an error.
pub fn fill(
    runner: &GitRunner,
    cwd: &Path,
    host: &str,
) -> Result<Option<DiscoveredCredential>, AppError> {
    let host = host.trim();
    if host.is_empty() || host.contains('\n') || host.chars().any(char::is_whitespace) {
        return Ok(None);
    }

    let spec = CommandSpec::new(GitSubcommand::Credential, cwd)
        .arg("fill")
        .stdin(StdinMode::Bytes(
            format!("protocol=https\nhost={host}\n\n").into_bytes(),
        ))
        .env("GCM_INTERACTIVE", "never")
        .timeout(HELPER_TIMEOUT);
    let outcome = match runner.run(&spec) {
        Ok(outcome) => outcome,
        Err(error) => {
            // A missing helper, a helper that refuses to answer or a timeout
            // all mean "no credential"; only the code is logged.
            tracing::debug!(
                code = %error.code().as_str(),
                "credential helper query failed"
            );
            return Ok(None);
        }
    };
    if !outcome.success() {
        tracing::debug!(
            exit = ?outcome.exit_code(),
            "credential helper has no credential"
        );
        return Ok(None);
    }

    Ok(parse_fill_output(&outcome.stdout.text_lossy(), host))
}

/// Read `git credential fill` output. Values are never logged.
fn parse_fill_output(output: &str, host: &str) -> Option<DiscoveredCredential> {
    let mut username = None;
    let mut password = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_owned());
        }
    }
    let username = username?;
    let password = password?;
    if username.is_empty()
        || password.is_empty()
        || username.chars().any(char::is_control)
        || password.chars().any(char::is_control)
    {
        return None;
    }
    Some(DiscoveredCredential {
        host: host.to_ascii_lowercase(),
        username,
        password,
        origin: CredentialOrigin::Helper,
    })
}

fn config_lines(
    runner: &GitRunner,
    cwd: &Path,
    scope: &str,
    args: &[&str],
) -> Result<Vec<String>, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Config, cwd).arg(scope);
    for argument in args {
        spec = spec.arg(argument);
    }
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        // `git config` exits 1 when nothing matches; that is not a failure.
        return Ok(Vec::new());
    }
    Ok(outcome
        .stdout
        .text_lossy()
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

/// `url.<base>.insteadOf` -> `<base>`.
fn insteadof_base(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("url.")?;
    rest.strip_suffix(".insteadof")
        .or_else(|| rest.strip_suffix(".insteadOf"))
}

/// `store --file=<path>` -> that file. A bare `store` uses the default
/// locations, which [`default_store_files`] already probes.
fn store_helper_file(helper: &str) -> Option<PathBuf> {
    let helper = helper.trim();
    if !helper.starts_with("store") {
        return None;
    }
    let mut parts = helper.split_whitespace();
    parts.next()?;
    let mut explicit = None;
    for part in parts {
        if let Some(value) = part
            .strip_prefix("--file=")
            .or_else(|| part.strip_prefix("--file"))
            .filter(|value| !value.is_empty())
        {
            explicit = Some(expand_tilde(value));
        }
    }
    explicit
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_tilde(value: &str) -> PathBuf {
    match value.strip_prefix("~/") {
        Some(rest) => match home_dir() {
            Some(home) => home.join(rest),
            None => PathBuf::from(value),
        },
        None => PathBuf::from(value),
    }
}

/// Files the `store` helper reads when invoked without `--file`.
fn default_store_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        if !xdg.as_os_str().is_empty() {
            files.push(xdg.join("git").join("credentials"));
        }
    }
    if let Some(home) = home_dir() {
        files.push(home.join(".git-credentials"));
    }
    files
}

fn read_store_file(path: &Path) -> Vec<DiscoveredCredential> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if metadata.len() > STORE_FILE_LIMIT {
        tracing::warn!(
            path = %path.display(),
            "credential store file ignored: larger than the size cap"
        );
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        tracing::warn!(path = %path.display(), "credential store file unreadable");
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| {
            parse_https_credential(line, CredentialOrigin::StoreFile(path.to_path_buf()))
        })
        .collect()
}

fn push_unique(
    credentials: &mut Vec<DiscoveredCredential>,
    seen: &mut BTreeSet<(String, String, String)>,
    credential: DiscoveredCredential,
) {
    let key = (
        credential.host.clone(),
        credential.username.clone(),
        credential.password.clone(),
    );
    if seen.insert(key) {
        credentials.push(credential);
    }
}

/// Parse `https://user:password@host[:port][/path]`.
///
/// Returns `None` for any other scheme, a missing password, or a malformed
/// authority. No secret is ever echoed in a log or error.
fn parse_https_credential(input: &str, origin: CredentialOrigin) -> Option<DiscoveredCredential> {
    let trimmed = input.trim();
    let rest = trimmed.strip_prefix("https://")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|authority| !authority.is_empty())?;
    let (userinfo, host) = authority.rsplit_once('@')?;
    if host.is_empty() || host.contains('@') || host.chars().any(char::is_whitespace) {
        return None;
    }
    let (username, password) = userinfo.split_once(':')?;
    if password.is_empty() {
        return None;
    }
    let username = percent_decode(username)?;
    let password = percent_decode(password)?;
    if username.is_empty() || password.chars().any(char::is_control) {
        return None;
    }
    Some(DiscoveredCredential {
        host: host.to_ascii_lowercase(),
        username,
        password,
        origin,
    })
}

/// Decode `%XX` escapes; invalid escapes are kept verbatim.
fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_owned());
    }
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(path: &str) -> CredentialOrigin {
        CredentialOrigin::StoreFile(PathBuf::from(path))
    }

    #[test]
    fn parses_https_credentials_and_rejects_the_rest() {
        let credential = parse_https_credential(
            "https://oauth2:glpat-abc123@gitlab.example.test/group/repo.git",
            store("/tmp/creds"),
        )
        .expect("credential");
        assert_eq!(credential.host, "gitlab.example.test");
        assert_eq!(credential.username, "oauth2");
        assert_eq!(credential.password, "glpat-abc123");
        assert!(credential.looks_like_gitlab_token());
        assert!(!credential.looks_like_github_token());

        let github = parse_https_credential(
            "https://x-access-token:ghp_abc123@github.com/owner/repo.git",
            store("/tmp/creds"),
        )
        .expect("github credential");
        assert!(github.looks_like_github_token());
        assert!(!github.looks_like_gitlab_token());

        assert_eq!(
            parse_https_credential("https://user:token@host.test:8443", store("/tmp/creds"))
                .map(|value| value.host),
            Some("HOST.test:8443".to_ascii_lowercase())
        );
        for rejected in [
            "http://user:token@host.test",
            "https://user@host.test",
            "https://user:@host.test",
            "https://host.test",
            "ssh://git@host.test/repo.git",
            "https://user:token@/repo.git",
            "",
        ] {
            assert!(
                parse_https_credential(rejected, store("/tmp/creds")).is_none(),
                "{rejected:?} must be rejected"
            );
        }
    }

    #[test]
    fn decodes_percent_escapes_without_losing_literal_ones() {
        assert_eq!(
            percent_decode("p%40ss%3Aword").as_deref(),
            Some("p@ss:word")
        );
        assert_eq!(percent_decode("100%valid").as_deref(), Some("100%valid"));
        assert_eq!(percent_decode("bad%2").as_deref(), Some("bad%2"));
    }

    #[test]
    fn extracts_insteadof_base_and_store_files() {
        assert_eq!(
            insteadof_base("url.https://oauth2:token@gitlab.test/.insteadof"),
            Some("https://oauth2:token@gitlab.test/")
        );
        assert_eq!(
            insteadof_base("url.https://gitlab.test/.insteadof"),
            Some("https://gitlab.test/")
        );
        assert_eq!(insteadof_base("credential.helper"), None);

        assert_eq!(
            store_helper_file("store --file=/tmp/creds"),
            Some(PathBuf::from("/tmp/creds"))
        );
        assert_eq!(store_helper_file("cache --timeout=300"), None);
        assert_eq!(store_helper_file("osxkeychain"), None);
    }

    #[test]
    fn reads_a_store_file_and_drops_unusable_lines() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("credentials");
        std::fs::write(
            &path,
            concat!(
                "https://oauth2:glpat-one@gitlab.example.test\n",
                "\n",
                "http://oauth2:glpat-two@gitlab.example.test\n",
                "https://oauth2:glpat-one@gitlab.example.test\n"
            ),
        )
        .expect("write");

        let found = read_store_file(&path);
        assert_eq!(found.len(), 2, "one duplicate line is kept until dedupe");
        assert!(found
            .iter()
            .all(|credential| credential.password == "glpat-one"));
        assert!(found
            .iter()
            .all(|credential| credential.origin == CredentialOrigin::StoreFile(path.clone())));
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let credential = parse_https_credential(
            "https://oauth2:glpat-secret@gitlab.test",
            store("/tmp/creds"),
        )
        .expect("credential");
        let rendered = format!("{credential:?}");
        assert!(!rendered.contains("glpat-secret"));
        assert!(rendered.contains("[REDACTED]"));
        assert!(!format!("{:?}", credential.origin).contains("glpat-secret"));
    }

    #[test]
    fn parses_credential_helper_output() {
        let credential = parse_fill_output(
            "protocol=https\nhost=gitlab.example.test\nusername=oauth2\npassword=glpat-helper\r\n",
            "GitLab.Example.Test",
        )
        .expect("credential");
        assert_eq!(credential.host, "gitlab.example.test");
        assert_eq!(credential.username, "oauth2");
        assert_eq!(credential.password, "glpat-helper");
        assert_eq!(credential.origin, CredentialOrigin::Helper);
        assert!(credential.looks_like_gitlab_token());
        assert!(!format!("{credential:?}").contains("glpat-helper"));

        for incomplete in [
            "",
            "username=oauth2\n",
            "password=glpat-helper\n",
            "username=\npassword=glpat-helper\n",
            "username=oauth2\npassword=\n",
        ] {
            assert!(
                parse_fill_output(incomplete, "gitlab.example.test").is_none(),
                "{incomplete:?} must be rejected"
            );
        }
    }

    /// `git credential fill` reaches opaque helpers such as `osxkeychain`,
    /// which no file scan can read. A local helper makes the test independent
    /// from whatever the machine has configured globally.
    #[cfg(unix)]
    #[test]
    fn asks_the_configured_helper_for_a_host() {
        let directory = tempfile::tempdir().expect("tempdir");
        let runner = GitRunner::detect().expect("git");
        runner
            .run(&CommandSpec::new(GitSubcommand::Init, directory.path()).arg("--quiet"))
            .expect("git init");
        let commands: [&[&str]; 2] = [
            &["--local", "credential.helper", ""],
            &[
                "--local",
                "--add",
                "credential.helper",
                "!f() { echo username=oauth2; echo password=glpat-helper; }; f",
            ],
        ];
        for arguments in commands {
            runner
                .run(
                    &CommandSpec::new(GitSubcommand::Config, directory.path())
                        .args(arguments.iter().copied()),
                )
                .expect("git config");
        }

        let credential = fill(&runner, directory.path(), "gitlab.example.test")
            .expect("fill")
            .expect("credential");
        assert_eq!(credential.username, "oauth2");
        assert_eq!(credential.password, "glpat-helper");
        assert_eq!(credential.origin, CredentialOrigin::Helper);

        let discovered = discover_for_hosts(&runner, directory.path(), &["gitlab.example.test"])
            .expect("discover");
        assert_eq!(
            discovered.first().map(|value| value.password.as_str()),
            Some("glpat-helper"),
            "the helper answer is preferred over file scans"
        );
    }
}
