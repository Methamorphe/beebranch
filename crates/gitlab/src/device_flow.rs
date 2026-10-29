//! GitLab OAuth device authorization grant (RFC 8628) and refresh.
//!
//! Used for gitlab.com only: a self-managed instance needs its own OAuth
//! application. The device code never leaves the backend; the access and
//! refresh tokens are returned once to the caller, stored in the OS keychain,
//! and never logged or debug-printed.

use std::fmt;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::Deserialize;

use crate::client::{build_http_client, error_chain, looks_like_tls, GitlabConfig};
use crate::error::GitlabError;

/// Scopes required by the connector: API, profile and HTTPS clone.
pub const OAUTH_SCOPES: &str = "api read_user read_repository";

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT: &str = "refresh_token";

/// Device authorization returned when the flow starts.
#[derive(Clone)]
pub struct DeviceCode {
    /// Temporary credential exchanged for the token. Backend-only.
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

impl fmt::Debug for DeviceCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceCode")
            .field("device_code", &"[REDACTED]")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .finish()
    }
}

/// Access token plus the refresh token GitLab may rotate on every use.
#[derive(Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub scope: Option<String>,
}

impl fmt::Debug for TokenSet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenSet")
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expires_in", &self.expires_in)
            .field("scope", &self.scope)
            .finish()
    }
}

/// Outcome of one token poll.
pub enum PollOutcome {
    Pending,
    SlowDown,
    Authorized(TokenSet),
}

impl fmt::Debug for PollOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::SlowDown => formatter.write_str("SlowDown"),
            Self::Authorized(tokens) => formatter.debug_tuple("Authorized").field(tokens).finish(),
        }
    }
}

#[derive(Deserialize)]
struct DeviceCodeWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: u64,
}

#[derive(Deserialize)]
struct TokenWire {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
    error: Option<String>,
}

/// Ask GitLab for a device code.
pub async fn request_device_code(
    web_base: &str,
    client_id: &str,
    scope: &str,
    timeout: Duration,
) -> Result<DeviceCode, GitlabError> {
    let client = http_client(web_base, timeout)?;
    let url = endpoint(web_base, "/oauth/authorize_device")?;
    let response = client
        .post(url)
        .header(ACCEPT, "application/json")
        .form(&[("client_id", client_id), ("scope", scope)])
        .send()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    let wire: DeviceCodeWire = read_device_code(response, web_base).await?;

    if wire.device_code.is_empty() || wire.user_code.is_empty() || wire.verification_uri.is_empty()
    {
        return Err(GitlabError::invalid_response(
            "Réponse device flow GitLab incomplète.",
        ));
    }

    Ok(DeviceCode {
        device_code: wire.device_code,
        user_code: wire.user_code,
        verification_uri: wire
            .verification_uri_complete
            .filter(|uri| !uri.is_empty())
            .unwrap_or(wire.verification_uri),
        expires_in: wire.expires_in.clamp(1, 900),
        interval: if wire.interval == 0 {
            5
        } else {
            wire.interval.clamp(1, 60)
        },
    })
}

/// Poll the token endpoint once. Scheduling between polls belongs to the
/// caller so the UI can be cancelled immediately.
pub async fn poll_access_token(
    web_base: &str,
    client_id: &str,
    device_code: &str,
    timeout: Duration,
) -> Result<PollOutcome, GitlabError> {
    let client = http_client(web_base, timeout)?;
    let url = endpoint(web_base, "/oauth/token")?;
    let response = client
        .post(url)
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", DEVICE_GRANT),
        ])
        .send()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    let wire: TokenWire = read_token(response, web_base).await?;

    if let Some(access_token) = wire.access_token.filter(|token| !token.is_empty()) {
        return Ok(PollOutcome::Authorized(TokenSet {
            access_token,
            refresh_token: wire.refresh_token.filter(|token| !token.is_empty()),
            expires_in: wire.expires_in.unwrap_or(7200).clamp(60, 86_400),
            scope: wire.scope,
        }));
    }

    match wire.error.as_deref() {
        Some("authorization_pending") => Ok(PollOutcome::Pending),
        Some("slow_down") => Ok(PollOutcome::SlowDown),
        Some("expired_token") => Err(GitlabError::new(
            "gitlab.device_flow_expired",
            "Le code de connexion GitLab a expiré. Relancez la connexion.",
        )),
        Some("access_denied") => Err(GitlabError::new(
            "gitlab.device_flow_denied",
            "La connexion GitLab a été refusée.",
        )),
        Some("invalid_client") | Some("invalid_grant") => Err(GitlabError::new(
            "gitlab.oauth_configuration",
            "La configuration OAuth GitLab est invalide.",
        )),
        Some(other) => Err(GitlabError::invalid_response(format!(
            "Erreur OAuth GitLab inattendue : {other}"
        ))),
        None => Err(GitlabError::invalid_response(
            "Réponse OAuth GitLab sans jeton ni erreur.",
        )),
    }
}

/// Exchange a refresh token for a new access token. GitLab rotates the refresh
/// token: callers must persist the returned one.
pub async fn refresh_access_token(
    web_base: &str,
    client_id: &str,
    refresh_token: &str,
    timeout: Duration,
) -> Result<TokenSet, GitlabError> {
    let client = http_client(web_base, timeout)?;
    let url = endpoint(web_base, "/oauth/token")?;
    let response = client
        .post(url)
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", REFRESH_GRANT),
        ])
        .send()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    let wire: TokenWire = read_token(response, web_base).await?;

    let Some(access_token) = wire.access_token.filter(|token| !token.is_empty()) else {
        return Err(GitlabError::new(
            "gitlab.oauth_refresh_failed",
            "La session GitLab a expiré. Reconnectez l'instance.",
        ));
    };
    Ok(TokenSet {
        access_token,
        refresh_token: wire.refresh_token.filter(|token| !token.is_empty()),
        expires_in: wire.expires_in.unwrap_or(7200).clamp(60, 86_400),
        scope: wire.scope,
    })
}

fn http_client(web_base: &str, timeout: Duration) -> Result<Client, GitlabError> {
    build_http_client(&GitlabConfig {
        base_url: web_base.to_owned(),
        token: String::new(),
        ca_bundle_pem: None,
        timeout,
    })
}

fn endpoint(web_base: &str, path: &str) -> Result<Url, GitlabError> {
    Url::parse(&format!("{}{path}", web_base.trim_end_matches('/')))
        .map_err(|error| GitlabError::invalid_url(format!("Adresse GitLab invalide : {error}")))
}

/// Parse the device authorization response. GitLab answers `access_denied`
/// when the OAuth application does not have the device grant enabled, which is
/// a configuration problem rather than a refused consent.
async fn read_device_code(
    response: reqwest::Response,
    web_base: &str,
) -> Result<DeviceCodeWire, GitlabError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    if status.is_success() {
        return serde_json::from_str(&body).map_err(|error| {
            GitlabError::invalid_response(format!("JSON OAuth inattendu : {error}"))
        });
    }
    #[derive(Deserialize)]
    struct ErrorWire {
        error: Option<String>,
    }
    let error = serde_json::from_str::<ErrorWire>(&body)
        .ok()
        .and_then(|wire| wire.error);
    match error.as_deref() {
        Some("access_denied") => Err(GitlabError::new(
            "gitlab.device_flow_disabled",
            "Le device flow n'est pas activé sur l'application OAuth GitLab. Cochez « Device authorization grant » dans les réglages de l'application sur gitlab.com.",
        )),
        Some("invalid_scope") => Err(GitlabError::new(
            "gitlab.oauth_scope",
            "L'application OAuth GitLab n'autorise pas les scopes demandés (api, read_user, read_repository).",
        )),
        Some("invalid_client") => Err(GitlabError::new(
            "gitlab.oauth_configuration",
            "L'Application ID OAuth GitLab est invalide.",
        )),
        _ => Err(GitlabError::from_status(status.as_u16(), &body)),
    }
}

/// Token endpoint responses (RFC 6749/8628) carry `error` in the body with a
/// `400` status, so a JSON error must win over the HTTP status.
async fn read_token(response: reqwest::Response, web_base: &str) -> Result<TokenWire, GitlabError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    if let Ok(wire) = serde_json::from_str::<TokenWire>(&body) {
        if wire.access_token.is_some() || wire.error.is_some() {
            return Ok(wire);
        }
    }
    if !status.is_success() {
        return Err(GitlabError::from_status(status.as_u16(), &body));
    }
    serde_json::from_str(&body)
        .map_err(|error| GitlabError::invalid_response(format!("JSON OAuth inattendu : {error}")))
}

fn transport_error(web_base: &str, error: &reqwest::Error) -> GitlabError {
    let host = Url::parse(web_base)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "gitlab.com".to_owned());
    let detail = error_chain(error);
    if error.is_timeout() {
        GitlabError::timeout(&host, detail)
    } else if looks_like_tls(&detail) {
        GitlabError::tls(&host, detail)
    } else if error.is_decode() {
        GitlabError::invalid_response(detail)
    } else {
        GitlabError::network(&host, detail)
    }
}

#[cfg(test)]
mod tests;
