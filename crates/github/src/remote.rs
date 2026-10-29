//! Remote URL normalization and repository ↔ project matching.
//!
//! Supports `git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`,
//! `https://host/owner/repo.git` and a path prefix used by reverse proxies.

use reqwest::Url;

use crate::models::GithubProject;

/// Location extracted from a Git remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteInfo {
    /// Lowercase host.
    pub host: String,
    /// Explicit port, when the URL carries one.
    pub port: Option<u16>,
    /// Repository path without leading slash and without the `.git` suffix.
    pub path: String,
    /// Instance path prefix when it is known.
    pub path_prefix: Option<String>,
}

/// Normalize a Git remote URL.
///
/// Returns `None` for unsupported schemes, URLs with credentials, or URLs
/// without a repository path. Credentials are never propagated.
pub fn normalize_remote(input: &str) -> Option<RemoteInfo> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    if let Some((scheme, _)) = raw.split_once("://") {
        if !matches!(scheme, "ssh" | "https" | "http") {
            return None;
        }
        let url = Url::parse(raw).ok()?;
        if url.password().is_some() {
            return None;
        }
        let host = url.host_str()?.to_ascii_lowercase();
        let path = clean_path(url.path())?;
        return Some(RemoteInfo {
            host,
            port: url.port(),
            path,
            path_prefix: None,
        });
    }

    // SCP-like syntax: `[user@]host:path`. A `user@` part is required so that
    // Windows drive paths (`C:\repo`) are never mistaken for a remote.
    let (authority, path) = raw.split_once(':')?;
    if path.starts_with("//") {
        return None;
    }
    let (user, host) = authority.rsplit_once('@')?;
    if user.is_empty() || host.is_empty() || host.contains('/') {
        return None;
    }
    let path = clean_path(path)?;

    Some(RemoteInfo {
        host: host.to_ascii_lowercase(),
        port: None,
        path,
        path_prefix: None,
    })
}

/// Whether a remote points at `project`.
///
/// Comparison uses the clone URLs exposed by GitHub first, then the host plus
/// the `owner/repo` path. Path prefixes and `.git` suffixes are tolerated.
pub fn matches_project(remote: &RemoteInfo, project: &GithubProject) -> bool {
    for clone_url in [
        project.ssh_url_to_repo.as_deref(),
        project.http_url_to_repo.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(candidate) = normalize_remote(clone_url) {
            if same_location(remote, &candidate) {
                return true;
            }
        }
    }

    let Some(web) = normalize_remote(&project.web_url) else {
        return false;
    };
    if !remote.host.eq_ignore_ascii_case(&web.host) {
        return false;
    }
    if let (Some(remote_port), Some(web_port)) = (remote.port, web.port) {
        if remote_port != web_port {
            return false;
        }
    }

    let namespace = clean_path(&project.path_with_namespace).unwrap_or_default();
    let remote_path = remote.path.as_str();

    remote_path == namespace
        || remote_path.ends_with(&format!("/{namespace}"))
        || remote_path == web.path
}

fn same_location(left: &RemoteInfo, right: &RemoteInfo) -> bool {
    if !left.host.eq_ignore_ascii_case(&right.host) || left.path != right.path {
        return false;
    }
    match (left.port, right.port) {
        (Some(left_port), Some(right_port)) => left_port == right_port,
        _ => true,
    }
}

fn clean_path(path: &str) -> Option<String> {
    let trimmed = path.trim_matches('/').trim();
    let without_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let trimmed = without_suffix.trim_end_matches('/');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> GithubProject {
        GithubProject {
            id: 42,
            name: "bee".to_owned(),
            path_with_namespace: "team/bee".to_owned(),
            web_url: "https://github.example.test/team/bee".to_owned(),
            ssh_url_to_repo: Some("git@github.example.test:team/bee.git".to_owned()),
            http_url_to_repo: Some("https://github.example.test/team/bee.git".to_owned()),
            default_branch: Some("main".to_owned()),
            last_activity_at: None,
            description: None,
        }
    }

    #[test]
    fn parses_every_supported_remote_form() {
        let scp = normalize_remote("git@github.com:owner/repo.git").expect("scp");
        assert_eq!(scp.host, "github.com");
        assert_eq!(scp.path, "owner/repo");

        let ssh = normalize_remote("ssh://git@github.com:2222/owner/repo.git").expect("ssh");
        assert_eq!(ssh.port, Some(2222));

        let https = normalize_remote("https://github.com/owner/repo/").expect("https");
        assert_eq!(https.path, "owner/repo");
    }

    #[test]
    fn rejects_credentials_and_unsupported_inputs() {
        assert!(normalize_remote("https://oauth2:ghp_secret@github.com/o/r.git").is_none());
        assert!(normalize_remote("ftp://github.com/o/r.git").is_none());
        assert!(normalize_remote("C:\\repos\\bee").is_none());
        assert!(normalize_remote("https://github.com/").is_none());
    }

    #[test]
    fn matches_ssh_https_and_prefixed_remotes() {
        let project = project();
        for url in [
            "git@github.example.test:team/bee.git",
            "ssh://git@github.example.test:2222/team/bee.git",
            "https://github.example.test/team/bee.git",
            "https://github.example.test/proxy/team/bee.git",
        ] {
            let remote = normalize_remote(url).expect("remote");
            assert!(matches_project(&remote, &project), "{url} should match");
        }

        let other = normalize_remote("git@github.example.test:team/other.git").unwrap();
        assert!(!matches_project(&other, &project));
        let cloud = normalize_remote("git@github.com:team/bee.git").unwrap();
        assert!(!matches_project(&cloud, &project));
    }
}
