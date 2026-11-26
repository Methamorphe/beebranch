//! Azure DevOps connection.
//!
//! A Personal Access Token is stored in its own keychain service
//! (`beebranch.azure`). No application is registered with Microsoft. An HTTPS
//! credential already known to Git can be reused without copying it.

use std::sync::Arc;
use std::time::Duration;

use beebranch_azure::{
    normalize_url, AzureClient, AzureConfig, AzureProject, AzureUser, Paged, RepositoriesQuery,
    DEFAULT_CACHE_TTL,
};
use beebranch_core::{AppError, ErrorCategory, InstanceId};
use beebranch_store::{IdentityRow, InstanceRow, ProjectRow};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{azure_error, store_error};
use crate::forge_cache::SqliteCache;
use crate::state::AppState;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER: &str = "azure";
/// `forge_external_ids.project_id` reserved for the authenticated user GUID.
const USER_KEY: u64 = 0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureInstanceDto {
    pub id: String,
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureSessionDto {
    pub connected: bool,
    pub instance: Option<AzureInstanceDto>,
    pub user: Option<AzureUser>,
    pub credential_source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureConfigureInput {
    pub base_url: String,
    pub token: String,
    pub ca_pem: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureConnectFromGitInput {
    pub base_url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureProjectsPageInput {
    pub search: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

fn account_for(host: &str, instance_id: &str) -> String {
    format!("{host}#{instance_id}")
}

pub(super) fn stored_access_token(
    secrets: &dyn beebranch_store::SecretStore,
    host: &str,
    instance_id: &str,
) -> Option<String> {
    secrets.get(&account_for(host, instance_id)).ok().flatten()
}

pub fn not_configured() -> AppError {
    AppError::new(
        "azure.not_configured",
        ErrorCategory::Auth,
        "Aucune organisation Azure DevOps n'est configurée.",
    )
    .with_remediation("Renseignez l'URL de l'organisation et un jeton d'accès personnel.")
}

fn identity_user(identity: &IdentityRow, guid: Option<String>) -> AzureUser {
    AzureUser {
        id: identity.user_id,
        username: identity.username.clone(),
        name: identity
            .name
            .clone()
            .unwrap_or_else(|| identity.username.clone()),
        avatar_url: identity.avatar_url.clone(),
        guid: guid.unwrap_or_default(),
    }
}

pub(crate) fn client(state: &AppState) -> Result<AzureClient, AppError> {
    state
        .azure
        .lock()
        .map_err(|_| AppError::internal("verrou client Azure DevOps"))?
        .clone()
        .ok_or_else(not_configured)
}

pub(crate) fn instance_id(state: &AppState) -> Result<String, AppError> {
    state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))?
        .as_ref()
        .map(|instance| instance.id.clone())
        .ok_or_else(not_configured)
}

pub(crate) fn auth_event(app: &AppHandle, error: &beebranch_azure::AzureError, instance: &str) {
    if error.code() == "auth.failed" {
        let _ = app.emit(
            "azure://auth-expired",
            serde_json::json!({ "instanceId": instance }),
        );
    }
}

fn session(state: &AppState) -> Result<AzureSessionDto, AppError> {
    let instance = state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))?
        .clone();
    let connected = state
        .azure
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    let discovered = state
        .azure_credential
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|value| value.source_label()));
    let credential_source = if discovered.is_some() {
        discovered
    } else if connected {
        Some("keychain".to_owned())
    } else {
        None
    };
    let guid = instance
        .as_ref()
        .and_then(|row| state.store.external_id(&row.id, USER_KEY).ok().flatten());
    let user = instance
        .as_ref()
        .and_then(|row| state.store.identity(&row.id).ok().flatten())
        .map(|identity| identity_user(&identity, guid));
    Ok(AzureSessionDto {
        connected,
        instance: instance.map(|row| AzureInstanceDto {
            id: row.id,
            base_url: row.base_url,
            display_name: row.display_name,
        }),
        user,
        credential_source,
    })
}

/// Restore the last organization without touching the network.
pub fn restore(state: &mut AppState) {
    let Ok(instances) = state.store.list_instances_for(PROVIDER) else {
        return;
    };
    let Some(instance) = instances.into_iter().max_by_key(|row| row.created_at) else {
        return;
    };
    if let Ok(mut slot) = state.azure_instance.lock() {
        *slot = Some(instance.clone());
    }
    if let Some(client) = client_from_secret(state, &instance) {
        if let Ok(mut slot) = state.azure.lock() {
            *slot = Some(client);
        }
        return;
    }
    if let Err(error) = detect_git_credentials(state) {
        tracing::warn!(%error, "Azure DevOps credential discovery failed");
    }
}

fn build_client(
    state: &AppState,
    base_url: &str,
    token: String,
    ca_bundle_pem: Option<Vec<u8>>,
) -> Result<AzureClient, beebranch_azure::AzureError> {
    AzureClient::new(AzureConfig {
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

fn client_from_secret(state: &AppState, instance: &InstanceRow) -> Option<AzureClient> {
    let url = normalize_url(&instance.base_url).ok()?;
    let token = state
        .azure_secrets
        .get(&account_for(&url.host, &instance.id))
        .ok()
        .flatten()?;
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    match build_client(state, &instance.base_url, token, ca_bundle_pem) {
        Ok(client) => Some(client),
        Err(error) => {
            tracing::warn!(%error, "Azure DevOps client restore failed");
            None
        }
    }
}

fn detect_git_credentials(state: &AppState) -> Result<bool, AppError> {
    let connected = state
        .azure
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
        .azure_instance
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let Some(instance) = instance else {
        return Ok(false);
    };
    let host = normalize_url(&instance.base_url).map_err(azure_error)?.host;
    let credentials = beebranch_git::credentials::discover_for_hosts(
        runner,
        state.paths.data_dir(),
        &[host.as_str()],
    )?;
    let Some(credential) = credentials
        .into_iter()
        .find(|credential| credential.host.eq_ignore_ascii_case(&host))
    else {
        return Ok(false);
    };
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    let client = build_client(
        state,
        &instance.base_url,
        credential.password.clone(),
        ca_bundle_pem,
    )
    .map_err(azure_error)?;
    *state
        .azure
        .lock()
        .map_err(|_| AppError::internal("verrou client Azure DevOps"))? = Some(client);
    *state
        .azure_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials Azure DevOps"))? = Some(credential);
    Ok(true)
}

async fn remember_user(
    state: &AppState,
    instance_id: &str,
    user: &AzureUser,
) -> Result<(), AppError> {
    state
        .store
        .set_identity(&IdentityRow {
            instance_id: instance_id.to_owned(),
            user_id: user.id,
            username: user.username.clone(),
            name: Some(user.name.clone()),
            avatar_url: user.avatar_url.clone(),
            validated_at: beebranch_core::now_unix(),
        })
        .map_err(store_error)?;
    if !user.guid.is_empty() {
        state
            .store
            .set_external_id(instance_id, USER_KEY, &user.guid)
            .map_err(store_error)?;
    }
    Ok(())
}

pub async fn configure(
    state: &AppState,
    input: AzureConfigureInput,
) -> Result<AzureSessionDto, AppError> {
    let token = input.token.trim().to_owned();
    if token.is_empty() {
        return Err(AppError::invalid_input("Le jeton Azure DevOps est vide."));
    }
    let normalized = normalize_url(&input.base_url).map_err(azure_error)?;
    let instance_id = InstanceId::from_azure_api_url(&normalized.api_url);
    let ca_pem = input
        .ca_pem
        .as_ref()
        .map(|pem| pem.trim().to_owned())
        .filter(|pem| !pem.is_empty())
        .map(String::into_bytes);
    let client = build_client(state, &normalized.base_url, token.clone(), ca_pem.clone())
        .map_err(azure_error)?;
    let user = client.validate().await.map_err(azure_error)?;
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
    remember_user(state, &instance.id, &user).await?;
    state
        .azure_secrets
        .set(&account_for(&normalized.host, &instance.id), &token)
        .map_err(store_error)?;
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;
    *state
        .azure
        .lock()
        .map_err(|_| AppError::internal("verrou client Azure DevOps"))? = Some(client);
    *state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))? = Some(instance);
    *state
        .azure_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials Azure DevOps"))? = None;
    session(state)
}

pub async fn connect_from_git(
    state: &AppState,
    input: AzureConnectFromGitInput,
) -> Result<AzureSessionDto, AppError> {
    let normalized = normalize_url(&input.base_url).map_err(azure_error)?;
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
                "azure.no_git_credential",
                ErrorCategory::Auth,
                format!(
                    "Aucun identifiant Git n'est configuré pour {}.",
                    normalized.host
                ),
            )
            .with_param("host", normalized.host.clone())
            .with_remediation(
                "Authentifiez-vous une fois avec Git pour cet hôte, ou saisissez un jeton d'accès personnel.",
            )
        })?;
    let instance_id = InstanceId::from_azure_api_url(&normalized.api_url);
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
    .map_err(azure_error)?;
    let user = client.validate().await.map_err(|error| {
        let mapped = azure_error(error);
        if mapped.code == "azure.auth_failed" {
            mapped
                .with_code("azure.git_credential_rejected")
                .with_param("source", credential.source_label())
        } else {
            mapped
        }
    })?;
    let instance = InstanceRow {
        id: instance_id.as_str().to_owned(),
        provider: PROVIDER.to_owned(),
        base_url: normalized.base_url.clone(),
        api_url: normalized.api_url.clone(),
        display_name,
        ca_bundle_id,
        created_at: beebranch_core::now_unix(),
    };
    state
        .store
        .upsert_instance(&instance)
        .map_err(store_error)?;
    remember_user(state, &instance.id, &user).await?;
    state
        .store
        .delete_cache_prefix(&normalized.api_url)
        .map_err(store_error)?;
    *state
        .azure
        .lock()
        .map_err(|_| AppError::internal("verrou client Azure DevOps"))? = Some(client);
    *state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))? = Some(instance);
    *state
        .azure_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials Azure DevOps"))? = Some(credential);
    session(state)
}

#[tauri::command]
pub async fn azure_configure(
    state: State<'_, AppState>,
    input: AzureConfigureInput,
) -> Result<AzureSessionDto, AppError> {
    configure(&state, input).await
}

#[tauri::command]
pub async fn azure_connect_from_git(
    state: State<'_, AppState>,
    input: AzureConnectFromGitInput,
) -> Result<AzureSessionDto, AppError> {
    connect_from_git(&state, input).await
}

#[tauri::command]
pub async fn azure_status(state: State<'_, AppState>) -> Result<AzureSessionDto, AppError> {
    let connected = state
        .azure
        .lock()
        .map(|client| client.is_some())
        .unwrap_or(false);
    if !connected {
        let _ = detect_git_credentials(&state);
    }
    session(&state)
}

#[tauri::command]
pub async fn azure_projects_page(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AzureProjectsPageInput,
) -> Result<Paged<AzureProject>, AppError> {
    let client = client(&state)?;
    let instance = instance_id(&state)?;
    let mut query = RepositoriesQuery::new().with_page(input.page.unwrap_or(1));
    if let Some(per_page) = input.per_page {
        query = query.with_per_page(per_page);
    }
    if let Some(search) = input
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query = query.with_search(search);
    }
    let page = client.repositories(query).await.map_err(|error| {
        auth_event(&app, &error, &instance);
        azure_error(error)
    })?;
    let now = beebranch_core::now_unix();
    let rows: Vec<ProjectRow> = page
        .items
        .iter()
        .map(|project| ProjectRow {
            instance_id: instance.clone(),
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
        tracing::warn!(%error, "Azure DevOps project cache write failed");
    }
    for project in &page.items {
        let _ = state
            .store
            .set_external_id(&instance, project.id, &project.external_id);
    }
    Ok(page)
}

#[tauri::command]
pub fn azure_disconnect(state: State<'_, AppState>) -> Result<bool, AppError> {
    let instance = state
        .azure_instance
        .lock()
        .map_err(|_| AppError::internal("verrou instance Azure DevOps"))?
        .take();
    if let Some(instance) = instance {
        if let Ok(url) = normalize_url(&instance.base_url) {
            let _ = state
                .azure_secrets
                .delete(&account_for(&url.host, &instance.id));
        }
        if let Some(ca_bundle_id) = instance.ca_bundle_id.as_deref() {
            let _ = state.store.delete_ca_bundle(ca_bundle_id);
        }
    }
    *state
        .azure
        .lock()
        .map_err(|_| AppError::internal("verrou client Azure DevOps"))? = None;
    *state
        .azure_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials Azure DevOps"))? = None;
    Ok(true)
}
