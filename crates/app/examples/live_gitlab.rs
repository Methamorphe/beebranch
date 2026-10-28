//! Live proof of the application-level GitLab path: configure, validate,
//! persist, secret storage, cache and redacted diagnostics.
//!
//! Reads the token from `/tmp/beebranch-glpat`; never prints it. Uses an
//! in-memory secret store so the developer keychain is untouched by the proof.

use std::sync::Arc;

use beebranch_app::commands::gitlab::{
    configure, projects_page, GitlabConfigureInput, ProjectsPageInput,
};
use beebranch_app::commands::recovery::diagnostics;
use beebranch_app::state::{build_state, AppPaths};
use beebranch_gitlab::ProjectsQuery;
use beebranch_store::{KeychainStore, MemorySecretStore, SecretStore, Store};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::async_runtime::block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let token_path =
        std::env::var("GITLAB_TOKEN_FILE").unwrap_or_else(|_| "/tmp/beebranch-glpat".to_owned());
    let base_url =
        std::env::var("GITLAB_URL").unwrap_or_else(|_| "https://gitlab.beelan.fr/".to_owned());
    let token = std::fs::read_to_string(&token_path)?.trim().to_owned();
    let dir = tempfile::tempdir()?;
    let store = Arc::new(Store::open(dir.path().join("proof.sqlite3"))?);
    let secrets: Arc<dyn SecretStore> = if std::env::var("LIVE_KEYCHAIN").is_ok() {
        Arc::new(KeychainStore::new("beebranch.live.proof"))
    } else {
        Arc::new(MemorySecretStore::new())
    };
    let state = build_state(
        AppPaths {
            data_dir: dir.path().to_path_buf(),
        },
        store.clone(),
        secrets.clone(),
    );

    let session = configure(
        &state,
        GitlabConfigureInput {
            base_url: base_url.clone(),
            token: token.clone(),
            ca_pem: None,
            display_name: Some("Beelan GitLab".into()),
        },
    )
    .await?;
    println!(
        "configured connected={} instance={} user={}",
        session.connected,
        session
            .instance
            .as_ref()
            .map(|instance| instance.base_url.as_str())
            .unwrap_or("?"),
        session
            .user
            .as_ref()
            .map(|user| user.username.as_str())
            .unwrap_or("?")
    );

    let client = state
        .gitlab
        .lock()
        .expect("gitlab lock")
        .clone()
        .expect("configured client");
    let projects = client
        .projects(ProjectsQuery::new().with_per_page(10))
        .await?;
    println!(
        "projects_via_app_client items={} total={:?} first={}",
        projects.items.len(),
        projects.total,
        projects
            .items
            .first()
            .map(|project| project.path_with_namespace.as_str())
            .unwrap_or("?")
    );

    let page = projects_page(
        &state,
        ProjectsPageInput {
            search: Some("fleet".into()),
            page: Some(1),
            per_page: Some(20),
        },
        |_| {},
    )
    .await?;
    println!(
        "projects_page persisted items={} next={:?}",
        page.items.len(),
        page.next_page
    );

    let instances = store.list_instances()?;
    let instance = instances.first().expect("stored instance");
    let identity = store.identity(&instance.id)?.expect("identity");
    let account = format!(
        "{}#{}",
        beebranch_gitlab::normalize_url(&instance.base_url)?.host,
        instance.id
    );
    println!(
        "persisted instances={} identity={} projects_cached={} secret_present={}",
        instances.len(),
        identity.username,
        store.list_projects(&instance.id, None, 10)?.len(),
        secrets.get(&account)?.is_some()
    );

    let dump = store.dump_for_tests()?;
    if std::env::var("LIVE_KEYCHAIN").is_ok() {
        secrets.delete(&account)?;
        println!(
            "live_keychain_secret_cleaned={}",
            secrets.get(&account)?.is_none()
        );
    }

    println!(
        "sqlite_contains_token={} sqlite_contains_private_token_header={}",
        dump.contains(&token) || dump.contains("glpat-"),
        dump.to_ascii_lowercase().contains("private-token")
    );

    let export = diagnostics(&state)?;
    println!(
        "diagnostics_contains_token={} diagnostics_contains_instance={}",
        export.contains(&token) || export.contains("glpat-"),
        export.contains("gitlab.beelan.fr")
    );

    let bad = configure(
        &state,
        GitlabConfigureInput {
            base_url,
            token: "glpat-invalid-token".into(),
            ca_pem: None,
            display_name: None,
        },
    )
    .await;
    match bad {
        Ok(_) => println!("bad_token_unexpectedly_accepted"),
        Err(error) => println!(
            "bad_token code={} detail_has_token={}",
            error.code,
            error
                .detail
                .as_deref()
                .map(|detail| detail.contains("glpat-"))
                .unwrap_or(false)
        ),
    }

    if std::env::var("TEST_KEYCHAIN").is_ok() {
        let keychain = KeychainStore::new("beebranch.test.live");
        keychain.set("proof", "keychain-secret")?;
        let value = keychain.get("proof")?;
        keychain.delete("proof")?;
        println!(
            "keychain_roundtrip={} keychain_value_len={:?} keychain_cleaned={}",
            value.as_deref() == Some("keychain-secret"),
            value.as_ref().map(String::len),
            keychain.get("proof")?.is_none()
        );
    }

    Ok(())
}
