//! GitHub connection, authentication and repository discovery.
//!
//! Mirrors the GitLab command surface while keeping a separate keychain
//! service (`beebranch.github`) and provider-scoped instance rows.

use std::sync::Arc;
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory, InstanceId};
use beebranch_github::{
    normalize_url, GithubClient, GithubConfig, GithubProject, GithubUser, Paged, RepositoriesQuery,
    DEFAULT_CACHE_TTL,
};
use beebranch_store::{IdentityRow, InstanceRow, ProjectRow};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{github_error, store_error};
use crate::forge_cache::SqliteCache;
use crate::state::{AppState, GithubDeviceFlowPending};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Device flow POSTs are short; polling happens from the UI, never in a loop.
const DEVICE_FLOW_TIMEOUT: Duration = Duration::from_secs(20);
const GITHUB_CLOUD: &str = "https://github.com";
const PROVIDER: &str = "github";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstanceDto {
    pub id: String,
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSessionDto {
    pub connected: bool,
    pub instance: Option<GithubInstanceDto>,
    pub user: Option<GithubUser>,
    /// `keychain` for a token entered in the app, otherwise the origin of the
    /// credential discovered in the Git configuration.
    pub credential_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConfigureInput {
    pub base_url: String,
    pub token: String,
    pub ca_pem: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectFromGitInput {
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceFlowStartInput {
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceFlowStartDto {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceFlowPollDto {
    /// `pending` or `connected`.
    pub status: String,
    pub interval: Option<u64>,
    pub session: Option<GithubSessionDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProjectsPageInput {
    pub search: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

fn account_for(host: &str, instance_id: &str) -> String {
    format!("{host}#{instance_id}")
}

pub fn not_configured_public() -> AppError {
    not_configured()
}

fn not_configured() -> AppError {
    AppError::new(
        "github.not_configured",
        ErrorCategory::Auth,
        "Aucune instance GitHub n'est configurée.",
    )
    .with_remediation("Renseignez l'URL de l'instance et un Personal Access Token.")
}

fn identity_user(identity: &IdentityRow) -> GithubUser {
    GithubUser {
        id: identity.user_id,
        username: identity.username.clone(),
        name: identity
            .name
            .clone()
            .unwrap_or_else(|| identity.username.clone()),
        avatar_url: identity.avatar_url.clone(),
    }
}

fn session(state: &AppState) -> Result<GithubSessionDto, AppError> {
    let instance = state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))?
        .clone();
    let connected = state
        .github
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    let discovered_source = state
        .github_credential
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

    Ok(GithubSessionDto {
        connected,
        instance: instance.map(|instance| GithubInstanceDto {
            id: instance.id,
            base_url: instance.base_url,
            display_name: instance.display_name,
        }),
        user,
        credential_source,
    })
}

/// Restore the last GitHub instance and its token without any network access.
/// When the keychain holds no token, reuse an HTTPS credential already
/// configured for Git whose host matches the instance (or whose token is
/// GitHub-shaped when no instance is configured).
pub fn restore(state: &mut AppState) {
    if let Ok(instances) = state.store.list_instances_for(PROVIDER) {
        if let Some(instance) = instances
            .into_iter()
            .max_by_key(|instance| instance.created_at)
        {
            if let Ok(mut slot) = state.github_instance.lock() {
                *slot = Some(instance.clone());
            }
            if let Some(client) = client_from_keychain(state, &instance) {
                if let Ok(mut slot) = state.github.lock() {
                    *slot = Some(client);
                }
                return;
            }
        }
    }
    match detect_git_credentials(state) {
        Ok(true) => tracing::info!("GitHub session restored from the Git configuration"),
        Ok(false) => {}
        Err(error) => tracing::warn!(%error, "GitHub credential discovery failed"),
    }
}

fn build_client(
    state: &AppState,
    base_url: &str,
    token: String,
    ca_bundle_pem: Option<Vec<u8>>,
) -> Result<GithubClient, beebranch_github::GithubError> {
    GithubClient::new(GithubConfig {
        base_url: base_url.to_owned(),
        token,
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    })
    .map(|client| {
        client
            .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
            .with_cache_ttl(DEFAULT_CACHE_TTL)
    })
}

fn client_from_keychain(state: &AppState, instance: &InstanceRow) -> Option<GithubClient> {
    let Ok(url) = normalize_url(&instance.base_url) else {
        return None;
    };
    let account = account_for(&url.host, &instance.id);
    let Some(token) = state.github_secrets.get(&account).ok().flatten() else {
        tracing::info!("GitHub instance configured but no token in the secret store");
        return None;
    };
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    match build_client(state, &instance.base_url, token, ca_bundle_pem) {
        Ok(client) => Some(client),
        Err(error) => {
            tracing::warn!(%error, "GitHub client restore failed");
            None
        }
    }
}

/// Look for an HTTPS credential already configured for Git and use it as the
/// active GitHub session. Only a credential for the configured instance host,
/// or a GitHub-shaped token when nothing is configured yet, is accepted.
pub fn detect_git_credentials(state: &AppState) -> Result<bool, AppError> {
    let connected = state
        .github
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
        .github_instance
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
        normalize_url(&format!("https://{}", credential.host)).map_err(github_error)?;
    let instance_row = match instance {
        Some(row) => row,
        None => InstanceRow {
            id: InstanceId::from_github_api_url(&normalized.api_url)
                .as_str()
                .to_owned(),
            provider: PROVIDER.to_owned(),
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
    let client = build_client(
        state,
        &instance_row.base_url,
        credential.password.clone(),
        ca_bundle_pem,
    )
    .map_err(github_error)?;

    tracing::info!(
        host = %credential.host,
        source = %credential.source_label(),
        "GitHub credentials found in the Git configuration"
    );
    *state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))? = Some(client);
    *state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))? = Some(instance_row);
    *state
        .github_credential
        .lock()
        .map_err(|_| AppError::internal("verrous credentials GitHub"))? = Some(credential);
    Ok(true)
}

/// Pick the credential that may represent GitHub on this machine.
///
/// With a configured instance, only a credential for that host is accepted so
/// the instance is never silently switched. Without one, a GitHub-shaped token
/// is required so a GitLab token is not mistaken for a GitHub connection.
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
            .find(|credential| credential.looks_like_github_token()),
    }
}

pub async fn configure(
    state: &AppState,
    input: GithubConfigureInput,
) -> Result<GithubSessionDto, AppError> {
    let token = input.token.trim().to_owned();
    if token.is_empty() {
        return Err(AppError::invalid_input("Le token GitHub est vide."));
    }
    let normalized = normalize_url(&input.base_url).map_err(github_error)?;
    let instance_id = InstanceId::from_github_api_url(&normalized.api_url);

    let ca_pem = input
        .ca_pem
        .as_ref()
        .map(|pem| pem.trim().to_owned())
        .filter(|pem| !pem.is_empty())
        .map(String::into_bytes);

    let client = build_client(state, &normalized.base_url, token.clone(), ca_pem.clone())
        .map_err(github_error)?;

    let user = client.validate().await.map_err(github_error)?;
    let now = beebranch_core::now_unix();
    let ca_bundle_id = ca_pem
        .as_ref()
        .map(|_| format!("ca_{}", instance_id.as_str()));
    if let (Some(id), Some(pem)) = (ca_bundle_id.as_ref(), ca_pem.as_ref()) {
        state.store.put_ca_bundle(id, pem).map_err(store_error)?;
    }

    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: PROVIDER.to_owned(),
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
        .github_secrets
        .set(&account_for(&normalized.host, &instance.id), &token)
        .map_err(store_error)?;
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    *state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))? = Some(client);
    *state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))? = Some(instance);
    *state
        .github_credential
        .lock()
        .map_err(|_| AppError::internal("verrous credentials GitHub"))? = None;

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
    input: GithubConnectFromGitInput,
) -> Result<GithubSessionDto, AppError> {
    let normalized = normalize_url(&input.base_url).map_err(github_error)?;
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
                "github.no_git_credential",
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

    let instance_id = InstanceId::from_github_api_url(&normalized.api_url);
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
    let client = build_client(
        state,
        &normalized.base_url,
        credential.password.clone(),
        ca_bundle_pem,
    )
    .map_err(github_error)?;
    let user = client.validate().await.map_err(|error| {
        let mapped = github_error(error);
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
        provider: PROVIDER.to_owned(),
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
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    *state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))? = Some(client);
    *state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))? = Some(instance);
    *state
        .github_credential
        .lock()
        .map_err(|_| AppError::internal("verrous credentials GitHub"))? = Some(credential);

    session(state)
}

#[tauri::command]
pub async fn github_configure(
    state: State<'_, AppState>,
    input: GithubConfigureInput,
) -> Result<GithubSessionDto, AppError> {
    configure(&state, input).await
}

#[tauri::command]
pub async fn github_connect_from_git(
    state: State<'_, AppState>,
    input: GithubConnectFromGitInput,
) -> Result<GithubSessionDto, AppError> {
    connect_from_git(&state, input).await
}

/// Public client id of the BeeBranch OAuth App (device flow enabled).
///
/// An OAuth client id is public by design; there is no client secret. It is
/// embedded so every build works out of the box. `BEEBRANCH_GITHUB_CLIENT_ID`
/// (runtime or build-time) overrides it for forks and local experiments.
const DEFAULT_OAUTH_CLIENT_ID: &str = "Ov23li9nKegYqvhQs8SR";

fn oauth_client_id() -> String {
    std::env::var("BEEBRANCH_GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("BEEBRANCH_GITHUB_CLIENT_ID").map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.to_owned())
}

fn device_flow_unavailable() -> AppError {
    AppError::new(
        "github.device_flow_unavailable",
        ErrorCategory::Input,
        "La connexion OAuth intégrée ne couvre que github.com.",
    )
    .with_remediation(
        "Pour GitHub Enterprise Server, créez une OAuth App sur votre instance ou utilisez un Personal Access Token.",
    )
}

pub async fn device_flow_start(
    state: &AppState,
    input: GithubDeviceFlowStartInput,
) -> Result<GithubDeviceFlowStartDto, AppError> {
    let requested = input
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(GITHUB_CLOUD);
    let normalized = normalize_url(requested).map_err(github_error)?;
    if normalized.web_url != GITHUB_CLOUD {
        return Err(device_flow_unavailable());
    }
    let client_id = oauth_client_id();

    let code = beebranch_github::device_flow::request_device_code(
        GITHUB_CLOUD,
        &client_id,
        beebranch_github::device_flow::OAUTH_SCOPES,
        DEVICE_FLOW_TIMEOUT,
    )
    .await
    .map_err(github_error)?;

    let pending = GithubDeviceFlowPending {
        device_code: code.device_code,
        client_id,
        interval: code.interval,
        expires_at: beebranch_core::now_unix().saturating_add(code.expires_in as i64),
    };
    *state
        .github_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitHub"))? = Some(pending);

    Ok(GithubDeviceFlowStartDto {
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        expires_in: code.expires_in,
        interval: code.interval,
    })
}

fn pending_dto(interval: u64) -> GithubDeviceFlowPollDto {
    GithubDeviceFlowPollDto {
        status: "pending".to_owned(),
        interval: Some(interval),
        session: None,
    }
}

fn clear_device_flow(state: &AppState) {
    if let Ok(mut slot) = state.github_device_flow.lock() {
        *slot = None;
    }
}

pub async fn device_flow_poll(state: &AppState) -> Result<GithubDeviceFlowPollDto, AppError> {
    let pending = state
        .github_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitHub"))?
        .clone()
        .ok_or_else(|| {
            AppError::new(
                "github.device_flow_missing",
                ErrorCategory::Input,
                "Aucune connexion OAuth GitHub n'est en cours.",
            )
            .with_remediation("Relancez la connexion GitHub.")
        })?;

    if beebranch_core::now_unix() >= pending.expires_at {
        clear_device_flow(state);
        return Err(AppError::new(
            "github.device_flow_expired",
            ErrorCategory::Auth,
            "Le code de connexion GitHub a expiré. Relancez la connexion.",
        ));
    }

    let outcome = match beebranch_github::device_flow::poll_access_token(
        GITHUB_CLOUD,
        &pending.client_id,
        &pending.device_code,
        DEVICE_FLOW_TIMEOUT,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            clear_device_flow(state);
            return Err(github_error(error));
        }
    };

    let (token, scope) = match outcome {
        beebranch_github::device_flow::PollOutcome::Pending => {
            return Ok(pending_dto(pending.interval));
        }
        beebranch_github::device_flow::PollOutcome::SlowDown => {
            let interval = pending.interval.saturating_add(5).min(60);
            if let Ok(mut slot) = state.github_device_flow.lock() {
                if let Some(stored) = slot.as_mut() {
                    stored.interval = interval;
                }
            }
            return Ok(pending_dto(interval));
        }
        beebranch_github::device_flow::PollOutcome::Authorized { token, scope } => (token, scope),
    };

    let normalized = normalize_url(GITHUB_CLOUD).map_err(github_error)?;
    let client = match build_client(state, &normalized.base_url, token.clone(), None) {
        Ok(client) => client,
        Err(error) => {
            clear_device_flow(state);
            return Err(github_error(error));
        }
    };
    let user = match client.validate().await {
        Ok(user) => user,
        Err(error) => {
            clear_device_flow(state);
            return Err(github_error(error));
        }
    };

    let now = beebranch_core::now_unix();
    let instance_id = InstanceId::from_github_api_url(&normalized.api_url);
    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: PROVIDER.to_owned(),
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
    state
        .github_secrets
        .set(&account_for(&normalized.host, &instance.id), &token)
        .map_err(store_error)?;
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;

    *state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))? = Some(client);
    *state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))? = Some(instance);
    *state
        .github_credential
        .lock()
        .map_err(|_| AppError::internal("verrous credentials GitHub"))? = None;
    clear_device_flow(state);

    tracing::info!(
        granted = scope.as_deref().unwrap_or(""),
        "GitHub OAuth device flow completed"
    );
    Ok(GithubDeviceFlowPollDto {
        status: "connected".to_owned(),
        interval: None,
        session: Some(session(state)?),
    })
}

#[tauri::command]
pub async fn github_device_flow_start(
    state: State<'_, AppState>,
    input: GithubDeviceFlowStartInput,
) -> Result<GithubDeviceFlowStartDto, AppError> {
    device_flow_start(&state, input).await
}

#[tauri::command]
pub async fn github_device_flow_poll(
    state: State<'_, AppState>,
) -> Result<GithubDeviceFlowPollDto, AppError> {
    device_flow_poll(&state).await
}

#[tauri::command]
pub fn github_device_flow_cancel(state: State<'_, AppState>) -> Result<bool, AppError> {
    let mut slot = state
        .github_device_flow
        .lock()
        .map_err(|_| AppError::internal("verrou device flow GitHub"))?;
    Ok(slot.take().is_some())
}

#[tauri::command]
pub async fn github_status(state: State<'_, AppState>) -> Result<GithubSessionDto, AppError> {
    let connected = state
        .github
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    if !connected {
        if let Err(error) = detect_git_credentials(&state) {
            tracing::warn!(%error, "GitHub credential discovery failed");
        }
    }
    session(&state)
}

#[tauri::command]
pub async fn github_validate(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GithubUser, AppError> {
    let client = state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))?
        .clone()
        .ok_or_else(not_configured)?;
    let instance_id = state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))?
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
                        "github://auth-expired",
                        serde_json::json!({ "instanceId": instance_id }),
                    );
                }
            }
            Err(github_error(error))
        }
    }
}

pub async fn projects_page(
    state: &AppState,
    input: GithubProjectsPageInput,
    on_auth_expired: impl FnOnce(&str),
) -> Result<Paged<GithubProject>, AppError> {
    let client = state
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))?
        .clone()
        .ok_or_else(not_configured)?;
    let instance_id = state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)?;

    let mut query = RepositoriesQuery::new().with_page(input.page.unwrap_or(1));
    if let Some(per_page) = input.per_page {
        query = query.with_per_page(per_page);
    }
    if let Some(search) = input.search.as_ref().map(|value| value.trim()) {
        if !search.is_empty() {
            query = query.with_search(search);
        }
    }

    let page = match client.repositories(query).await {
        Ok(page) => page,
        Err(error) => {
            if error.code() == "auth.failed" {
                on_auth_expired(&instance_id);
            }
            return Err(github_error(error));
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
            ssh_url: project.ssh_url_to_repo.clone(),
            http_url: project.http_url_to_repo.clone(),
            default_branch: project.default_branch.clone(),
            last_activity_at: project.last_activity_at.clone(),
            fetched_at: now,
            etag: None,
        })
        .collect();
    if let Err(error) = state.store.upsert_projects(&rows) {
        tracing::warn!(%error, "GitHub repository cache write failed");
    }
    Ok(page)
}

#[tauri::command]
pub async fn github_projects_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GithubProjectsPageInput,
) -> Result<Paged<GithubProject>, AppError> {
    projects_page(&state, input, |instance_id| {
        let _ = app.emit(
            "github://auth-expired",
            serde_json::json!({ "instanceId": instance_id }),
        );
    })
    .await
}

#[tauri::command]
pub fn github_disconnect(state: State<'_, AppState>) -> Result<bool, AppError> {
    let instance = state
        .github_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance GitHub"))?
        .take();

    if let Some(instance) = instance {
        if let Ok(url) = normalize_url(&instance.base_url) {
            let _ = state
                .github_secrets
                .delete(&account_for(&url.host, &instance.id));
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
        .github
        .lock()
        .map_err(|_| AppError::internal("verrou client GitHub"))? = None;
    *state
        .github_credential
        .lock()
        .map_err(|_| AppError::internal("verrous credentials GitHub"))? = None;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use beebranch_git::credentials::{CredentialOrigin, DiscoveredCredential};

    use super::select_credential;

    fn credential(host: &str, password: &str) -> DiscoveredCredential {
        DiscoveredCredential {
            host: host.to_owned(),
            username: "x-access-token".to_owned(),
            password: password.to_owned(),
            origin: CredentialOrigin::GitConfigUrl,
        }
    }

    #[test]
    fn configured_instance_keeps_its_own_host() {
        let credentials = vec![
            credential("gitlab.example.test", "glpat-instance"),
            credential("github.example.test", "ghp_instance"),
        ];
        let selected = select_credential(credentials, Some("github.example.test"))
            .expect("credential for the instance host");
        assert_eq!(selected.password, "ghp_instance");
    }

    #[test]
    fn no_instance_requires_a_github_shaped_token() {
        let selected = select_credential(
            vec![
                credential("gitlab.example.test", "glpat-unrelated"),
                credential("github.com", "ghp_first"),
            ],
            None,
        )
        .expect("ghp token");
        assert_eq!(selected.password, "ghp_first");

        assert!(select_credential(
            vec![credential("gitlab.example.test", "glpat-unrelated")],
            None
        )
        .is_none());
    }

    #[test]
    fn another_host_is_never_used_for_a_configured_instance() {
        let credentials = vec![
            credential("github.other.test", "ghp_other"),
            credential("gitlab.example.test", "glpat-unrelated"),
        ];
        assert!(select_credential(credentials, Some("github.example.test")).is_none());
    }
}
