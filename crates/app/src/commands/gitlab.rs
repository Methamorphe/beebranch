use std::sync::Arc;
use std::time::Duration;

use beebranch_core::{AppError, ErrorCategory, InstanceId};
use beebranch_gitlab::{
    normalize_url, GitlabClient, GitlabConfig, GitlabProject, GitlabUser, Paged, ProjectsQuery,
    DEFAULT_CACHE_TTL,
};
use beebranch_store::{IdentityRow, InstanceRow, ProjectRow};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{gitlab_error, store_error};
use crate::gitlab_cache::SqliteCache;
use crate::state::AppState;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

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
pub struct ProjectsPageInput {
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
    })
}

/// Restore the last instance and its token from the keychain without any
/// network access (startup must stay offline).
pub fn restore(state: &mut AppState) {
    let instances = match state.store.list_instances() {
        Ok(instances) => instances,
        Err(error) => {
            tracing::warn!(%error, "GitLab instances could not be loaded");
            return;
        }
    };
    let Some(instance) = instances
        .into_iter()
        .max_by_key(|instance| instance.created_at)
    else {
        return;
    };
    let Ok(url) = normalize_url(&instance.base_url) else {
        return;
    };
    // Keep the instance visible even when the token is missing: the UI can
    // prefill the URL and ask for a new token instead of looking disconnected.
    if let Ok(mut slot) = state.gitlab_instance.lock() {
        *slot = Some(instance.clone());
    }
    let account = account_for(&url.host, &instance.id);
    let Some(token) = state.secrets.get(&account).ok().flatten() else {
        tracing::info!("GitLab instance configured but no token in the secret store");
        return;
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
        Ok(client) => {
            let client = client
                .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
                .with_cache_ttl(DEFAULT_CACHE_TTL);
            if let Ok(mut slot) = state.gitlab.lock() {
                *slot = Some(client);
            }
        }
        Err(error) => tracing::warn!(%error, "GitLab client restore failed"),
    }
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
pub fn gitlab_status(state: State<'_, AppState>) -> Result<GitlabSessionDto, AppError> {
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

    if let Some(instance) = instance {
        if let Ok(url) = normalize_url(&instance.base_url) {
            let _ = state.secrets.delete(&account_for(&url.host, &instance.id));
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
    Ok(true)
}
