use std::sync::Arc;

#[cfg(not(debug_assertions))]
use beebranch_store::KeychainStore;
#[cfg(debug_assertions)]
use beebranch_store::{FileSecretStore, KeychainStore};
use beebranch_store::{SecretStore, Store};
use tauri::{App, Manager, Runtime};

use crate::logging;
use crate::state::{build_state_with_secrets, AppPaths};

/// Prepare the application state before the window is shown.
pub fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let paths = AppPaths::resolve(app)?;
    paths.ensure()?;
    std::fs::create_dir_all(paths.log_dir())?;
    logging::init(&paths.data_dir);

    let store = Arc::new(Store::open(paths.database())?);
    let interrupted = store.interrupt_running_operations()?;
    if !interrupted.is_empty() {
        tracing::warn!(
            count = interrupted.len(),
            "interrupted Git operations detected at startup"
        );
    }
    match store.interrupt_restoring_undo() {
        Ok(records) if !records.is_empty() => tracing::warn!(
            count = records.len(),
            "interrupted undo restorations detected at startup; no automatic retry"
        ),
        Ok(_) => {}
        Err(error) => tracing::error!(%error, "undo crash recovery failed"),
    }

    #[cfg(debug_assertions)]
    let (secrets, github_secrets): (Arc<dyn SecretStore>, Arc<dyn SecretStore>) = {
        let file = Arc::new(FileSecretStore::new(
            paths.data_dir().join("secrets-dev.json"),
        ));
        migrate_keychain_token_once(&store, &file, paths.data_dir());
        (file.clone(), file)
    };
    #[cfg(not(debug_assertions))]
    let (secrets, github_secrets): (Arc<dyn SecretStore>, Arc<dyn SecretStore>) = (
        Arc::new(KeychainStore::default_service()),
        Arc::new(KeychainStore::new("beebranch.github")),
    );
    let mut state = build_state_with_secrets(paths.clone(), store, secrets, github_secrets);
    state.interrupted = std::sync::Mutex::new(interrupted);
    crate::commands::gitlab::restore(&mut state);
    crate::commands::github::restore(&mut state);

    tracing::info!(
        data_dir = %paths.data_dir.display(),
        version = beebranch_core::APP_VERSION,
        git = state
            .capability
            .as_ref()
            .map(|capability| capability.version.to_string())
            .as_deref()
            .unwrap_or("introuvable"),
        "BeeBranch application state ready"
    );

    app.manage(state);
    crate::splash::init(app);
    Ok(())
}

/// One-shot migration of the last GitLab token from the macOS keychain to the
/// development file store. This triggers at most one "Always Allow" prompt;
/// a marker prevents retrying if the user denies it.
#[cfg(debug_assertions)]
fn migrate_keychain_token_once(store: &Store, file: &FileSecretStore, data_dir: &std::path::Path) {
    let marker = data_dir.join("secrets-dev.migrated");
    if marker.exists() {
        return;
    }
    let instance = store
        .list_instances_for("gitlab")
        .ok()
        .and_then(|instances| instances.into_iter().max_by_key(|entry| entry.created_at));
    if let Some(instance) = instance {
        if let Ok(url) = beebranch_gitlab::normalize_url(&instance.base_url) {
            let account = format!("{}#{}", url.host, instance.id);
            if file.get(&account).ok().flatten().is_none() {
                if let Ok(Some(token)) = KeychainStore::default_service().get(&account) {
                    let _ = file.set(&account, &token);
                }
            }
        }
    }
    let _ = std::fs::write(marker, b"1");
}
