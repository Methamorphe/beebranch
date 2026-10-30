//! Fetch, pull and push with progress streaming and cancellation.

use beebranch_core::{AppError, Confirmation, DestructiveAction, ErrorCategory};
use beebranch_git::session::InvalidationArea;
use beebranch_git::sync::{self, PullStrategy, PushRequest, SyncKind, SyncOutcome};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::util::{
    announce_hooks, begin_destructive, begin_operation, emit_operation, finish_destructive,
    finish_operation, new_operation_id, operation_progress, run_mutation, MutationResult,
};
use crate::state::AppState;

/// Build a short-lived runner; Git's existing helpers remain first in order.
fn authenticated_runner(
    state: &AppState,
    runner: &beebranch_git::GitRunner,
) -> Result<beebranch_git::GitRunner, AppError> {
    let mut hosts = Vec::new();
    for instance in [
        state.gitlab_instance.lock().ok().and_then(|v| v.clone()),
        state.github_instance.lock().ok().and_then(|v| v.clone()),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(url) = url::Url::parse(&instance.base_url) {
            if let Some(host) = url.host_str() {
                let authority = match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_owned(),
                };
                hosts.push(authority);
            }
        }
    }
    for credential in [
        state.gitlab_credential.lock().ok().and_then(|v| v.clone()),
        state.github_credential.lock().ok().and_then(|v| v.clone()),
    ]
    .into_iter()
    .flatten()
    {
        hosts.push(credential.host);
    }
    hosts.sort();
    hosts.dedup();
    let credentials = hosts
        .into_iter()
        .filter_map(|host| {
            super::repo::https_auth_for(state, &format!("https://{host}")).map(|auth| (host, auth))
        })
        .collect::<Vec<_>>();
    runner.with_https_credentials(&credentials)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub repo_id: String,
    pub remote: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub repo_id: String,
    pub remote: String,
    pub branch: String,
    #[serde(default)]
    pub strategy: Option<PullStrategy>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushCommandRequest {
    pub repo_id: String,
    pub remote: String,
    pub branch: String,
    #[serde(default)]
    pub set_upstream: bool,
    /// Explicit force push. Must be accompanied by a typed confirmation.
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub confirmation: Confirmation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub operation_id: String,
}

/// Preference enabling `git submodule update --init --recursive` after a
/// successful fetch or pull. Stored as `"true"`/`"false"`.
pub const SUBMODULE_AUTO_UPDATE: &str = "git.submodulesAutoUpdate";

/// Refresh submodules after a sync, when the preference is enabled.
///
/// Errors are reported to the log only: the sync itself succeeded, and a
/// failing submodule endpoint must not turn it into a failure.
async fn refresh_submodules(
    store: std::sync::Arc<beebranch_store::Store>,
    session: std::sync::Arc<beebranch_git::session::RepoSession>,
) {
    let enabled = store
        .preference(SUBMODULE_AUTO_UPDATE)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let runner = session.runner().clone();
        let worktree = session.worktree().to_path_buf();
        let report = beebranch_git::submodule::list(&runner, &worktree)?;
        if report.entries.is_empty() {
            return Ok::<(), AppError>(());
        }
        beebranch_git::submodule::update(&runner, &worktree, true, true, false, None)?;
        Ok(())
    })
    .await;
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(code = %error.code, "submodule auto-update failed: {}", error.message)
        }
        Err(error) => tracing::warn!(%error, "submodule auto-update task failed"),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchAllRequest {
    pub repo_id: String,
}

/// Fetch every remote of the repository, one after another.
///
/// A failing remote does not abort the others: each outcome is returned in
/// order, and the first error is reported only after the last remote ran.
#[tauri::command]
pub async fn sync_fetch_all(
    app: AppHandle,
    state: State<'_, AppState>,
    request: FetchAllRequest,
) -> Result<MutationResult<Vec<RemoteFetchOutcome>>, AppError> {
    let session = state.session(&request.repo_id)?;
    let remotes = {
        let runner = session.runner().clone();
        let worktree = session.worktree().to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            beebranch_git::refs_admin::list_remotes(&runner, &worktree)
        })
        .await
        .map_err(crate::error::join_error)??
    };
    if remotes.is_empty() {
        return Err(AppError::invalid_input(
            "Ce dépôt n'a aucun remote à récupérer.".to_owned(),
        ));
    }
    let mut outcomes = Vec::with_capacity(remotes.len());
    for remote in remotes {
        let result = fetch_remote(&app, &state, &session, &request.repo_id, &remote.name).await;
        match result {
            Ok(outcome) => outcomes.push(RemoteFetchOutcome {
                remote: remote.name,
                outcome: Some(outcome),
                error: None,
            }),
            Err(error) => outcomes.push(RemoteFetchOutcome {
                remote: remote.name,
                outcome: None,
                error: Some(FetchFailure {
                    code: error.code.to_string(),
                    message: error.message.clone(),
                }),
            }),
        }
    }
    let failed = outcomes
        .iter()
        .filter(|entry| entry.error.is_some())
        .count();
    if failed == outcomes.len() {
        return Err(AppError::new(
            "sync.fetch_all_failed",
            ErrorCategory::Network,
            "Aucun remote n'a pu être récupéré.",
        ));
    }
    if failed > 0 {
        tracing::warn!(failed, total = outcomes.len(), "fetch all partially failed");
    }
    Ok(MutationResult {
        data: outcomes,
        generation: session.generation(),
        state: session.state(),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFetchOutcome {
    pub remote: String,
    pub outcome: Option<SyncOutcome>,
    pub error: Option<FetchFailure>,
}

/// Fetch one remote under its own operation id.
async fn fetch_remote(
    app: &AppHandle,
    state: &AppState,
    session: &std::sync::Arc<beebranch_git::session::RepoSession>,
    repo_id: &str,
    remote: &str,
) -> Result<SyncOutcome, AppError> {
    let runner = authenticated_runner(state, session.runner())?;
    let operation_id = new_operation_id("fetch");
    begin_operation(
        state,
        &operation_id,
        "fetch",
        repo_id,
        &session.worktree().display().to_string(),
    )?;
    let operations = state.operations.clone();
    let app_handle = app.clone();
    let owned_id = operation_id.clone();
    let owned_remote = remote.to_owned();
    let owned_repo = repo_id.to_owned();
    let result = run_mutation(session.clone(), {
        let app = app_handle;
        let repo_id = owned_repo.clone();
        move |_, discovery| {
            let runner = &runner;
            let worktree = discovery.worktree()?;
            let context = beebranch_git::OperationContext::new(&owned_id, "fetch");
            let command = sync::spawn_fetch(
                runner,
                worktree,
                &owned_remote,
                &context,
                operation_progress(&app, &owned_id, &repo_id),
            )?;
            if let Ok(mut flags) = operations.lock() {
                flags.insert(owned_id.clone(), (repo_id.clone(), command.cancel_flag()));
            }
            emit_operation(
                &app,
                "op://started",
                serde_json::json!({ "operationId": owned_id, "repoId": repo_id }),
            );
            let outcome = sync::finish(command, SyncKind::Fetch, || None);
            if let Ok(mut flags) = operations.lock() {
                flags.remove(&owned_id);
            }
            let outcome = outcome?;
            Ok((outcome, InvalidationArea::ALL.to_vec()))
        }
    })
    .await;
    finish_operation(state, &operation_id, result.as_ref().err())?;
    match result {
        Ok(mutation) => Ok(mutation.data),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn sync_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: FetchRequest,
) -> Result<MutationResult<SyncOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let runner = authenticated_runner(&state, session.runner())?;
    let operation_id = new_operation_id("fetch");
    begin_operation(
        &state,
        &operation_id,
        "fetch",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let operations = state.operations.clone();
    let result = run_mutation(session.clone(), {
        let operation_id = operation_id.clone();
        let remote = request.remote.clone();
        let app = app.clone();
        move |_, discovery| {
            let runner = &runner;
            let worktree = discovery.worktree()?;
            let context = beebranch_git::OperationContext::new(&operation_id, "fetch");
            let command = sync::spawn_fetch(
                runner,
                worktree,
                &remote,
                &context,
                operation_progress(&app, &operation_id, &request.repo_id),
            )?;
            if let Ok(mut flags) = operations.lock() {
                flags.insert(
                    operation_id.clone(),
                    (request.repo_id.clone(), command.cancel_flag()),
                );
            }
            emit_operation(
                &app,
                "op://started",
                serde_json::json!({ "operationId": operation_id, "repoId": request.repo_id }),
            );
            let outcome = sync::finish(command, SyncKind::Fetch, || None);
            if let Ok(mut flags) = operations.lock() {
                flags.remove(&operation_id);
            }
            let outcome = outcome?;
            Ok((outcome, InvalidationArea::ALL.to_vec()))
        }
    })
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    if result.is_ok() {
        refresh_submodules(state.store.clone(), session.clone()).await;
    }
    result
}

#[tauri::command]
pub async fn sync_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PullRequest,
) -> Result<MutationResult<SyncOutcome>, AppError> {
    let session = state.session(&request.repo_id)?;
    let runner = authenticated_runner(&state, session.runner())?;
    let auto_session = session.clone();
    let operation_id = new_operation_id("pull");
    begin_operation(
        &state,
        &operation_id,
        "pull",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let operations = state.operations.clone();
    let result = run_mutation(session, {
        let operation_id = operation_id.clone();
        let app = app.clone();
        move |_, discovery| {
            let runner = &runner;
            let worktree = discovery.worktree()?;
            let context = beebranch_git::OperationContext::new(&operation_id, "pull");
            let before = sync::branch_position(runner, worktree);
            let command = sync::spawn_pull(
                runner,
                worktree,
                &request.remote,
                &request.branch,
                request.strategy.unwrap_or(PullStrategy::Auto),
                &context,
                operation_progress(&app, &operation_id, &request.repo_id),
            )?;
            if let Ok(mut flags) = operations.lock() {
                flags.insert(
                    operation_id.clone(),
                    (request.repo_id.clone(), command.cancel_flag()),
                );
            }
            emit_operation(
                &app,
                "op://started",
                serde_json::json!({ "operationId": operation_id, "repoId": request.repo_id }),
            );
            let remote_check =
                || sync::remote_branch_sha(runner, worktree, &request.remote, &request.branch);
            let outcome = sync::finish(command, SyncKind::Pull, remote_check);
            if let Ok(mut flags) = operations.lock() {
                flags.remove(&operation_id);
            }
            let mut outcome = outcome?;
            let after = sync::branch_position(runner, worktree);
            outcome.head_before = before.head;
            outcome.head_after = after.head;
            outcome.behind_upstream = after.behind;
            Ok((outcome, InvalidationArea::ALL.to_vec()))
        }
    })
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    if result.is_ok() {
        refresh_submodules(state.store.clone(), auto_session).await;
    }
    result
}

#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PushCommandRequest,
) -> Result<MutationResult<SyncOutcome>, AppError> {
    if request.force {
        request
            .confirmation
            .verify(DestructiveAction::ForcePush, Some(&request.branch))?;
    }
    let session = state.session(&request.repo_id)?;
    let runner = authenticated_runner(&state, session.runner())?;
    let operation_id = new_operation_id("push");
    let journal_id = if request.force {
        let previous = tauri::async_runtime::spawn_blocking({
            let session = session.clone();
            let runner = runner.clone();
            let remote = request.remote.clone();
            let branch = request.branch.clone();
            move || {
                beebranch_git::sync::remote_branch_sha(
                    &runner,
                    session.worktree(),
                    &remote,
                    &branch,
                )
            }
        })
        .await
        .map_err(crate::error::join_error)?;
        let Some(previous) = previous else {
            return Err(AppError::new(
                "push.remote_ref_missing",
                beebranch_core::ErrorCategory::GitState,
                "La branche distante est introuvable pour --force-with-lease.",
            )
            .with_remediation("Fetchez la branche distante et vérifiez le remote."));
        };
        let id = new_operation_id("force-push");
        begin_destructive(
            &state,
            &id,
            DestructiveAction::ForcePush.code(),
            &request.repo_id,
            &session.worktree().display().to_string(),
        )?;
        Some((
            id,
            format!(
                "{}/{} · ancien SHA distant {previous}",
                request.remote, request.branch
            ),
        ))
    } else {
        None
    };
    begin_operation(
        &state,
        &operation_id,
        "push",
        &request.repo_id,
        &session.worktree().display().to_string(),
    )?;
    let operations = state.operations.clone();
    let result = run_mutation(session, {
        let operation_id = operation_id.clone();
        let app = app.clone();
        let force = request.force;
        move |_, discovery| {
            let runner = &runner;
            let worktree = discovery.worktree()?;
            // Informational only: failing to list hooks must not block the
            // push, Git runs them anyway.
            let hooks = beebranch_git::hooks::active(
                runner,
                worktree,
                beebranch_git::hooks::HookPoint::Push,
            )
            .unwrap_or_default();
            announce_hooks(&app, &operation_id, &request.repo_id, &hooks);
            let force_with_lease = if force {
                let sha =
                    sync::remote_branch_sha(runner, worktree, &request.remote, &request.branch)
                        .ok_or_else(|| {
                            AppError::new(
                                "push.remote_ref_missing",
                                beebranch_core::ErrorCategory::GitState,
                                "La branche distante est introuvable pour --force-with-lease.",
                            )
                            .with_remediation("Fetchez la branche distante et vérifiez le remote.")
                        })?;
                Some(sha)
            } else {
                None
            };
            let push = PushRequest {
                remote: request.remote.clone(),
                branch: request.branch.clone(),
                set_upstream: request.set_upstream,
                force_with_lease,
            };
            let context = beebranch_git::OperationContext::new(&operation_id, "push");
            let command = sync::spawn_push(
                runner,
                worktree,
                &push,
                &context,
                operation_progress(&app, &operation_id, &request.repo_id),
            )?;
            if let Ok(mut flags) = operations.lock() {
                flags.insert(
                    operation_id.clone(),
                    (request.repo_id.clone(), command.cancel_flag()),
                );
            }
            emit_operation(
                &app,
                "op://started",
                serde_json::json!({ "operationId": operation_id, "repoId": request.repo_id }),
            );
            let remote_check =
                || sync::remote_branch_sha(runner, worktree, &request.remote, &request.branch);
            let outcome = sync::finish(command, SyncKind::Push, remote_check);
            if let Ok(mut flags) = operations.lock() {
                flags.remove(&operation_id);
            }
            let outcome = outcome?;
            Ok((outcome, InvalidationArea::ALL.to_vec()))
        }
    })
    .await;
    finish_operation(&state, &operation_id, result.as_ref().err())?;
    if let Some((journal_id, detail)) = journal_id {
        finish_destructive(&state, &journal_id, &detail, result.as_ref().err())?;
    }
    result
}

#[tauri::command]
pub fn operation_cancel(
    state: State<'_, AppState>,
    request: CancelRequest,
) -> Result<bool, AppError> {
    if request.operation_id.is_empty() || request.operation_id.chars().any(char::is_control) {
        return Err(AppError::invalid_input("operation_id invalide".to_owned()));
    }
    state.cancel_operation(&request.operation_id)
}

#[cfg(test)]
mod auth_tests {
    use super::authenticated_runner;
    use beebranch_git::{credentials, CommandSpec, GitSubcommand};
    use beebranch_store::{InstanceRow, Store};

    #[test]
    fn sync_runner_uses_connected_pat_and_serialized_oauth_tokens() {
        let directory = tempfile::tempdir().expect("directory");
        let state = crate::state::test_state(
            directory.path().to_path_buf(),
            Store::open_in_memory().expect("store"),
        );
        let runner = state.runner().expect("runner");
        for (command, args) in [
            (GitSubcommand::Init, vec!["--quiet"]),
            (
                GitSubcommand::Config,
                vec!["--local", "credential.helper", ""],
            ),
        ] {
            assert!(runner
                .run(&CommandSpec::new(command, directory.path()).args(args))
                .expect("git")
                .success());
        }
        *state.gitlab_instance.lock().expect("instance") = Some(InstanceRow {
            id: "gl_sync".into(),
            provider: "gitlab".into(),
            base_url: "https://forge.example.test:8443".into(),
            api_url: "https://forge.example.test:8443/api/v4".into(),
            display_name: None,
            ca_bundle_id: None,
            created_at: 1,
        });
        let account = "forge.example.test:8443#gl_sync";
        state.secrets.set(account, "glpat-sync-test").expect("PAT");
        let authenticated = authenticated_runner(&state, runner).expect("authenticated runner");
        let pat = credentials::fill(&authenticated, directory.path(), "forge.example.test:8443")
            .expect("fill")
            .expect("PAT credential");
        assert_eq!(pat.password, "glpat-sync-test");
        // Exercise the exact JSON format persisted by the OAuth connection.
        state.secrets.set(&format!("{account}#oauth"),
            r#"{"accessToken":"oauth-sync-test","refreshToken":"refresh","expiresAt":9999999999,"clientId":"test"}"#)
            .expect("OAuth");
        let authenticated = authenticated_runner(&state, runner).expect("OAuth runner");
        let oauth = credentials::fill(&authenticated, directory.path(), "forge.example.test:8443")
            .expect("fill")
            .expect("OAuth credential");
        assert_eq!(oauth.username, "oauth2");
        assert_eq!(oauth.password, "oauth-sync-test");
        assert!(
            credentials::fill(&authenticated, directory.path(), "other.example.test")
                .expect("fill")
                .is_none()
        );
    }
}
