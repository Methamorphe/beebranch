//! Profiles: Git identity, preferences, one GitLab instance and one GitHub
//! account per profile.
//!
//! Profiles live in the preferences store. A profile references an existing
//! GitLab instance id and, the same way, a GitHub login. Tokens remain in the
//! OS keychain, so no secret is copied between profiles.

use std::sync::Arc;
use std::time::Duration;

use beebranch_core::{now_unix, AppError, ErrorCategory};
use beebranch_gitlab::{normalize_url, GitlabClient, GitlabConfig, DEFAULT_CACHE_TTL};
use beebranch_store::InstanceRow;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::store_error;
use crate::forge_cache::SqliteCache;
use crate::state::AppState;

const PROFILES_KEY: &str = "profiles";
const ACTIVE_PROFILE_KEY: &str = "profile.active";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    #[serde(default = "default_pull")]
    pub default_pull: String,
    pub gitlab_instance_id: Option<String>,
    #[serde(default)]
    pub github_login: Option<String>,
    pub created_at: i64,
}

fn default_pull() -> String {
    "rebase".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub profiles: Vec<Profile>,
    pub active_id: Option<String>,
}

fn load(state: &AppState) -> Result<Vec<Profile>, AppError> {
    let raw = state.store.preference(PROFILES_KEY).map_err(store_error)?;
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|error| {
        AppError::internal(format!("profils illisibles : {error}")).with_remediation(
            "Le fichier de préférences des profils est corrompu ; supprimez la clé `profiles`.",
        )
    })
}

fn save(state: &AppState, profiles: &[Profile]) -> Result<(), AppError> {
    let raw = serde_json::to_string(profiles)
        .map_err(|error| AppError::internal(format!("profils : {error}")))?;
    state
        .store
        .set_preference(PROFILES_KEY, &raw)
        .map_err(store_error)
}

fn active_id(state: &AppState) -> Result<Option<String>, AppError> {
    Ok(state
        .store
        .preference(ACTIVE_PROFILE_KEY)
        .map_err(store_error)?
        .filter(|value| !value.is_empty()))
}

fn view(state: &AppState) -> Result<ProfilesView, AppError> {
    Ok(ProfilesView {
        profiles: load(state)?,
        active_id: active_id(state)?,
    })
}

fn input_error(code: &'static str, message: &str) -> AppError {
    AppError::new(code, ErrorCategory::Input, message)
}

fn validate_field(
    value: &str,
    max: usize,
    empty: &'static str,
    empty_message: &str,
    control: &'static str,
    control_message: &str,
    too_long: &'static str,
    too_long_message: &str,
) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(input_error(empty, empty_message));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(input_error(control, control_message));
    }
    if trimmed.chars().count() > max {
        return Err(input_error(too_long, too_long_message));
    }
    Ok(trimmed.to_owned())
}

fn github_login(value: Option<String>) -> Result<Option<String>, AppError> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let valid = trimmed.chars().count() <= 39
        && trimmed
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace());
    if !valid {
        return Err(input_error(
            "profile.github_invalid",
            "Le compte GitHub est invalide.",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

fn reject_duplicate(profiles: &[Profile], skip_id: &str, profile: &Profile) -> Result<(), AppError> {
    if profiles
        .iter()
        .any(|existing| existing.id != skip_id && existing.name == profile.name)
    {
        return Err(input_error(
            "profile.name_taken",
            "Un profil porte déjà ce nom.",
        ));
    }
    if let Some(instance) = profile.gitlab_instance_id.as_deref() {
        if profiles.iter().any(|existing| {
            existing.id != skip_id && existing.gitlab_instance_id.as_deref() == Some(instance)
        }) {
            return Err(input_error(
                "profile.gitlab_taken",
                "Cette instance GitLab est déjà associée à un autre profil.",
            ));
        }
    }
    if let Some(login) = profile.github_login.as_deref() {
        if profiles.iter().any(|existing| {
            existing.id != skip_id && existing.github_login.as_deref() == Some(login)
        }) {
            return Err(input_error(
                "profile.github_taken",
                "Ce compte GitHub est déjà associé à un autre profil.",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Result<ProfilesView, AppError> {
    view(&state)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    #[serde(default)]
    pub default_pull: Option<String>,
    #[serde(default)]
    pub gitlab_instance_id: Option<String>,
    #[serde(default)]
    pub github_login: Option<String>,
}

fn build_profile(input: ProfileInput, id: String, created_at: i64) -> Result<Profile, AppError> {
    let name = validate_field(
        &input.name,
        80,
        "profile.name_empty",
        "Le nom du profil est vide.",
        "profile.name_control",
        "Le nom du profil contient un caractère de contrôle.",
        "profile.name_too_long",
        "Le nom du profil dépasse 80 caractères.",
    )?;
    let user_name = validate_field(
        &input.user_name,
        120,
        "profile.git_name_empty",
        "Le nom Git est vide.",
        "profile.git_name_control",
        "Le nom Git contient un caractère de contrôle.",
        "profile.git_name_too_long",
        "Le nom Git dépasse 120 caractères.",
    )?;
    let user_email = validate_field(
        &input.user_email,
        200,
        "profile.email_empty",
        "L'email Git est vide.",
        "profile.email_control",
        "L'email Git contient un caractère de contrôle.",
        "profile.email_too_long",
        "L'email Git dépasse 200 caractères.",
    )?;
    if !user_email.contains('@') {
        return Err(input_error(
            "profile.email_invalid",
            "L'email Git ne contient pas de `@`.",
        ));
    }
    let default_pull = input.default_pull.unwrap_or_else(default_pull);
    if !matches!(default_pull.as_str(), "merge" | "rebase" | "ffOnly") {
        return Err(input_error(
            "profile.pull_invalid",
            "La stratégie de pull doit être `merge`, `rebase` ou `ffOnly`.",
        ));
    }
    if let Some(instance) = input.gitlab_instance_id.as_deref() {
        if instance.trim().is_empty() {
            return Err(input_error(
                "profile.gitlab_empty",
                "L'identifiant d'instance GitLab est vide.",
            ));
        }
    }
    Ok(Profile {
        id,
        name,
        user_name,
        user_email,
        default_pull,
        gitlab_instance_id: input.gitlab_instance_id,
        github_login: github_login(input.github_login)?,
        created_at,
    })
}

#[tauri::command]
pub fn profile_create(
    state: State<'_, AppState>,
    input: ProfileInput,
) -> Result<ProfilesView, AppError> {
    let mut profiles = load(&state)?;
    if profiles.len() >= 20 {
        return Err(input_error(
            "profile.limit",
            "Le nombre maximal de profils (20) est atteint.",
        ));
    }
    let id = format!("profile-{}", now_unix());
    let profile = build_profile(input, id.clone(), now_unix())?;
    reject_duplicate(&profiles, &id, &profile)?;
    profiles.push(profile);
    save(&state, &profiles)?;
    if active_id(&state)?.is_none() {
        state
            .store
            .set_preference(ACTIVE_PROFILE_KEY, &id)
            .map_err(store_error)?;
    }
    view(&state)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdateRequest {
    pub id: String,
    pub input: ProfileInput,
}

#[tauri::command]
pub fn profile_update(
    state: State<'_, AppState>,
    request: ProfileUpdateRequest,
) -> Result<ProfilesView, AppError> {
    let mut profiles = load(&state)?;
    let index = profiles
        .iter()
        .position(|profile| profile.id == request.id)
        .ok_or_else(|| input_error("profile.not_found", "Profil introuvable."))?;
    let created_at = profiles[index].created_at;
    let updated = build_profile(request.input, request.id.clone(), created_at)?;
    reject_duplicate(&profiles, &request.id, &updated)?;
    profiles[index] = updated;
    save(&state, &profiles)?;
    view(&state)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIdRequest {
    pub id: String,
    #[serde(default)]
    pub repo_id: Option<String>,
}

#[tauri::command]
pub fn profile_delete(
    state: State<'_, AppState>,
    request: ProfileIdRequest,
) -> Result<ProfilesView, AppError> {
    let mut profiles = load(&state)?;
    let before = profiles.len();
    profiles.retain(|profile| profile.id != request.id);
    if profiles.len() == before {
        return Err(input_error("profile.not_found", "Profil introuvable."));
    }
    save(&state, &profiles)?;
    if active_id(&state)?.as_deref() == Some(request.id.as_str()) {
        let next = profiles.first().map(|profile| profile.id.clone());
        state
            .store
            .set_preference(ACTIVE_PROFILE_KEY, next.as_deref().unwrap_or(""))
            .map_err(store_error)?;
    }
    view(&state)
}

#[tauri::command]
pub fn profile_set_active(
    state: State<'_, AppState>,
    request: ProfileIdRequest,
) -> Result<ProfilesView, AppError> {
    let profiles = load(&state)?;
    if !profiles.iter().any(|profile| profile.id == request.id) {
        return Err(input_error("profile.not_found", "Profil introuvable."));
    }
    state
        .store
        .set_preference(ACTIVE_PROFILE_KEY, &request.id)
        .map_err(store_error)?;
    view(&state)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityApplied {
    pub profile_id: String,
    pub name: String,
    pub email: String,
}

/// Write the profile identity to the repository's local Git config.
/// Other repositories and other profiles are untouched.
#[tauri::command]
pub async fn profile_apply_identity(
    state: State<'_, AppState>,
    request: ProfileIdRequest,
) -> Result<IdentityApplied, AppError> {
    let profiles = load(&state)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == request.id)
        .ok_or_else(|| input_error("profile.not_found", "Profil introuvable."))?
        .clone();
    let repo_id = match request.repo_id.clone() {
        Some(repo_id) => repo_id,
        None => state
            .sessions
            .list()
            .first()
            .map(|session| session.id().as_str().to_owned())
            .ok_or_else(|| {
                AppError::new(
                    "profile.no_repo",
                    ErrorCategory::Repo,
                    "Aucun dépôt n'est ouvert.",
                )
            })?,
    };
    let session = state.session(&repo_id)?;
    let worktree = session.worktree().to_path_buf();
    let runner = session.runner().clone();
    let name = profile.user_name.clone();
    let email = profile.user_email.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for (key, value) in [("user.name", &name), ("user.email", &email)] {
            let spec =
                beebranch_git::CommandSpec::new(beebranch_git::GitSubcommand::Config, &worktree)
                    .arg("--local")
                    .arg(key)
                    .arg(value);
            runner.run(&spec)?.ensure_success()?;
        }
        Ok(IdentityApplied {
            profile_id: profile.id,
            name,
            email,
        })
    })
    .await
    .map_err(crate::error::join_error)?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileGitlabState {
    pub profile_id: String,
    pub instance_id: String,
    pub activated: bool,
}

/// Activate the GitLab instance attached to a profile. The token is read from
/// the keychain under the instance account; it is never copied.
#[tauri::command]
pub async fn profile_gitlab_activate(
    state: State<'_, AppState>,
    request: ProfileIdRequest,
) -> Result<ProfileGitlabState, AppError> {
    let profiles = load(&state)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == request.id)
        .ok_or_else(|| input_error("profile.not_found", "Profil introuvable."))?;
    let instance_id = profile.gitlab_instance_id.clone().ok_or_else(|| {
        AppError::new(
            "profile.gitlab_unconfigured",
            ErrorCategory::Auth,
            "Ce profil n'est associé à aucune instance GitLab.",
        )
        .with_remediation("Configurez GitLab puis associez l'instance au profil.")
    })?;
    let instance: InstanceRow = state
        .store
        .instance(&instance_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("Instance GitLab introuvable.".to_owned()))?;
    let normalized = normalize_url(&instance.base_url).map_err(crate::error::gitlab_error)?;
    let account = format!("{}#{}", normalized.host, instance.id);
    let token = state
        .secrets
        .get(&account)
        .map_err(|error| AppError::internal(error.to_string()))?
        .ok_or_else(|| {
            AppError::new(
                "gitlab.token_missing",
                ErrorCategory::Auth,
                "Aucun token n'est disponible pour cette instance.",
            )
            .with_remediation("Reconnectez l'instance GitLab.")
        })?;
    let ca_bundle_pem = instance
        .ca_bundle_id
        .as_ref()
        .and_then(|id| state.store.ca_bundle(id).ok().flatten());
    let client = GitlabClient::new(GitlabConfig {
        base_url: instance.base_url.clone(),
        token,
        ca_bundle_pem,
        timeout: REQUEST_TIMEOUT,
    })
    .map_err(crate::error::gitlab_error)?
    .with_cache(Arc::new(SqliteCache::new(state.store.clone())))
    .with_cache_ttl(DEFAULT_CACHE_TTL);
    if let Ok(mut slot) = state.gitlab.lock() {
        *slot = Some(client);
    }
    if let Ok(mut slot) = state.gitlab_instance.lock() {
        *slot = Some(instance);
    }
    Ok(ProfileGitlabState {
        profile_id: request.id,
        instance_id,
        activated: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ProfileInput {
        ProfileInput {
            name: "Travail".into(),
            user_name: "Alice".into(),
            user_email: "alice@example.test".into(),
            default_pull: None,
            gitlab_instance_id: None,
            github_login: None,
        }
    }

    #[test]
    fn validates_identity_and_pull_strategy() {
        let profile = build_profile(input(), "profile-1".into(), 1).expect("valid");
        assert_eq!(profile.default_pull, "rebase");
        assert_eq!(profile.user_email, "alice@example.test");
        assert_eq!(profile.github_login, None);

        let mut with_github = input();
        with_github.github_login = Some(" octocat ".into());
        let linked = build_profile(with_github, "profile-gh".into(), 1).expect("github");
        assert_eq!(linked.github_login.as_deref(), Some("octocat"));

        let mut blank_github = input();
        blank_github.github_login = Some("  ".into());
        let unlinked = build_profile(blank_github, "profile-blank".into(), 1).expect("blank");
        assert_eq!(unlinked.github_login, None);

        let mut bad_email = input();
        bad_email.user_email = "alice".into();
        assert!(build_profile(bad_email, "profile-2".into(), 1).is_err());

        let mut bad_pull = input();
        bad_pull.default_pull = Some("octopus".into());
        assert!(build_profile(bad_pull, "profile-3".into(), 1).is_err());

        let mut empty = input();
        empty.name = "  ".into();
        assert!(build_profile(empty, "profile-4".into(), 1).is_err());
    }

    #[test]
    fn profiles_serialize_with_the_frontend_contract() {
        let profile = build_profile(input(), "profile-1".into(), 1).expect("valid");
        let json = serde_json::to_value(&profile).expect("json");
        assert!(json.get("userName").is_some());
        assert!(json.get("user_name").is_none());
    }
}
