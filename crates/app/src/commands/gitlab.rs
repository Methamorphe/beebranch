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
use crate::forge_cache::SqliteCache;
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
    let credentials = beebranch_git::credentials::discover(runner, state.paths.data_dir())?;
    if credentials.is_empty() {
        return Ok(false);
    }
    let instance = state
        .gitlab_instance
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let instance_host = instance
        .as_ref()
        .and_then(|row| normalize_url(&row.base_url).ok())
        .map(|url| url.host);
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

#[tauri::command]
pub async fn gitlab_configure(
    state: State<'_, AppState>,
    input: GitlabConfigureInput,
) -> Result<GitlabSessionDto, AppError> {
    configure(&state, input).await
}

#[tauri::command]
pub async fn gitlab_status(state: State<'_, AppState>) -> Result<GitlabSessionDto, AppError> {
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
    *state
        .gitlab_credential
        .lock()
        .map_err(|_| AppError::internal("verrou credentials GitLab"))? = None;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use beebranch_git::credentials::{CredentialOrigin, DiscoveredCredential};

    use super::select_credential;

    fn credential(host: &str, password: &str) -> DiscoveredCredential {
        DiscoveredCredential {
            host: host.to_owned(),
            username: "oauth2".to_owned(),
            password: password.to_owned(),
            origin: CredentialOrigin::GitConfigUrl,
        }
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
}
