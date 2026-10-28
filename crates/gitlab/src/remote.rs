//! Remote URL normalization and repository ↔ project matching.
//!
//! Supports the forms GitLab exposes and users commonly configure:
//! `git@host:group/project.git`, `ssh://git@host:2222/group/project.git`,
//! `https://host/group/project.git` and `https://host/prefix/group/project.git`.
//! Sub-groups are preserved as part of the path.

use reqwest::Url;

use crate::models::GitlabProject;

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
    ///
    /// A remote URL alone cannot distinguish an instance prefix from a
    /// namespace, so [`normalize_remote`] leaves this empty and
    /// [`matches_project`] resolves the prefix against the project web URL.
    pub path_prefix: Option<String>,
}

/// Normalize a Git remote URL.
///
/// Returns `None` for unsupported schemes, URLs with credentials, or URLs
/// without a repository path. Credentials are never propagated: a remote that
/// embeds a password is rejected outright.
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
/// The comparison relies first on the clone URLs exposed by GitLab, then on
/// the host plus the namespace path. A path prefix on the instance (for
/// example `/gitlab`) and an optional `.git` suffix are both tolerated.
pub fn matches_project(remote: &RemoteInfo, project: &GitlabProject) -> bool {
    for clone_url in [&project.ssh_url_to_repo, &project.http_url_to_repo] {
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

    fn project() -> GitlabProject {
        GitlabProject {
            id: 42,
            name: "Bee".to_owned(),
            path_with_namespace: "team/platform/bee".to_owned(),
            web_url: "https://gitlab.example.com/gitlab/team/platform/bee".to_owned(),
            ssh_url_to_repo: "git@gitlab.example.com:team/platform/bee.git".to_owned(),
            http_url_to_repo: "https://gitlab.example.com/gitlab/team/platform/bee.git".to_owned(),
            default_branch: Some("main".to_owned()),
            last_activity_at: None,
            description: None,
        }
    }

    #[test]
    fn parses_scp_style_remotes() {
        let remote =
            normalize_remote("git@gitlab.example.com:team/platform/bee.git").expect("scp remote");

        assert_eq!(remote.host, "gitlab.example.com");
        assert_eq!(remote.port, None);
        assert_eq!(remote.path, "team/platform/bee");
        assert_eq!(remote.path_prefix, None);
    }

    #[test]
    fn parses_ssh_urls_with_a_port() {
        let remote =
            normalize_remote("ssh://git@gitlab.example.com:2222/team/bee.git").expect("ssh remote");

        assert_eq!(remote.host, "gitlab.example.com");
        assert_eq!(remote.port, Some(2222));
        assert_eq!(remote.path, "team/bee");
    }

    #[test]
    fn parses_https_urls_with_and_without_prefix() {
        let plain = normalize_remote("https://gitlab.example.com/team/bee.git").expect("https");
        assert_eq!(plain.path, "team/bee");
        assert_eq!(plain.port, None);

        let prefixed =
            normalize_remote("https://gitlab.example.com/gitlab/team/bee.git").expect("prefixed");
        assert_eq!(prefixed.path, "gitlab/team/bee");
        assert_eq!(prefixed.path_prefix, None);
    }

    #[test]
    fn tolerates_a_trailing_slash_and_missing_git_suffix() {
        let remote = normalize_remote("https://gitlab.example.com/team/bee/").expect("remote");
        assert_eq!(remote.path, "team/bee");
    }

    #[test]
    fn rejects_credentials_and_unsupported_inputs() {
        assert!(
            normalize_remote("https://oauth2:glpat-secret@gitlab.example.com/t/b.git").is_none()
        );
        assert!(normalize_remote("ftp://gitlab.example.com/t/b.git").is_none());
        assert!(normalize_remote("C:\\repos\\bee").is_none());
        assert!(normalize_remote("https://gitlab.example.com/").is_none());
        assert!(normalize_remote("   ").is_none());
        assert!(normalize_remote("git@gitlab.example.com:").is_none());
    }

    #[test]
    fn matches_ssh_and_http_remotes() {
        let project = project();

        for url in [
            "git@gitlab.example.com:team/platform/bee.git",
            "ssh://git@gitlab.example.com:2222/team/platform/bee.git",
            "https://gitlab.example.com/team/platform/bee.git",
            "https://gitlab.example.com/gitlab/team/platform/bee.git",
        ] {
            let remote = normalize_remote(url).expect("remote");
            assert!(matches_project(&remote, &project), "{url} should match");
        }
    }

    #[test]
    fn matches_across_prefixes_but_rejects_other_hosts_and_projects() {
        let project = project();

        let other_host =
            normalize_remote("https://evil.example.com/gitlab/team/platform/bee.git").unwrap();
        assert!(!matches_project(&other_host, &project));

        let other_project = normalize_remote("git@gitlab.example.com:team/other.git").unwrap();
        assert!(!matches_project(&other_project, &project));

        let prefix_lookalike =
            normalize_remote("https://gitlab.example.com/other/team/platform/bee.git").unwrap();
        assert!(matches_project(&prefix_lookalike, &project));
    }

    #[test]
    fn supports_repositories_without_a_prefix() {
        let mut project = project();
        project.web_url = "https://gitlab.example.com/team/platform/bee".to_owned();

        let remote = normalize_remote("git@gitlab.example.com:team/platform/bee.git").unwrap();

        assert!(matches_project(&remote, &project));
    }
}
