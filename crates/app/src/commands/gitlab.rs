use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory, InstanceId};
use beebranch_gitlab::{
    normalize_url, GitlabClient, GitlabConfig, GitlabProject, GitlabUser, Paged, ProjectsQuery,
    DEFAULT_CACHE_TTL,
};
use beebranch_store::{IdentityRow, InstanceRow, ProjectRow, SecretStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{gitlab_error, store_error};
use crate::forge_cache::SqliteCache;
use crate::state::{AppState, GitlabDeviceFlowPending};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DEVICE_FLOW_TIMEOUT: Duration = Duration::from_secs(20);
const GITLAB_CLOUD: &str = "https://gitlab.com";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabInstanceDto {
    pub id: String,
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabSessionDto {
    pub connected: bool,
    pub instance: Option<GitlabInstanceDto>,
    pub user: Option<GitlabUser>,
    /// `keychain` for a token entered in the app, otherwise the origin of the
    /// credential discovered in the Git configuration. `None` when nothing is
    /// connected.
    pub credential_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabConfigureInput {
    pub base_url: String,
    pub token: String,
    pub ca_pem: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabConnectFromGitInput {
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabDeviceFlowStartInput {
    #[serde(default)]
    pub base_url: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabDeviceFlowStartDto {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabDeviceFlowPollDto {
    /// `pending` or `connected`.
    pub status: String,
    pub interval: Option<u64>,
    pub session: Option<GitlabSessionDto>,
}

/// OAuth tokens persisted as one JSON secret in the keychain.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitlabOAuthTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    client_id: String,
}

impl std::fmt::Debug for GitlabOAuthTokens {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitlabOAuthTokens")
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expires_at", &self.expires_at)
            .field("client_id", &self.client_id)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsPageInput {
    pub search: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

fn account_for(host: &str, instance_id: &str) -> String {
    format!("{host}#{instance_id}")
}

fn oauth_account_for(host: &str, instance_id: &str) -> String {
    format!("{host}#{instance_id}#oauth")
}

/// Public Application ID of the BeeBranch OAuth application on gitlab.com
/// (scopes `api`, `read_user`, `read_repository`; public client).
///
/// Empty until the application is registered; fill it once created. A
/// self-managed instance needs its own application, which is why the device
/// flow is limited to gitlab.com.
const DEFAULT_GITLAB_OAUTH_CLIENT_ID: &str =
    "3923e844f259c3f93ebe3bdd2485f4cddb64b831490916da52f92b10b3c9138d";

/// Application ID used by the device flow. The environment wins so a fork or a
/// local build can point at its own application without rebuilding.
fn oauth_client_id() -> Option<String> {
    std::env::var("BEEBRANCH_GITLAB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("BEEBRANCH_GITLAB_CLIENT_ID").map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            (!DEFAULT_GITLAB_OAUTH_CLIENT_ID.trim().is_empty())
                .then(|| DEFAULT_GITLAB_OAUTH_CLIENT_ID.trim().to_owned())
        })
}

fn gitlab_cloud_only() -> AppError {
    AppError::new(
        "gitlab.device_flow_unavailable",
        ErrorCategory::Input,
        "La connexion OAuth intégrée ne couvre que gitlab.com.",
    )
    .with_remediation(
        "Pour une instance auto-hébergée, créez une application OAuth sur l'instance ou utilisez un Personal Access Token.",
    )
}

fn emit_auth_expired(app: &AppHandle, instance_id: &str) {
    let _ = app.emit(
        "gitlab://auth-expired",
        serde_json::json!({ "instanceId": instance_id }),
    );
}

fn cancel_oauth_refresh(state: &AppState) {
    if let Ok(mut slot) = state.gitlab_refresh_cancel.lock() {
        if let Some(flag) = slot.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

pub fn not_configured_public() -> AppError {
    not_configured()
}

fn not_configured() -> AppError {
    AppError::new(
        "gitlab.not_configured",
        ErrorCategory::Auth,
        "Aucune instance GitLab n'est configurée.",
    )
    .with_remediation("Renseignez l'URL de l'instance et un Personal Access Token.")
}

fn identity_user(identity: &IdentityRow) -> GitlabUser {
    GitlabUser {
        id: identity.user_id,
        username: identity.username.clone(),
        name: identity
            .name
            .clone()
            .unwrap_or_else(|| identity.username.clone()),
        avatar_url: identity.avatar_url.clone(),
    }
}

fn session(state: &AppState) -> Result<GitlabSessionDto, AppError> {
    let instance = state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .clone();
    let connected = state
        .gitlab
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    let discovered_source = state
        .gitlab_credential
        .lock()
        .ok()
        .and_then(|credential| credential.as_ref().map(|value| value.source_label()));
    let credential_source = if discovered_source.is_some() {
        discovered_source
    } else if connected {
        Some("keychain".to_owned())
    } else {
        None
    };

    let user = instance
        .as_ref()
        .and_then(|instance| state.store.identity(&instance.id).ok().flatten())
        .map(|identity| identity_user(&identity));

    Ok(GitlabSessionDto {
        connected,
        instance: instance.map(|instance| GitlabInstanceDto {
            id: instance.id,
            base_url: instance.base_url,
            display_name: instance.display_name,
        }),
        user,
        credential_source,
    })
}

/// Restore the last instance and its token from the keychain without any
/// network access (startup must stay offline). When the keychain holds no
/// token, reuse an HTTPS credential already configured for Git so a workstation
/// whose `git clone` works does not need to re-enter a GitLab token.
pub fn restore(state: &mut AppState) {
    if let Ok(instances) = state.store.list_instances_for("gitlab") {
        if let Some(instance) = instances
            .into_iter()
            .max_by_key(|instance| instance.created_at)
        {
            if let Ok(mut slot) = state.gitlab_instance.lock() {
                // Keep the instance visible even when the token is missing:
                // the UI can prefill the URL and ask for a new token instead
                // of looking disconnected.
                *slot = Some(instance.clone());
            }
            if let Some(client) = client_from_keychain(state, &instance) {
                if let Ok(mut slot) = state.gitlab.lock() {
                    *slot = Some(client);
                }
                return;
            }
            if let Some(client) = client_from_oauth(state, &instance) {
                if let Ok(mut slot) = state.gitlab.lock() {
                    *slot = Some(client);
                }
                return;
            }
        }
    }
    match detect_git_credentials(state) {
        Ok(true) => tracing::info!("GitLab session restored from the Git configuration"),
        Ok(false) => {}
        Err(error) => tracing::warn!(%error, "Git credential discovery failed"),
    }
}

fn client_from_keychain(
    state: &AppState,
    instance: &InstanceRow,
) -> Option<beebranch_gitlab::GitlabClient> {
    let Ok(url) = normalize_url(&instance.base_url) else {
        return None;
    };
    let account = account_for(&url.host, &instance.id);
    let Some(token) = state.secrets.get(&account).ok().flatten() else {
        tracing::info!("GitLab instance configured but no token in the secret store");
        return None;
    };
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    match GitlabClient::new(GitlabConfig {
        base_url: instance.base_url.clone(),
        token,
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    }) {
        Ok(client) => Some(
            client
                .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
                .with_cache_ttl(DEFAULT_CACHE_TTL),
        ),
        Err(error) => {
            tracing::warn!(%error, "GitLab client restore failed");
            None
        }
    }
}

/// Build a client from the OAuth tokens persisted for this instance. The token
/// may already be expired at startup; the status command schedules the refresh
/// then, keeping startup offline.
fn client_from_oauth(state: &AppState, instance: &InstanceRow) -> Option<GitlabClient> {
    let url = normalize_url(&instance.base_url).ok()?;
    let account = oauth_account_for(&url.host, &instance.id);
    let blob = state.secrets.get(&account).ok().flatten()?;
    let tokens: GitlabOAuthTokens = match serde_json::from_str(&blob) {
        Ok(tokens) => tokens,
        Err(error) => {
            tracing::warn!(%error, "GitLab OAuth secret is unreadable");
            return None;
        }
    };
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    match GitlabClient::new(GitlabConfig {
        base_url: instance.base_url.clone(),
        token: tokens.access_token,
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    }) {
        Ok(client) => Some(
            client
                .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
                .with_cache_ttl(DEFAULT_CACHE_TTL),
        ),
        Err(error) => {
            tracing::warn!(%error, "GitLab OAuth client restore failed");
            None
        }
    }
}

/// Look for an HTTPS credential already configured for Git and use it as the
/// active GitLab session. Only a credential for the configured instance host,
/// or a `glpat-` token when nothing is configured yet, is accepted: a random
/// GitHub credential is never mistaken for a GitLab connection.
///
/// Nothing is written to the store or the keychain; the token stays in memory.
pub fn detect_git_credentials(state: &AppState) -> Result<bool, AppError> {
    let connected = state
        .gitlab
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(true);
    if connected {
        return Ok(false);
    }
    let Some(runner) = state.runner.as_ref() else {
        return Ok(false);
    };
    let instance = state
        .gitlab_instance
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let instance_host = instance
        .as_ref()
        .and_then(|row| normalize_url(&row.base_url).ok())
        .map(|url| url.host);
    // A configured instance gives a host to ask the credential helper for
    // (`osxkeychain`, GCM, `gh auth git-credential`, …); without one only the
    // file-based sources can be scanned.
    let hosts: Vec<&str> = instance_host.iter().map(String::as_str).collect();
    let credentials =
        beebranch_git::credentials::discover_for_hosts(runner, state.paths.data_dir(), &hosts)?;
    if credentials.is_empty() {
        return Ok(false);
    }
    let Some(credential) = select_credential(credentials, instance_host.as_deref()) else {
        return Ok(false);
    };

    let normalized =
        normalize_url(&format!("https://{}", credential.host)).map_err(gitlab_error)?;
    let instance_row = match instance {
        Some(row) => row,
        None => InstanceRow {
            id: InstanceId::from_api_url(&normalized.api_url)
                .as_str()
                .to_owned(),
            provider: "gitlab".to_owned(),
            base_url: normalized.base_url.clone(),
            api_url: normalized.api_url.clone(),
            display_name: None,
            ca_bundle_id: None,
            created_at: beebranch_core::now_unix(),
        },
    };
    let ca_bundle_pem = instance_row
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    let client = GitlabClient::new(GitlabConfig {
        base_url: instance_row.base_url.clone(),
        token: credential.password.clone(),
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    })
    .map_err(gitlab_error)?
    .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
    .with_cache_ttl(DEFAULT_CACHE_TTL);

    tracing::info!(
        host = %credential.host,
        source = %credential.source_label(),
        "GitLab credentials found in the Git configuration"
    );
    *state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))? = Some(client);
    *state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))? = Some(instance_row);
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = Some(credential);
    Ok(true)
}

/// Pick the credential that may represent GitLab on this machine.
///
/// With a configured instance, only a credential for that host is accepted so
/// the instance is never silently switched. Without one, a GitLab-shaped token
/// (`glpat-` and friends) is required so a GitHub credential is not mistaken
/// for a GitLab connection.
fn select_credential(
    credentials: Vec<beebranch_git::credentials::DiscoveredCredential>,
    instance_host: Option<&str>,
) -> Option<beebranch_git::credentials::DiscoveredCredential> {
    match instance_host {
        Some(host) => credentials
            .into_iter()
            .find(|credential| credential.host.eq_ignore_ascii_case(host)),
        None => credentials
            .into_iter()
            .find(|credential| credential.looks_like_gitlab_token()),
    }
}

/// Persist OAuth tokens as one JSON secret. The access token is refreshed on
/// a schedule; GitLab rotates the refresh token on every use.
fn store_oauth_tokens(
    state: &AppState,
    host: &str,
    instance_id: &str,
    tokens: &GitlabOAuthTokens,
) -> Result<(), AppError> {
    let blob = serde_json::to_string(tokens)
        .map_err(|error| AppError::internal(format!("Sérialisation OAuth GitLab : {error}")))?;
    state
        .secrets
        .set(&oauth_account_for(host, instance_id), &blob)
        .map_err(store_error)
}

/// Exchange the refresh token and persist the rotated pair. Used both by the
/// background scheduler and by the first status after a restart, so the first
/// API call never races an expired access token.
async fn refresh_oauth_once(
    client_slot: &Arc<Mutex<Option<beebranch_gitlab::GitlabClient>>>,
    secrets: &Arc<dyn SecretStore>,
    account: &str,
    tokens: &GitlabOAuthTokens,
) -> Result<GitlabOAuthTokens, beebranch_gitlab::GitlabError> {
    let fresh = beebranch_gitlab::device_flow::refresh_access_token(
        GITLAB_CLOUD,
        &tokens.client_id,
        tokens.refresh_token.as_deref().unwrap_or_default(),
        DEVICE_FLOW_TIMEOUT,
    )
    .await?;
    let next = GitlabOAuthTokens {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expires_at: beebranch_core::now_unix().saturating_add(fresh.expires_in as i64),
        client_id: tokens.client_id.clone(),
    };
    if let Some(client) = client_slot.lock().ok().and_then(|slot| slot.clone()) {
        if let Err(error) = client.set_token(&next.access_token) {
            tracing::warn!(%error, "GitLab OAuth token rotation failed");
        }
    }
    if let Ok(blob) = serde_json::to_string(&next) {
        if let Err(error) = secrets.set(account, &blob) {
            tracing::warn!(%error, "GitLab OAuth secret update failed");
        }
    }
    Ok(next)
}

/// Drop an unusable OAuth session: no client, no stale secret, and an event so
/// the panel reloads its status instead of failing every API call one by one.
fn expire_oauth_session(
    app: &AppHandle,
    client_slot: &Arc<Mutex<Option<beebranch_gitlab::GitlabClient>>>,
    secrets: &Arc<dyn SecretStore>,
    account: &str,
    instance_id: &str,
) {
    if let Ok(mut slot) = client_slot.lock() {
        *slot = None;
    }
    let _ = secrets.delete(account);
    emit_auth_expired(app, instance_id);
}

/// Start the background refresher when the active session came from OAuth.
/// Called from `gitlab_status`, which has the `AppHandle` needed to report an
/// expired session.
async fn ensure_oauth_refresh(app: &AppHandle, state: &AppState) {
    let running = state
        .gitlab_refresh_cancel
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|flag| !flag.load(Ordering::Relaxed)))
        .unwrap_or(false);
    if running {
        return;
    }

    let Some(instance) = state
        .gitlab_instance
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
    else {
        return;
    };
    let Ok(url) = normalize_url(&instance.base_url) else {
        return;
    };
    let account = oauth_account_for(&url.host, &instance.id);
    let Some(blob) = state.secrets.get(&account).ok().flatten() else {
        return;
    };
    let Ok(mut tokens) = serde_json::from_str::<GitlabOAuthTokens>(&blob) else {
        tracing::warn!("GitLab OAuth secret is unreadable; refresh not scheduled");
        return;
    };

    // A token restored from the previous run may already be expired: refresh it
    // before the panel issues its first project query.
    if tokens.expires_at <= beebranch_core::now_unix() + 120 && tokens.refresh_token.is_some() {
        match refresh_oauth_once(&state.gitlab, &state.secrets, &account, &tokens).await {
            Ok(next) => tokens = next,
            Err(error) => {
                tracing::warn!(code = error.code(), "GitLab OAuth refresh failed");
                if beebranch_core::now_unix() >= tokens.expires_at - 10 {
                    expire_oauth_session(
                        app,
                        &state.gitlab,
                        &state.secrets,
                        &account,
                        &instance.id,
                    );
                    return;
                }
            }
        }
    }
    if tokens.expires_at <= beebranch_core::now_unix() + 5 && tokens.refresh_token.is_none() {
        expire_oauth_session(app, &state.gitlab, &state.secrets, &account, &instance.id);
        return;
    }

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = state.gitlab_refresh_cancel.lock() {
        *slot = Some(cancel.clone());
    }
    spawn_oauth_refresh(
        app.clone(),
        state.gitlab.clone(),
        state.secrets.clone(),
        instance.id,
        account,
        tokens,
        cancel,
    );
}

/// Refresh the access token shortly before it expires and update every client
/// clone in place. When the refresh token is missing or rejected, the session
/// is reported as expired instead of failing every API call one by one.
fn spawn_oauth_refresh(
    app: AppHandle,
    client_slot: Arc<Mutex<Option<beebranch_gitlab::GitlabClient>>>,
    secrets: Arc<dyn SecretStore>,
    instance_id: String,
    account: String,
    mut tokens: GitlabOAuthTokens,
    cancel: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let target = if tokens.refresh_token.is_some() {
                tokens.expires_at - 120
            } else {
                tokens.expires_at - 5
            };
            let wait = (target - beebranch_core::now_unix()).max(0) as u64;
            tokio::time::sleep(Duration::from_secs(wait)).await;
            if cancel.load(Ordering::Relaxed) {
                return;
            }

            if tokens.refresh_token.is_none() {
                expire_oauth_session(&app, &client_slot, &secrets, &account, &instance_id);
                return;
            }
            match refresh_oauth_once(&client_slot, &secrets, &account, &tokens).await {
                Ok(next) => tokens = next,
                Err(error) => {
                    tracing::warn!(code = error.code(), "GitLab OAuth refresh failed");
                    if beebranch_core::now_unix() >= tokens.expires_at - 10 {
                        expire_oauth_session(&app, &client_slot, &secrets, &account, &instance_id);
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        }
    });
}

fn pending_dto(interval: u64) -> GitlabDeviceFlowPollDto {
    GitlabDeviceFlowPollDto {
        status: "pending".to_owned(),
        interval: Some(interval),
        session: None,
    }
}

fn clear_device_flow(state: &AppState) {
    if let Ok(mut slot) = state.gitlab_device_flow.lock() {
        *slot = None;
    }
}

pub async fn device_flow_start(
    state: &AppState,
    input: GitlabDeviceFlowStartInput,
) -> Result<GitlabDeviceFlowStartDto, AppError> {
    let requested = input
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(GITLAB_CLOUD);
    let normalized = normalize_url(requested).map_err(gitlab_error)?;
    if normalized.web_url != GITLAB_CLOUD {
        return Err(gitlab_cloud_only());
    }
    let client_id = oauth_client_id().ok_or_else(|| {
        AppError::new(
            "gitlab.oauth_not_configured",
            ErrorCategory::Auth,
            "La connexion OAuth GitLab.com n'est pas configurée.",
        )
        .with_remediation(
            "Créez une application OAuth sur gitlab.com (scopes api, read_user, read_repository ; client public) puis renseignez BEEBRANCH_GITLAB_CLIENT_ID.",
        )
    })?;

    let code = beebranch_gitlab::device_flow::request_device_code(
        GITLAB_CLOUD,
        &client_id,
        beebranch_gitlab::device_flow::OAUTH_SCOPES,
        DEVICE_FLOW_TIMEOUT,
    )
    .await
    .map_err(gitlab_error)?;

    let pending = GitlabDeviceFlowPending {
        device_code: code.device_code,
        client_id,
        interval: code.interval,
        expires_at: beebranch_core::now_unix().saturating_add(code.expires_in as i64),
    };
    *state
        .gitlab_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitLab"))? = Some(pending);

    Ok(GitlabDeviceFlowStartDto {
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        expires_in: code.expires_in,
        interval: code.interval,
    })
}

pub async fn device_flow_poll(
    app: &AppHandle,
    state: &AppState,
) -> Result<GitlabDeviceFlowPollDto, AppError> {
    let pending = state
        .gitlab_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitLab"))?
        .clone()
        .ok_or_else(|| {
            AppError::new(
                "gitlab.device_flow_missing",
                ErrorCategory::Input,
                "Aucune connexion OAuth GitLab n'est en cours.",
            )
            .with_remediation("Relancez la connexion GitLab.")
        })?;

    if beebranch_core::now_unix() >= pending.expires_at {
        clear_device_flow(state);
        return Err(AppError::new(
            "gitlab.device_flow_expired",
            ErrorCategory::Auth,
            "Le code de connexion GitLab a expiré. Relancez la connexion.",
        ));
    }

    let outcome = match beebranch_gitlab::device_flow::poll_access_token(
        GITLAB_CLOUD,
        &pending.client_id,
        &pending.device_code,
        DEVICE_FLOW_TIMEOUT,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            clear_device_flow(state);
            return Err(gitlab_error(error));
        }
    };

    let tokens = match outcome {
        beebranch_gitlab::device_flow::PollOutcome::Pending => {
            return Ok(pending_dto(pending.interval));
        }
        beebranch_gitlab::device_flow::PollOutcome::SlowDown => {
            let interval = pending.interval.saturating_add(5).min(60);
            if let Ok(mut slot) = state.gitlab_device_flow.lock() {
                if let Some(stored) = slot.as_mut() {
                    stored.interval = interval;
                }
            }
            return Ok(pending_dto(interval));
        }
        beebranch_gitlab::device_flow::PollOutcome::Authorized(tokens) => tokens,
    };

    let normalized = normalize_url(GITLAB_CLOUD).map_err(gitlab_error)?;
    let client = match GitlabClient::new(GitlabConfig {
        base_url: normalized.base_url.clone(),
        token: tokens.access_token.clone(),
        ca_bundle_pem: None,
        timeout: REQUEST_TIMEOUT,
    }) {
        Ok(client) => client
            .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
            .with_cache_ttl(DEFAULT_CACHE_TTL),
        Err(error) => {
            clear_device_flow(state);
            return Err(gitlab_error(error));
        }
    };
    let user = match client.validate().await {
        Ok(user) => user,
        Err(error) => {
            clear_device_flow(state);
            return Err(gitlab_error(error));
        }
    };

    let now = beebranch_core::now_unix();
    let instance_id = InstanceId::from_api_url(&normalized.api_url);
    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: "gitlab".to_owned(),
        base_url: normalized.base_url.clone(),
        api_url: normalized.api_url.clone(),
        display_name: None,
        ca_bundle_id: None,
        created_at: now,
    };
    state
        .store
        .upsert_instance(&instance)
        .map_err(store_error)?;
    state
        .store
        .set_identity(&IdentityRow {
            instance_id: instance.id.clone(),
            user_id: user.id,
            username: user.username.clone(),
            name: Some(user.name.clone()),
            avatar_url: user.avatar_url.clone(),
            validated_at: now,
        })
        .map_err(store_error)?;
    let oauth = GitlabOAuthTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: now.saturating_add(tokens.expires_in as i64),
        client_id: pending.client_id.clone(),
    };
    store_oauth_tokens(state, &normalized.host, &instance.id, &oauth)?;
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    cancel_oauth_refresh(state);
    *state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))? = Some(client);
    *state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))? = Some(instance.clone());
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = None;
    clear_device_flow(state);

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = state.gitlab_refresh_cancel.lock() {
        *slot = Some(cancel.clone());
    }
    spawn_oauth_refresh(
        app.clone(),
        state.gitlab.clone(),
        state.secrets.clone(),
        instance.id.clone(),
        oauth_account_for(&normalized.host, &instance.id),
        oauth,
        cancel,
    );

    Ok(GitlabDeviceFlowPollDto {
        status: "connected".to_owned(),
        interval: None,
        session: Some(session(state)?),
    })
}

pub async fn configure(
    state: &AppState,
    input: GitlabConfigureInput,
) -> Result<GitlabSessionDto, AppError> {
    let token = input.token.trim().to_owned();
    if token.is_empty() {
        return Err(AppError::invalid_input("Le token GitLab est vide."));
    }
    let normalized = normalize_url(&input.base_url).map_err(gitlab_error)?;
    let instance_id = InstanceId::from_api_url(&normalized.api_url);

    let ca_pem = input
        .ca_pem
        .as_ref()
        .map(|pem| pem.trim().to_owned())
        .filter(|pem| !pem.is_empty())
        .map(String::into_bytes);

    let client = GitlabClient::new(GitlabConfig {
        base_url: normalized.base_url.clone(),
        token: token.clone(),
        ca_bundle_pem: ca_pem.clone(),
        timeout: REQUEST_TIMEOUT,
    })
    .map_err(gitlab_error)?
    .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
    .with_cache_ttl(DEFAULT_CACHE_TTL);

    let user = client.validate().await.map_err(gitlab_error)?;
    let now = beebranch_core::now_unix();
    let ca_bundle_id = ca_pem
        .as_ref()
        .map(|_| format!("ca_{}", instance_id.as_str()));
    if let (Some(id), Some(pem)) = (ca_bundle_id.as_ref(), ca_pem.as_ref()) {
        state.store.put_ca_bundle(id, pem).map_err(store_error)?;
    }

    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: "gitlab".to_owned(),
        base_url: normalized.base_url.clone(),
        api_url: normalized.api_url.clone(),
        display_name: input.display_name.clone(),
        ca_bundle_id,
        created_at: now,
    };
    state
        .store
        .upsert_instance(&instance)
        .map_err(store_error)?;
    state
        .store
        .set_identity(&IdentityRow {
            instance_id: instance.id.clone(),
            user_id: user.id,
            username: user.username.clone(),
            name: Some(user.name.clone()),
            avatar_url: user.avatar_url.clone(),
            validated_at: now,
        })
        .map_err(store_error)?;
    state
        .secrets
        .set(&account_for(&normalized.host, &instance.id), &token)
        .map_err(store_error)?;
    let _ = state
        .secrets
        .delete(&oauth_account_for(&normalized.host, &instance.id));
    cancel_oauth_refresh(state);
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    *state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))? = Some(client);
    *state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))? = Some(instance);
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = None;

    session(state)
}

/// Connect an instance with an HTTPS credential already managed by Git
/// (`git credential fill`), so a workstation that already clones over HTTPS
/// does not need a second Personal Access Token.
///
/// The token stays owned by Git: it is kept in memory for the session, never
/// copied to the keychain, SQLite or the frontend. The instance row and
/// identity are persisted so the next launch restores the session.
pub async fn connect_from_git(
    state: &AppState,
    input: GitlabConnectFromGitInput,
) -> Result<GitlabSessionDto, AppError> {
    let normalized = normalize_url(&input.base_url).map_err(gitlab_error)?;
    let runner = state.runner.as_ref().ok_or_else(|| {
        AppError::new(
            "git.unavailable",
            ErrorCategory::Internal,
            "Git est introuvable sur cette machine.",
        )
        .with_remediation("Installez Git puis redémarrez l'application.")
    })?;
    let credentials = beebranch_git::credentials::discover_for_hosts(
        runner,
        state.paths.data_dir(),
        &[normalized.host.as_str()],
    )?;
    let credential = credentials
        .into_iter()
        .find(|credential| credential.host.eq_ignore_ascii_case(&normalized.host))
        .ok_or_else(|| {
            AppError::new(
                "gitlab.no_git_credential",
                ErrorCategory::Auth,
                format!(
                    "Aucun identifiant Git n'est configuré pour {}.",
                    normalized.host
                ),
            )
            .with_remediation(
                "Authentifiez-vous une fois avec Git pour cet hôte, ou saisissez un Personal Access Token.",
            )
        })?;

    let instance_id = InstanceId::from_api_url(&normalized.api_url);
    let existing = state
        .store
        .instance(instance_id.as_str())
        .map_err(store_error)?;
    let ca_bundle_id = existing.as_ref().and_then(|row| row.ca_bundle_id.clone());
    let ca_bundle_pem = ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    let display_name = input
        .display_name
        .clone()
        .or_else(|| existing.and_then(|row| row.display_name));
    let client = GitlabClient::new(GitlabConfig {
        base_url: normalized.base_url.clone(),
        token: credential.password.clone(),
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    })
    .map_err(gitlab_error)?
    .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
    .with_cache_ttl(DEFAULT_CACHE_TTL);
    let user = client.validate().await.map_err(|error| {
        let mapped = gitlab_error(error);
        if mapped.code == "auth.failed" {
            mapped.with_remediation(format!(
                "Le jeton trouvé via {} a été refusé. Mettez à jour vos identifiants Git ou saisissez un Personal Access Token.",
                credential.source_label()
            ))
        } else {
            mapped
        }
    })?;

    let now = beebranch_core::now_unix();
    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: "gitlab".to_owned(),
        base_url: normalized.base_url.clone(),
        api_url: normalized.api_url.clone(),
        display_name,
        ca_bundle_id,
        created_at: now,
    };
    state
        .store
        .upsert_instance(&instance)
        .map_err(store_error)?;
    state
        .store
        .set_identity(&IdentityRow {
            instance_id: instance.id.clone(),
            user_id: user.id,
            username: user.username.clone(),
            name: Some(user.name.clone()),
            avatar_url: user.avatar_url.clone(),
            validated_at: now,
        })
        .map_err(store_error)?;
    let _ = state
        .secrets
        .delete(&oauth_account_for(&normalized.host, &instance.id));
    cancel_oauth_refresh(state);
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    *state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))? = Some(client);
    *state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))? = Some(instance);
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = Some(credential);

    session(state)
}

#[tauri::command]
pub async fn gitlab_configure(
    state: State<'_, AppState>,
    input: GitlabConfigureInput,
) -> Result<GitlabSessionDto, AppError> {
    configure(&state, input).await
}

#[tauri::command]
pub async fn gitlab_connect_from_git(
    state: State<'_, AppState>,
    input: GitlabConnectFromGitInput,
) -> Result<GitlabSessionDto, AppError> {
    connect_from_git(&state, input).await
}

#[tauri::command]
pub async fn gitlab_device_flow_start(
    state: State<'_, AppState>,
    input: GitlabDeviceFlowStartInput,
) -> Result<GitlabDeviceFlowStartDto, AppError> {
    device_flow_start(&state, input).await
}

#[tauri::command]
pub async fn gitlab_device_flow_poll(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitlabDeviceFlowPollDto, AppError> {
    device_flow_poll(&app, &state).await
}

#[tauri::command]
pub fn gitlab_device_flow_cancel(state: State<'_, AppState>) -> Result<bool, AppError> {
    let mut slot = state
        .gitlab_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitLab"))?;
    Ok(slot.take().is_some())
}

#[tauri::command]
pub async fn gitlab_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitlabSessionDto, AppError> {
    let connected = state
        .gitlab
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    if !connected {
        // Cheap, offline check: a token added to the Git configuration while
        // the app is running is picked up without a restart.
        if let Err(error) = detect_git_credentials(&state) {
            tracing::warn!(%error, "Git credential discovery failed");
        }
    }
    if state
        .gitlab
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false)
    {
        // OAuth access tokens expire after two hours; keep the shared client
        // token fresh in the background.
        ensure_oauth_refresh(&app, &state).await;
    }
    session(&state)
}

#[tauri::command]
pub async fn gitlab_validate(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitlabUser, AppError> {
    let client = state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))?
        .clone()
        .ok_or_else(not_configured)?;
    let instance_id = state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .as_ref()
        .map(|instance| instance.id.clone());

    match client.validate().await {
        Ok(user) => {
            if let Some(instance_id) = instance_id {
                let _ = state.store.set_identity(&IdentityRow {
                    instance_id,
                    user_id: user.id,
                    username: user.username.clone(),
                    name: Some(user.name.clone()),
                    avatar_url: user.avatar_url.clone(),
                    validated_at: beebranch_core::now_unix(),
                });
            }
            Ok(user)
        }
        Err(error) => {
            if error.code() == "auth.failed" {
                if let Some(instance_id) = instance_id {
                    let _ = app.emit(
                        "gitlab://auth-expired",
                        serde_json::json!({ "instanceId": instance_id }),
                    );
                }
            }
            Err(gitlab_error(error))
        }
    }
}

pub async fn projects_page(
    state: &AppState,
    input: ProjectsPageInput,
    on_auth_expired: impl FnOnce(&str),
) -> Result<Paged<GitlabProject>, AppError> {
    let client = state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))?
        .clone()
        .ok_or_else(not_configured)?;
    let instance_id = state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)?;

    let mut query = ProjectsQuery::new().with_page(input.page.unwrap_or(1));
    if let Some(per_page) = input.per_page {
        query = query.with_per_page(per_page);
    }
    if let Some(search) = input.search.as_ref().map(|value| value.trim()) {
        if !search.is_empty() {
            query = query.with_search(search);
        }
    }

    let page = match client.projects(query).await {
        Ok(page) => page,
        Err(error) => {
            if error.code() == "auth.failed" {
                on_auth_expired(&instance_id);
            }
            return Err(gitlab_error(error));
        }
    };
    let now = beebranch_core::now_unix();
    let rows: Vec<ProjectRow> = page
        .items
        .iter()
        .map(|project| ProjectRow {
            instance_id: instance_id.clone(),
            project_id: project.id,
            path_with_namespace: project.path_with_namespace.clone(),
            name: project.name.clone(),
            web_url: project.web_url.clone(),
            ssh_url: Some(project.ssh_url_to_repo.clone()),
            http_url: Some(project.http_url_to_repo.clone()),
            default_branch: project.default_branch.clone(),
            last_activity_at: project.last_activity_at.clone(),
            fetched_at: now,
            etag: None,
        })
        .collect();
    if let Err(error) = state.store.upsert_projects(&rows) {
        tracing::warn!(%error, "GitLab project cache write failed");
    }
    Ok(page)
}

#[tauri::command]
pub async fn gitlab_projects_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ProjectsPageInput,
) -> Result<Paged<GitlabProject>, AppError> {
    projects_page(&state, input, |instance_id| {
        let _ = app.emit(
            "gitlab://auth-expired",
            serde_json::json!({ "instanceId": instance_id }),
        );
    })
    .await
}

#[tauri::command]
pub fn gitlab_disconnect(state: State<'_, AppState>) -> Result<bool, AppError> {
    let instance = state
        .gitlab_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitLab"))?
        .take();

    cancel_oauth_refresh(&state);
    clear_device_flow(&state);
    if let Some(instance) = instance {
        if let Ok(url) = normalize_url(&instance.base_url) {
            let _ = state.secrets.delete(&account_for(&url.host, &instance.id));
            let _ = state
                .secrets
                .delete(&oauth_account_for(&url.host, &instance.id));
        }
        if let Some(ca_bundle_id) = instance.ca_bundle_id.as_deref() {
            let _ = state.store.delete_ca_bundle(ca_bundle_id);
        }
        state
            .store
            .delete_instance(&instance.id)
            .map_err(store_error)?;
        state
            .store
            .delete_cache_prefix(&instance.api_url)
            .map_err(store_error)?;
    }
    *state
        .gitlab
        .lock()
        .map_err(|_| AppError::internal("verrou client GitLab"))? = None;
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = None;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use beebranch_git::credentials::{CredentialOrigin, DiscoveredCredential};

    use super::{account_for, oauth_account_for, select_credential, GitlabOAuthTokens};

    fn credential(host: &str, password: &str) -> DiscoveredCredential {
        DiscoveredCredential {
            host: host.to_owned(),
            username: "oauth2".to_owned(),
            password: password.to_owned(),
            origin: CredentialOrigin::GitConfigUrl,
        }
    }

    #[test]
    fn oauth_tokens_roundtrip_and_never_leak_in_debug() {
        let tokens = GitlabOAuthTokens {
            access_token: "glpat-access-secret".into(),
            refresh_token: Some("refresh-secret".into()),
            expires_at: 1_700_000_000,
            client_id: "app-id".into(),
        };
        let blob = serde_json::to_string(&tokens).expect("serialize");
        let parsed: GitlabOAuthTokens = serde_json::from_str(&blob).expect("parse");
        assert_eq!(parsed.access_token, "glpat-access-secret");
        assert_eq!(parsed.refresh_token.as_deref(), Some("refresh-secret"));
        assert_eq!(parsed.expires_at, 1_700_000_000);

        let debug = format!("{tokens:?}");
        assert!(!debug.contains("glpat-access-secret"));
        assert!(!debug.contains("refresh-secret"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn oauth_secret_uses_a_distinct_account() {
        assert_ne!(
            oauth_account_for("gitlab.com", "gl_1"),
            account_for("gitlab.com", "gl_1")
        );
    }

    #[test]
    fn configured_instance_keeps_its_own_host() {
        let credentials = vec![
            credential("gitlab.example.test", "glpat-instance"),
            credential("github.com", "ghp_unrelated"),
        ];
        let selected = select_credential(credentials, Some("gitlab.example.test"))
            .expect("credential for the instance host");
        assert_eq!(selected.password, "glpat-instance");
    }

    #[test]
    fn no_instance_requires_a_gitlab_shaped_token() {
        let selected = select_credential(
            vec![
                credential("github.com", "ghp_unrelated"),
                credential("gitlab.example.test", "glpat-first"),
            ],
            None,
        )
        .expect("glpat token");
        assert_eq!(selected.password, "glpat-first");

        assert!(select_credential(vec![credential("github.com", "ghp_unrelated")], None).is_none());
    }

    #[test]
    fn another_host_is_never_used_for_a_configured_instance() {
        let credentials = vec![
            credential("gitlab.other.test", "glpat-other"),
            credential("github.com", "ghp_unrelated"),
        ];
        assert!(select_credential(credentials, Some("gitlab.example.test")).is_none());
    }

    /// A helper that keeps its secret outside plain files (`osxkeychain`,
    /// GCM) must restore the session without any PAT in the keychain.
    #[cfg(unix)]
    #[test]
    fn detects_a_helper_credential_for_the_configured_host() {
        use beebranch_git::{CommandSpec, GitSubcommand};
        use beebranch_store::{InstanceRow, Store};

        use crate::state::test_state;

        let directory = tempfile::tempdir().expect("tempdir");
        let state = test_state(
            directory.path().to_path_buf(),
            Store::open_in_memory().expect("store"),
        );
        let runner = state.runner.as_ref().expect("git");
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

        *state.gitlab_instance.lock().expect("instance lock") = Some(InstanceRow {
            id: "gl_helper".into(),
            provider: "gitlab".into(),
            base_url: "https://gitlab.example.test".into(),
            api_url: "https://gitlab.example.test/api/v4".into(),
            display_name: None,
            ca_bundle_id: None,
            created_at: 1,
        });

        assert!(super::detect_git_credentials(&state).expect("detect"));
        let credential = state
            .gitlab_credential
            .lock()
            .expect("credential lock")
            .clone()
            .expect("credential");
        assert_eq!(credential.password, "glpat-helper");
        assert_eq!(credential.origin, CredentialOrigin::Helper);
        assert!(state.gitlab.lock().expect("client lock").is_some());
    }
}
