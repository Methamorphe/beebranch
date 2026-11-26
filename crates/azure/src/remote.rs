//! Remote URL normalization and repository matching.
//!
//! Recognized forms:
//! `https://dev.azure.com/{org}/{project}/_git/{repo}`,
//! `https://{org}@dev.azure.com/{org}/{project}/_git/{repo}`,
//! `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`,
//! `https://{org}.visualstudio.com/{project}/_git/{repo}`,
//! `https://{host}/{collection}/{project}/_git/{repo}` and
//! `https://{host}/tfs/{collection}/{project}/_git/{repo}`.

use reqwest::Url;

use crate::models::AzureProject;
use crate::url::NormalizedUrl;

/// Location extracted from a Git remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteInfo {
    pub host: String,
    pub port: Option<u16>,
    pub organization: String,
    pub project: String,
    pub repository: String,
    /// Collection path kept for Server (`tfs/DefaultCollection` or `DefaultCollection`).
    pub collection: String,
}

/// Normalize a Git remote that points at Azure DevOps.
///
/// Returns `None` for any other forge, for credentials in the URL, or when
/// the path is not a repository.
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
        let segments: Vec<String> = url
            .path_segments()?
            .filter(|segment| !segment.is_empty())
            .map(|segment| segment.to_owned())
            .collect();
        return from_segments(&host, url.port(), &segments);
    }

    let (authority, path) = raw.split_once(':')?;
    if path.starts_with("//") {
        return None;
    }
    let (user, host) = authority.rsplit_once('@')?;
    if user.is_empty() || host.is_empty() || host.contains('/') {
        return None;
    }
    let segments: Vec<String> = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(strip_git)
        .collect();
    from_segments(&host.to_ascii_lowercase(), None, &segments)
}

/// Whether `remote` belongs to the configured instance.
pub fn belongs_to_instance(remote: &RemoteInfo, instance: &NormalizedUrl) -> bool {
    if !remote
        .organization
        .eq_ignore_ascii_case(&instance.organization)
    {
        return false;
    }
    let instance_host = instance.host.to_ascii_lowercase();
    let remote_host = remote.host.to_ascii_lowercase();
    if instance_host == "dev.azure.com" {
        return remote_host == "dev.azure.com"
            || remote_host == "ssh.dev.azure.com"
            || remote_host
                == format!(
                    "{}.visualstudio.com",
                    instance.organization.to_ascii_lowercase()
                );
    }
    if instance_host.ends_with(".visualstudio.com") {
        return remote_host == instance_host
            || remote_host == "dev.azure.com"
            || remote_host == "ssh.dev.azure.com";
    }
    remote_host == instance_host
        && remote
            .collection
            .eq_ignore_ascii_case(&server_collection(instance))
}

/// Whether a remote points at `project`.
pub fn matches_project(remote: &RemoteInfo, project: &AzureProject) -> bool {
    for clone_url in [
        project.ssh_url_to_repo.as_deref(),
        project.http_url_to_repo.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(candidate) = normalize_remote(clone_url) {
            if same_repo(remote, &candidate) {
                return true;
            }
        }
    }
    let Some(web) = normalize_remote(&project.web_url) else {
        return false;
    };
    same_repo(remote, &web)
}

fn same_repo(left: &RemoteInfo, right: &RemoteInfo) -> bool {
    left.organization.eq_ignore_ascii_case(&right.organization)
        && left.project.eq_ignore_ascii_case(&right.project)
        && left.repository.eq_ignore_ascii_case(&right.repository)
        && hosts_compatible(&left.host, &right.host)
}

fn hosts_compatible(left: &str, right: &str) -> bool {
    let left = left.to_ascii_lowercase();
    let right = right.to_ascii_lowercase();
    if left == right {
        return true;
    }
    let services = |host: &str| {
        host == "dev.azure.com"
            || host == "ssh.dev.azure.com"
            || host.ends_with(".visualstudio.com")
    };
    services(&left) && services(&right)
}

fn server_collection(instance: &NormalizedUrl) -> String {
    Url::parse(&instance.base_url)
        .ok()
        .and_then(|url| {
            let segments: Vec<&str> = url
                .path_segments()?
                .filter(|segment| !segment.is_empty())
                .collect();
            if segments.is_empty() {
                None
            } else {
                Some(segments.join("/"))
            }
        })
        .unwrap_or_default()
}

fn from_segments(host: &str, port: Option<u16>, segments: &[String]) -> Option<RemoteInfo> {
    if host == "ssh.dev.azure.com" {
        let rest = segments
            .strip_prefix(&[String::from("v3")])
            .unwrap_or(segments);
        let (organization, project, repository) = triple(rest)?;
        return Some(RemoteInfo {
            host: host.to_owned(),
            port,
            organization,
            project,
            repository,
            collection: String::new(),
        });
    }
    if host == "dev.azure.com" {
        let (organization, project, repository) = git_triple(segments)?;
        return Some(RemoteInfo {
            host: host.to_owned(),
            port,
            organization,
            project,
            repository,
            collection: String::new(),
        });
    }
    if let Some(organization) = host.strip_suffix(".visualstudio.com") {
        if organization.is_empty() || organization.contains('.') {
            return None;
        }
        let (project, repository) = visualstudio_repo(segments)?;
        return Some(RemoteInfo {
            host: host.to_owned(),
            port,
            organization: organization.to_owned(),
            project,
            repository,
            collection: String::new(),
        });
    }
    let git = segments.iter().position(|segment| segment == "_git")?;
    if git < 2 || git + 1 >= segments.len() {
        return None;
    }
    let repository = strip_git(&segments[git + 1]);
    let project = segments[git - 1].clone();
    if repository.is_empty() || project.is_empty() {
        return None;
    }
    let collection = segments[..git - 1].join("/");
    let organization = segments[git - 2].clone();
    if collection.is_empty() {
        return None;
    }
    Some(RemoteInfo {
        host: host.to_owned(),
        port,
        organization,
        project,
        repository,
        collection,
    })
}

fn git_triple(segments: &[String]) -> Option<(String, String, String)> {
    let git = segments.iter().position(|segment| segment == "_git")?;
    if git < 2 || git + 1 >= segments.len() {
        return None;
    }
    let repository = strip_git(&segments[git + 1]);
    if repository.is_empty() {
        return None;
    }
    Some((
        segments[git - 2].clone(),
        segments[git - 1].clone(),
        repository,
    ))
}

fn visualstudio_repo(segments: &[String]) -> Option<(String, String)> {
    let git = segments.iter().position(|segment| segment == "_git")?;
    if git == 0 || git + 1 >= segments.len() {
        return None;
    }
    let repository = strip_git(&segments[git + 1]);
    if repository.is_empty() {
        return None;
    }
    Some((segments[git - 1].clone(), repository))
}

fn triple(segments: &[String]) -> Option<(String, String, String)> {
    if segments.len() < 3 {
        return None;
    }
    let repository = strip_git(segments.last()?);
    if repository.is_empty() {
        return None;
    }
    Some((segments[0].clone(), segments[1].clone(), repository))
}

fn strip_git(segment: &str) -> String {
    segment.strip_suffix(".git").unwrap_or(segment).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> AzureProject {
        AzureProject {
            id: 1,
            name: "website".into(),
            path_with_namespace: "Fabrikam/website".into(),
            web_url: "https://dev.azure.com/contoso/Fabrikam/_git/website".into(),
            ssh_url_to_repo: Some("git@ssh.dev.azure.com:v3/contoso/Fabrikam/website".into()),
            http_url_to_repo: Some(
                "https://contoso@dev.azure.com/contoso/Fabrikam/_git/website".into(),
            ),
            default_branch: Some("main".into()),
            last_activity_at: None,
            description: None,
            external_id: "proj/repo".into(),
            project_name: "Fabrikam".into(),
        }
    }

    #[test]
    fn parses_https_ssh_and_visualstudio() {
        let https = normalize_remote("https://dev.azure.com/contoso/Fabrikam/_git/website.git")
            .expect("https");
        assert_eq!(https.organization, "contoso");
        assert_eq!(https.project, "Fabrikam");
        assert_eq!(https.repository, "website");

        let ssh =
            normalize_remote("git@ssh.dev.azure.com:v3/contoso/Fabrikam/website.git").expect("ssh");
        assert_eq!(ssh.host, "ssh.dev.azure.com");
        assert_eq!(ssh.repository, "website");

        let legacy = normalize_remote("https://contoso.visualstudio.com/Fabrikam/_git/website")
            .expect("legacy");
        assert_eq!(legacy.organization, "contoso");
        assert_eq!(legacy.project, "Fabrikam");
    }

    #[test]
    fn matches_across_https_and_ssh() {
        let remote =
            normalize_remote("git@ssh.dev.azure.com:v3/contoso/Fabrikam/website").expect("ssh");
        assert!(matches_project(&remote, &project()));
        let other =
            normalize_remote("https://dev.azure.com/other/Fabrikam/_git/website").expect("other");
        assert!(!matches_project(&other, &project()));
    }

    #[test]
    fn instance_membership_accepts_the_ssh_host() {
        let instance = crate::url::normalize_url("https://dev.azure.com/contoso").expect("url");
        let ssh =
            normalize_remote("git@ssh.dev.azure.com:v3/contoso/Fabrikam/website").expect("ssh");
        assert!(belongs_to_instance(&ssh, &instance));
        let gitlab = RemoteInfo {
            host: "gitlab.example.test".into(),
            port: None,
            organization: "contoso".into(),
            project: "Fabrikam".into(),
            repository: "website".into(),
            collection: String::new(),
        };
        assert!(!belongs_to_instance(&gitlab, &instance));
    }

    #[test]
    fn parses_server_repository_urls() {
        let remote = normalize_remote(
            "https://devops.example.test/tfs/DefaultCollection/App/_git/website.git",
        )
        .expect("server");
        assert_eq!(remote.collection, "tfs/DefaultCollection");
        assert_eq!(remote.organization, "DefaultCollection");
        assert_eq!(remote.project, "App");
        assert_eq!(remote.repository, "website");
    }
}
