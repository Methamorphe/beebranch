//! GitHub instance URL normalization.
//!
//! `github.com` uses a dedicated API host (`api.github.com`). Every other
//! host is treated as GitHub Enterprise Server and exposes its REST API under
//! `/api/v3`. Query strings, fragments and embedded credentials are refused.

use reqwest::Url;

use crate::error::GithubError;

/// GitHub instance addresses derived from the user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedUrl {
    /// Web base without trailing slash, e.g. `https://github.example.com`.
    pub base_url: String,
    /// REST base, e.g. `https://api.github.com` or `https://host/api/v3`.
    pub api_url: String,
    /// Base used to open pages in the browser.
    pub web_url: String,
    /// Host as displayed in messages, including an explicit port.
    pub host: String,
    /// Path prefix without trailing slash (empty for GitHub Cloud).
    pub path_prefix: String,
}

/// Normalize a GitHub address.
///
/// Rules:
/// - a scheme is mandatory, and only `https` is accepted (`http` is refused
///   with `github.insecure_url`);
/// - credentials in the authority are refused (`github.url_credentials`);
/// - query strings and fragments are refused (`github.invalid_url`);
/// - `github.com` and `api.github.com` map to the public API host;
/// - any other host maps to `<base>/api/v3` (GitHub Enterprise Server).
pub fn normalize_url(input: &str) -> Result<NormalizedUrl, GithubError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(GithubError::invalid_url(
            "L'adresse de l'instance GitHub est vide.",
        ));
    }
    if !trimmed.contains("://") {
        return Err(GithubError::invalid_url(
            "L'adresse de l'instance GitHub doit inclure le schéma https.",
        ));
    }

    let mut url = Url::parse(trimmed)
        .map_err(|error| GithubError::invalid_url(format!("Adresse GitHub invalide : {error}")))?;

    match url.scheme() {
        "https" => {}
        "http" => {
            return Err(GithubError::insecure_url(
                "Le schéma http est refusé. Utilisez https pour joindre GitHub.",
            ));
        }
        other => {
            return Err(GithubError::invalid_url(format!(
                "Le schéma « {other} » n'est pas pris en charge ; utilisez https."
            )));
        }
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(GithubError::url_credentials(
            "L'adresse GitHub ne doit pas contenir d'identifiants.",
        ));
    }

    if url.query().is_some() || url.fragment().is_some() {
        return Err(GithubError::invalid_url(
            "L'adresse GitHub ne doit contenir ni paramètres ni fragment.",
        ));
    }

    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| GithubError::invalid_url("L'adresse GitHub n'a pas d'hôte."))?
            .to_ascii_lowercase(),
    };
    let bare_host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if path.is_empty() { "/" } else { &path });

    if matches!(
        bare_host.as_str(),
        "github.com" | "www.github.com" | "api.github.com"
    ) {
        if !path.is_empty() {
            return Err(GithubError::invalid_url(
                "github.com ne prend pas de préfixe de chemin ; indiquez uniquement https://github.com.",
            ));
        }
        return Ok(NormalizedUrl {
            base_url: "https://github.com".to_owned(),
            api_url: "https://api.github.com".to_owned(),
            web_url: "https://github.com".to_owned(),
            host: "github.com".to_owned(),
            path_prefix: String::new(),
        });
    }

    let base_url = url.as_str().trim_end_matches('/').to_owned();
    let api_url = format!("{base_url}/api/v3");

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
        normalize_url(input).expect("valid GitHub URL")
    }

    #[test]
    fn derives_cloud_api_bases() {
        let url = normalized("https://github.com/");

        assert_eq!(url.base_url, "https://github.com");
        assert_eq!(url.web_url, "https://github.com");
        assert_eq!(url.api_url, "https://api.github.com");
        assert_eq!(url.host, "github.com");
        assert_eq!(url.path_prefix, "");
    }

    #[test]
    fn accepts_the_api_host_as_input() {
        let url = normalized("https://api.github.com");
        assert_eq!(url.base_url, "https://github.com");
        assert_eq!(url.api_url, "https://api.github.com");
    }

    #[test]
    fn derives_enterprise_api_bases() {
        let url = normalized("https://github.example.test/");

        assert_eq!(url.base_url, "https://github.example.test");
        assert_eq!(url.api_url, "https://github.example.test/api/v3");
        assert_eq!(url.host, "github.example.test");
    }

    #[test]
    fn keeps_deep_prefixes_and_ports() {
        let url = normalized("https://example.test:8443/tools/github/");

        assert_eq!(url.path_prefix, "/tools/github");
        assert_eq!(url.api_url, "https://example.test:8443/tools/github/api/v3");
        assert_eq!(url.host, "example.test:8443");
    }

    #[test]
    fn refuses_plain_http() {
        let error = normalize_url("http://github.com").expect_err("http refused");
        assert_eq!(error.code(), "github.insecure_url");
        assert!(!error.retryable());
    }

    #[test]
    fn refuses_credentials() {
        let error =
            normalize_url("https://user:secret@github.com").expect_err("credentials refused");
        assert_eq!(error.code(), "github.url_credentials");
        assert!(!error.message().contains("secret"));
        assert!(!format!("{error:?}").contains("secret"));
    }

    #[test]
    fn refuses_missing_scheme_queries_and_fragments() {
        assert_eq!(
            normalize_url("github.com").expect_err("scheme").code(),
            "github.invalid_url"
        );
        assert_eq!(
            normalize_url("https://github.com/?x=1")
                .expect_err("query")
                .code(),
            "github.invalid_url"
        );
        assert_eq!(
            normalize_url("https://github.com/#top")
                .expect_err("fragment")
                .code(),
            "github.invalid_url"
        );
        assert_eq!(
            normalize_url("https://github.com/enterprise")
                .expect_err("path")
                .code(),
            "github.invalid_url"
        );
        assert_eq!(
            normalize_url("   ").expect_err("empty").code(),
            "github.invalid_url"
        );
    }
}
