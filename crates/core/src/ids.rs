use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Stable identifier of a repository worktree.
///
/// Derived from the canonical worktree path so the same checkout keeps its
/// identifier across restarts, journal entries and IPC payloads.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RepoId(String);

impl RepoId {
    pub fn from_path(path: &Path) -> Self {
        let normalized = normalize_path(&path.to_string_lossy());
        let digest = Sha256::digest(normalized.as_bytes());
        let mut identifier = String::with_capacity(21);
        identifier.push_str("repo_");
        for byte in &digest[..8] {
            identifier.push_str(&format!("{byte:02x}"));
        }
        Self(identifier)
    }

    pub fn from_raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Canonical spelling of a worktree path, used as the identity hash input.
///
/// `fs::canonicalize` and `git rev-parse --show-toplevel` name the same
/// directory differently on Windows — `\\?\C:\Dev\repo` versus
/// `C:/Dev/repo` — so the identity ignores the verbatim prefix, the separator
/// style, the drive-letter case and a trailing separator. A repository opened
/// from the picker and the same repository reported by Git then share one id.
///
/// POSIX paths are returned untouched: a backslash is an ordinary file-name
/// character there, and changing their spelling would change the id of every
/// macOS/Linux repository already stored in the preferences and the journal.
fn normalize_path(path: &str) -> String {
    let verbatim_stripped = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix(r"\\.\"))
    {
        rest.to_owned()
    } else {
        path.to_owned()
    };

    let bytes = verbatim_stripped.as_bytes();
    let has_drive = bytes.len() > 1 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if !has_drive && !verbatim_stripped.starts_with(r"\\") {
        return verbatim_stripped;
    }

    let mut normalized = verbatim_stripped.replace('\\', "/");
    if has_drive {
        let drive = normalized[..1].to_ascii_lowercase();
        normalized.replace_range(..1, &drive);
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

impl fmt::Display for RepoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identifier of a long-running operation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperationId(String);

impl OperationId {
    pub fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        Self(format!("op_{label}_{nanos:x}_{counter:x}"))
    }

    pub fn from_raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for OperationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identifier of a GitLab instance (host + path prefix).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InstanceId(String);

impl InstanceId {
    pub fn from_api_url(api_url: &str) -> Self {
        Self::from_api_url_with_prefix("gl_", api_url)
    }

    /// GitHub instance identifier (`gh_` prefix) for the same API base.
    pub fn from_github_api_url(api_url: &str) -> Self {
        Self::from_api_url_with_prefix("gh_", api_url)
    }

    fn from_api_url_with_prefix(prefix: &str, api_url: &str) -> Self {
        let digest = Sha256::digest(api_url.as_bytes());
        let mut identifier = String::with_capacity(prefix.len() + 12);
        identifier.push_str(prefix);
        for byte in &digest[..6] {
            identifier.push_str(&format!("{byte:02x}"));
        }
        Self(identifier)
    }

    pub fn from_raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for InstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Numeric GitLab project identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub u64);

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Per-project merge request sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MergeRequestIid(pub u64);

impl fmt::Display for MergeRequestIid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_ids_are_stable_and_path_scoped() {
        let one = RepoId::from_path(Path::new("/tmp/repo"));
        let two = RepoId::from_path(Path::new("/tmp/repo"));
        let three = RepoId::from_path(Path::new("/tmp/other"));

        assert_eq!(one, two);
        assert_ne!(one, three);
        assert!(one.as_str().starts_with("repo_"));
    }

    #[test]
    fn verbatim_windows_paths_share_the_identity_of_their_plain_form() {
        // `fs::canonicalize` and `git rev-parse --show-toplevel` disagree on
        // Windows; both spellings must identify the same worktree.
        let verbatim = RepoId::from_path(Path::new(r"\\?\C:\Dev\beebranch"));
        let plain = RepoId::from_path(Path::new("C:/Dev/beebranch"));

        assert_eq!(verbatim, plain);
        assert_eq!(plain, RepoId::from_path(Path::new(r"C:\Dev\beebranch")));
        assert_eq!(plain, RepoId::from_path(Path::new("c:/Dev/beebranch/")));
        assert_eq!(
            RepoId::from_path(Path::new(r"\\?\UNC\server\share\repo")),
            RepoId::from_path(Path::new(r"\\server\share\repo"))
        );
        assert_ne!(
            plain,
            RepoId::from_path(Path::new("C:/Dev/other")),
            "the identity still separates distinct worktrees"
        );
    }

    #[test]
    fn posix_paths_keep_their_exact_spelling() {
        // A backslash is an ordinary file-name character on POSIX: normalizing
        // it would merge two distinct directories into one identity.
        assert_ne!(
            RepoId::from_path(Path::new(r"/tmp/a\b")),
            RepoId::from_path(Path::new("/tmp/a/b"))
        );
        assert_eq!(
            RepoId::from_path(Path::new("/tmp/repo/")),
            RepoId::from_path(Path::new("/tmp/repo/")),
            "existing POSIX ids stay byte-stable"
        );
    }

    #[test]
    fn instance_ids_are_provider_scoped() {
        let gitlab = InstanceId::from_api_url("https://api.example.test/v4");
        let github = InstanceId::from_github_api_url("https://api.example.test/v4");
        assert!(gitlab.as_str().starts_with("gl_"));
        assert!(github.as_str().starts_with("gh_"));
        assert_ne!(gitlab, github);
        assert_eq!(
            github,
            InstanceId::from_github_api_url("https://api.example.test/v4")
        );
    }

    #[test]
    fn operation_ids_are_unique() {
        let one = OperationId::new("fetch");
        let two = OperationId::new("fetch");
        assert_ne!(one, two);
        assert!(one.as_str().starts_with("op_fetch_"));
    }
}
