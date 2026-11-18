use std::sync::Arc;

use beebranch_store::{DurableSecretStore, FileSecretStore, SecretStore, Store};
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

    let (secrets, github_secrets) = forge_secrets(paths.data_dir());
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

/// GitLab and GitHub tokens share one file. Each provider still has its own
/// keychain service, read once when the file has no entry yet.
///
/// Debug builds do not write the keychain: an unsigned binary changes
/// signature on every compilation and macOS would prompt every time.
fn forge_secrets(data_dir: &std::path::Path) -> (Arc<dyn SecretStore>, Arc<dyn SecretStore>) {
    adopt_legacy_dev_file(data_dir);
    let file = Arc::new(FileSecretStore::new(data_dir.join("secrets.json")));
    let write_keychain = !cfg!(debug_assertions);
    (
        Arc::new(DurableSecretStore::new(
            file.clone(),
            "beebranch.gitlab",
            write_keychain,
        )),
        Arc::new(DurableSecretStore::new(
            file,
            "beebranch.github",
            write_keychain,
        )),
    )
}

/// Development builds used to keep every token in `secrets-dev.json`. Copy it
/// once so those tokens follow the shared file.
fn adopt_legacy_dev_file(data_dir: &std::path::Path) {
    let target = data_dir.join("secrets.json");
    let legacy = data_dir.join("secrets-dev.json");
    if target.exists() || !legacy.exists() {
        return;
    }
    if std::fs::copy(&legacy, &target).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600));
    }
}
