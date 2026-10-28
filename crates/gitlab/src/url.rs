//! GitLab instance URL normalization.
//!
//! The user provides the address of their self-hosted instance. It may carry a
//! path prefix (`https://example.com/gitlab`) and a trailing slash. The API
//! base is always the web base plus `/api/v4`; query strings and credentials
//! are never accepted.

use reqwest::Url;

use crate::error::GitlabError;

/// GitLab instance addresses derived from the user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedUrl {
    /// Web base without trailing slash, e.g. `https://example.com/gitlab`.
    pub base_url: String,
    /// REST v4 base, e.g. `https://example.com/gitlab/api/v4`.
    pub api_url: String,
    /// Base used to open pages in the browser.
    pub web_url: String,
    /// Host as displayed in messages, including an explicit port.
    pub host: String,
    /// Path prefix without trailing slash (empty when the instance is at the root).
    pub path_prefix: String,
}

/// Normalize a GitLab instance address.
///
/// Rules:
/// - a scheme is mandatory, and only `https` is accepted (`http` is refused
///   with `gitlab.insecure_url`);
/// - credentials in the authority are refused (`gitlab.url_credentials`);
/// - query strings and fragments are refused (`gitlab.invalid_url`);
/// - the trailing slash is removed while the path prefix is preserved.
pub fn normalize_url(input: &str) -> Result<NormalizedUrl, GitlabError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(GitlabError::invalid_url(
            "L'adresse de l'instance GitLab est vide.",
        ));
    }
    if !trimmed.contains("://") {
        return Err(GitlabError::invalid_url(
            "L'adresse de l'instance GitLab doit inclure le schéma https.",
        ));
    }

    let mut url = Url::parse(trimmed)
        .map_err(|error| GitlabError::invalid_url(format!("Adresse GitLab invalide : {error}")))?;

    match url.scheme() {
        "https" => {}
        "http" => {
            return Err(GitlabError::insecure_url(
                "Le schéma http est refusé. Utilisez https pour joindre GitLab.",
            ));
        }
        other => {
            return Err(GitlabError::invalid_url(format!(
                "Le schéma « {other} » n'est pas pris en charge ; utilisez https."
            )));
        }
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(GitlabError::url_credentials(
            "L'adresse GitLab ne doit pas contenir d'identifiants.",
        ));
    }

    if url.query().is_some() || url.fragment().is_some() {
        return Err(GitlabError::invalid_url(
            "L'adresse GitLab ne doit contenir ni paramètres ni fragment.",
        ));
    }

    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| GitlabError::invalid_url("L'adresse GitLab n'a pas d'hôte."))?
            .to_owned(),
    };

    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if path.is_empty() { "/" } else { &path });

    let base_url = url.as_str().trim_end_matches('/').to_owned();
    let api_url = format!("{base_url}/api/v4");

    Ok(NormalizedUrl {
        web_url: base_url.clone(),
        base_url,
        api_url,
        host,
        path_prefix: path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized(input: &str) -> NormalizedUrl {
        normalize_url(input).expect("valid GitLab URL")
    }

    #[test]
    fn derives_api_and_web_bases_at_the_root() {
        let url = normalized("https://gitlab.example.com");

        assert_eq!(url.base_url, "https://gitlab.example.com");
        assert_eq!(url.web_url, "https://gitlab.example.com");
        assert_eq!(url.api_url, "https://gitlab.example.com/api/v4");
        assert_eq!(url.host, "gitlab.example.com");
        assert_eq!(url.path_prefix, "");
    }

    #[test]
    fn removes_the_trailing_slash() {
        let url = normalized("https://gitlab.example.com/");

        assert_eq!(url.base_url, "https://gitlab.example.com");
        assert_eq!(url.api_url, "https://gitlab.example.com/api/v4");
    }

    #[test]
    fn keeps_the_path_prefix() {
        let url = normalized("https://example.com/gitlab/");

        assert_eq!(url.base_url, "https://example.com/gitlab");
        assert_eq!(url.api_url, "https://example.com/gitlab/api/v4");
        assert_eq!(url.path_prefix, "/gitlab");
    }

    #[test]
    fn keeps_deep_prefixes() {
        let url = normalized("https://example.com/tools/gitlab/");

        assert_eq!(url.path_prefix, "/tools/gitlab");
        assert_eq!(url.api_url, "https://example.com/tools/gitlab/api/v4");
    }

    #[test]
    fn exposes_non_default_ports_in_the_host() {
        let url = normalized("https://gitlab.example.com:8443");

        assert_eq!(url.host, "gitlab.example.com:8443");
        assert_eq!(url.api_url, "https://gitlab.example.com:8443/api/v4");
    }

    #[test]
    fn refuses_plain_http() {
        let error = normalize_url("http://gitlab.example.com").expect_err("http refused");

        assert_eq!(error.code(), "gitlab.insecure_url");
        assert_eq!(error.status(), None);
        assert!(!error.retryable());
    }

    #[test]
    fn refuses_credentials() {
        let error =
            normalize_url("https://user:secret@gitlab.example.com").expect_err("credentials");

        assert_eq!(error.code(), "gitlab.url_credentials");
        assert!(!error.message().contains("secret"));
        assert!(!format!("{error:?}").contains("secret"));
    }

    #[test]
    fn refuses_a_missing_scheme() {
        let error = normalize_url("gitlab.example.com").expect_err("missing scheme");
        assert_eq!(error.code(), "gitlab.invalid_url");
    }

    #[test]
    fn refuses_unsupported_schemes() {
        let error = normalize_url("ftp://gitlab.example.com").expect_err("unsupported scheme");
        assert_eq!(error.code(), "gitlab.invalid_url");
    }

    #[test]
    fn refuses_queries_and_fragments() {
        assert_eq!(
            normalize_url("https://gitlab.example.com/?x=1")
                .expect_err("query refused")
                .code(),
            "gitlab.invalid_url"
        );
        assert_eq!(
            normalize_url("https://gitlab.example.com/#top")
                .expect_err("fragment refused")
                .code(),
            "gitlab.invalid_url"
        );
    }

    #[test]
    fn refuses_empty_input() {
        assert_eq!(
            normalize_url("   ").expect_err("empty refused").code(),
            "gitlab.invalid_url"
        );
    }
}
