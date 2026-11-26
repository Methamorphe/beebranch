//! Azure DevOps instance URL normalization.
//!
//! Services live at `https://dev.azure.com/{organization}` or
//! `https://{organization}.visualstudio.com`. Server lives at
//! `https://{host}/{collection}` or `https://{host}/tfs/{collection}`.
//! A repository URL (`…/_git/{repo}`) is reduced to the instance so pasting
//! a clone URL still connects. Query strings, fragments and credentials are
//! refused. Only `https` is accepted.

use reqwest::Url;

use crate::error::AzureError;

/// Azure DevOps instance addresses derived from the user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedUrl {
    /// Web base without a trailing slash.
    pub base_url: String,
    /// REST base. Azure serves `/_apis` under this URL.
    pub api_url: String,
    pub web_url: String,
    /// Host as displayed, including an explicit port. No path.
    pub host: String,
    /// Organization (Services) or collection (Server).
    pub organization: String,
}

/// Normalize an Azure DevOps address.
pub fn normalize_url(input: &str) -> Result<NormalizedUrl, AzureError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AzureError::invalid_url(
            "L'adresse de l'organisation Azure DevOps est vide.",
        ));
    }
    if !trimmed.contains("://") {
        return Err(AzureError::invalid_url(
            "L'adresse Azure DevOps doit inclure le schéma https.",
        ));
    }
    let url = Url::parse(trimmed).map_err(|error| {
        AzureError::invalid_url(format!("Adresse Azure DevOps invalide : {error}"))
    })?;
    match url.scheme() {
        "https" => {}
        "http" => {
            return Err(AzureError::insecure_url(
                "Le schéma http est refusé. Utilisez https pour joindre Azure DevOps.",
            ));
        }
        other => {
            return Err(AzureError::invalid_url(format!(
                "Le schéma « {other} » n'est pas pris en charge ; utilisez https."
            )));
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AzureError::url_credentials(
            "L'adresse Azure DevOps ne doit pas contenir d'identifiants.",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AzureError::invalid_url(
            "L'adresse Azure DevOps ne doit contenir ni paramètres ni fragment.",
        ));
    }
    let bare_host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| AzureError::invalid_url("L'adresse Azure DevOps n'a pas d'hôte."))?
        .to_ascii_lowercase();
    let host = match url.port() {
        Some(port) => format!("{bare_host}:{port}"),
        None => bare_host.clone(),
    };
    let segments = path_segments(&url);

    if bare_host == "dev.azure.com" || bare_host == "www.dev.azure.com" {
        let organization = segments
            .first()
            .filter(|segment| !segment.is_empty())
            .ok_or_else(|| {
                AzureError::invalid_url(
                    "Indiquez l'organisation : https://dev.azure.com/{organisation}.",
                )
            })?;
        if segments.len() > 1
            && segments.get(1).map(String::as_str) != Some("_git")
            && segments.get(2).map(String::as_str) != Some("_git")
        {
            // `/{org}/{project}` without `_git` is not an instance URL.
            if !segments.iter().any(|segment| segment == "_git") {
                return Err(AzureError::invalid_url(
                    "Indiquez l'organisation (https://dev.azure.com/{organisation}), pas un projet.",
                ));
            }
        }
        let base = format!("https://dev.azure.com/{organization}");
        return Ok(NormalizedUrl {
            api_url: base.clone(),
            web_url: base.clone(),
            base_url: base,
            host: "dev.azure.com".to_owned(),
            organization: organization.clone(),
        });
    }

    if let Some(organization) = bare_host.strip_suffix(".visualstudio.com") {
        if organization.is_empty() || organization == "www" || organization.contains('.') {
            return Err(AzureError::invalid_url(
                "L'adresse visualstudio.com doit être https://{organisation}.visualstudio.com.",
            ));
        }
        if segments.iter().any(|segment| segment != "_git")
            && !segments.is_empty()
            && !segments.iter().any(|segment| segment == "_git")
        {
            return Err(AzureError::invalid_url(
                "Indiquez l'organisation, pas un chemin de projet.",
            ));
        }
        let base = format!("https://{organization}.visualstudio.com");
        return Ok(NormalizedUrl {
            api_url: base.clone(),
            web_url: base.clone(),
            base_url: base,
            host: format!("{organization}.visualstudio.com"),
            organization: organization.to_owned(),
        });
    }

    let collection = server_collection(&segments).ok_or_else(|| {
        AzureError::invalid_url(
            "Pour Azure DevOps Server, indiquez la collection : https://{hôte}/{collection} ou https://{hôte}/tfs/{collection}.",
        )
    })?;
    let mut base = Url::parse(&format!("https://{host}")).map_err(|error| {
        AzureError::invalid_url(format!("Adresse Azure DevOps invalide : {error}"))
    })?;
    {
        let mut path = base.path_segments_mut().map_err(|_| {
            AzureError::configuration("L'hôte Azure DevOps ne peut pas recevoir de chemin.")
        })?;
        path.clear();
        for segment in &collection {
            path.push(segment);
        }
    }
    let base_url = base.as_str().trim_end_matches('/').to_owned();
    Ok(NormalizedUrl {
        web_url: base_url.clone(),
        api_url: base_url.clone(),
        base_url,
        host,
        organization: collection.last().cloned().unwrap_or_default(),
    })
}

fn path_segments(url: &Url) -> Vec<String> {
    url.path_segments()
        .into_iter()
        .flatten()
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_owned())
        .collect()
}

/// Collection path of an Azure DevOps Server URL.
///
/// `/{collection}`, `/tfs/{collection}`, or the same prefixes followed by
/// `/{project}/_git/{repo}`.
fn server_collection(segments: &[String]) -> Option<Vec<String>> {
    if segments.is_empty() {
        return None;
    }
    let git = segments.iter().position(|segment| segment == "_git");
    let collection_end = git
        .map(|index| index.saturating_sub(1))
        .unwrap_or(segments.len());
    if collection_end == 0 {
        return None;
    }
    let head = &segments[..collection_end];
    if head.first().map(String::as_str) == Some("tfs") {
        if head.len() < 2 {
            return None;
        }
        return Some(head.to_vec());
    }
    if head.len() == 1 || git.is_some() {
        return Some(vec![head[0].clone()]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized(input: &str) -> NormalizedUrl {
        normalize_url(input).expect("valid Azure URL")
    }

    #[test]
    fn derives_services_organization() {
        let url = normalized("https://dev.azure.com/contoso/");
        assert_eq!(url.base_url, "https://dev.azure.com/contoso");
        assert_eq!(url.api_url, "https://dev.azure.com/contoso");
        assert_eq!(url.host, "dev.azure.com");
        assert_eq!(url.organization, "contoso");
    }

    #[test]
    fn reduces_a_repository_url_to_the_organization() {
        let url = normalized("https://dev.azure.com/contoso/Fabrikam/_git/website");
        assert_eq!(url.base_url, "https://dev.azure.com/contoso");
        assert_eq!(url.organization, "contoso");
    }

    #[test]
    fn accepts_visualstudio_host() {
        let url = normalized("https://contoso.visualstudio.com/");
        assert_eq!(url.base_url, "https://contoso.visualstudio.com");
        assert_eq!(url.organization, "contoso");
    }

    #[test]
    fn derives_server_collection() {
        let url = normalized("https://devops.example.test:8443/tfs/DefaultCollection/");
        assert_eq!(
            url.base_url,
            "https://devops.example.test:8443/tfs/DefaultCollection"
        );
        assert_eq!(url.organization, "DefaultCollection");
        assert_eq!(url.host, "devops.example.test:8443");
    }

    #[test]
    fn reduces_a_server_repository_url() {
        let url = normalized("https://devops.example.test/DefaultCollection/App/_git/website");
        assert_eq!(
            url.base_url,
            "https://devops.example.test/DefaultCollection"
        );
    }

    #[test]
    fn refuses_plain_http_credentials_and_a_bare_host() {
        assert_eq!(
            normalize_url("http://dev.azure.com/contoso")
                .expect_err("http")
                .code(),
            "azure.insecure_url"
        );
        let credentials =
            normalize_url("https://user:secret@dev.azure.com/contoso").expect_err("credentials");
        assert_eq!(credentials.code(), "azure.url_credentials");
        assert!(!credentials.message().contains("secret"));
        assert!(!format!("{credentials:?}").contains("secret"));
        assert_eq!(
            normalize_url("https://dev.azure.com")
                .expect_err("org")
                .code(),
            "azure.invalid_url"
        );
        assert_eq!(
            normalize_url("dev.azure.com/contoso")
                .expect_err("scheme")
                .code(),
            "azure.invalid_url"
        );
    }
}
