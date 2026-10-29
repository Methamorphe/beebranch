//! GitHub OAuth device authorization grant (RFC 8628).
//!
//! Only `github.com` is supported by the built-in client id. The device code
//! never leaves the backend: the UI receives the user code and verification
//! URI, then polls. The access token is returned once to the caller, stored in
//! the OS keychain, and never logged or debug-printed.

use std::fmt;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::Deserialize;

use crate::client::{build_http_client, error_chain, looks_like_tls, GithubConfig};
use crate::error::GithubError;

/// Scopes requested by the connector: private repositories and the user
/// profile. Checks and Actions reads are covered by `repo` for OAuth tokens.
pub const OAUTH_SCOPES: &str = "repo read:user";

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Device authorization returned when the flow starts.
#[derive(Clone)]
pub struct DeviceCode {
    /// Temporary credential exchanged for the token. Backend-only.
    pub device_code: String,
    /// Code the user types on the verification page.
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

/// Outcome of one token poll.
pub enum PollOutcome {
    /// The user has not authorized the application yet.
    Pending,
    /// GitHub asks the caller to wait longer between polls.
    SlowDown,
    /// The user authorized the application.
    Authorized {
        token: String,
        scope: Option<String>,
    },
}

impl fmt::Debug for PollOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::SlowDown => formatter.write_str("SlowDown"),
            Self::Authorized { scope, .. } => formatter
                .debug_struct("Authorized")
                .field("token", &"[REDACTED]")
                .field("scope", scope)
                .finish(),
        }
    }
}

#[derive(Deserialize)]
struct DeviceCodeWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default)]
    interval: u64,
}

#[derive(Deserialize)]
struct TokenWire {
    access_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
}

/// Ask GitHub for a device code.
pub async fn request_device_code(
    web_base: &str,
    client_id: &str,
    scope: &str,
    timeout: Duration,
) -> Result<DeviceCode, GithubError> {
    let client = http_client(web_base, timeout)?;
    let url = endpoint(web_base, "/login/device/code")?;
    let response = client
        .post(url)
        .header(ACCEPT, "application/json")
        .form(&[("client_id", client_id), ("scope", scope)])
        .send()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    let wire: DeviceCodeWire = read_json(response, web_base).await?;

    if wire.device_code.is_empty() || wire.user_code.is_empty() || wire.verification_uri.is_empty()
    {
        return Err(GithubError::invalid_response(
            "Réponse device flow GitHub incomplète.",
        ));
    }

    Ok(DeviceCode {
        device_code: wire.device_code,
        user_code: wire.user_code,
        verification_uri: wire.verification_uri,
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
) -> Result<PollOutcome, GithubError> {
    let client = http_client(web_base, timeout)?;
    let url = endpoint(web_base, "/login/oauth/access_token")?;
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
    let wire: TokenWire = read_json(response, web_base).await?;

    if let Some(token) = wire.access_token.filter(|token| !token.is_empty()) {
        return Ok(PollOutcome::Authorized {
            token,
            scope: wire.scope,
        });
    }

    match wire.error.as_deref() {
        Some("authorization_pending") => Ok(PollOutcome::Pending),
        Some("slow_down") => Ok(PollOutcome::SlowDown),
        Some("expired_token") => Err(GithubError::new(
            "github.device_flow_expired",
            "Le code de connexion GitHub a expiré. Relancez la connexion.",
        )),
        Some("access_denied") => Err(GithubError::new(
            "github.device_flow_denied",
            "La connexion GitHub a été refusée.",
        )),
        Some("device_flow_disabled") => Err(GithubError::new(
            "github.device_flow_disabled",
            "Le device flow n'est pas activé pour cette OAuth App GitHub.",
        )),
        Some("incorrect_client_credentials")
        | Some("incorrect_device_code")
        | Some("unsupported_grant_type") => Err(GithubError::new(
            "github.oauth_configuration",
            "La configuration OAuth GitHub est invalide.",
        )),
        Some(other) => Err(GithubError::invalid_response(format!(
            "Erreur OAuth GitHub inattendue : {other}"
        ))),
        None => Err(GithubError::invalid_response(
            "Réponse OAuth GitHub sans jeton ni erreur.",
        )),
    }
}

fn http_client(web_base: &str, timeout: Duration) -> Result<Client, GithubError> {
    build_http_client(&GithubConfig {
        base_url: web_base.to_owned(),
        token: String::new(),
        ca_bundle_pem: None,
        timeout,
    })
}

fn endpoint(web_base: &str, path: &str) -> Result<Url, GithubError> {
    Url::parse(&format!("{}{path}", web_base.trim_end_matches('/')))
        .map_err(|error| GithubError::invalid_url(format!("Adresse GitHub invalide : {error}")))
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    web_base: &str,
) -> Result<T, GithubError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| transport_error(web_base, &error))?;
    if !status.is_success() {
        return Err(GithubError::from_status(status.as_u16(), &body, false));
    }
    serde_json::from_str(&body)
        .map_err(|error| GithubError::invalid_response(format!("JSON OAuth inattendu : {error}")))
}

fn transport_error(web_base: &str, error: &reqwest::Error) -> GithubError {
    let host = Url::parse(web_base)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "github.com".to_owned());
    let detail = error_chain(error);
    if error.is_timeout() {
        GithubError::timeout(&host, detail)
    } else if looks_like_tls(&detail) {
        GithubError::tls(&host, detail)
    } else if error.is_decode() {
        GithubError::invalid_response(detail)
    } else {
        GithubError::network(&host, detail)
    }
}

#[cfg(test)]
mod tests;
