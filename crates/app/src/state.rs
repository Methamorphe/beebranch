use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use beebranch_core::{AppError, ErrorCategory};
use beebranch_git::{GitCapability, GitRunner, SessionRegistry};
use beebranch_store::{MemorySecretStore, OperationRecord, SecretStore, Store};
use tauri::{App, Manager, Runtime};

/// Cancel handle of a long-running operation, with its owning repository.
pub type OperationHandle = (String, Arc<AtomicBool>);

/// Registry shared by commands and long-running operation workers.
pub type OperationRegistry = Arc<Mutex<HashMap<String, OperationHandle>>>;

/// Filesystem locations owned by the application.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &App<R>) -> Result<Self, tauri::Error> {
        Ok(Self {
            data_dir: app.path().app_data_dir()?,
        })
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn database(&self) -> PathBuf {
        self.data_dir.join("beebranch.sqlite3")
    }

    pub fn log_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
}

/// Shared application state managed by Tauri.
pub struct AppState {
    pub paths: AppPaths,
    pub store: Arc<Store>,
    pub secrets: Arc<dyn SecretStore>,
    pub sessions: Arc<SessionRegistry>,
    pub runner: Option<GitRunner>,
    pub runner_error: Option<AppError>,
    pub capability: Option<GitCapability>,
    pub interrupted: Mutex<Vec<OperationRecord>>,
    pub gitlab: Mutex<Option<beebranch_gitlab::GitlabClient>>,
    pub gitlab_instance: Mutex<Option<beebranch_store::InstanceRow>>,
    /// Cancel flags for long-running operations, keyed by operation id.
    pub operations: OperationRegistry,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("data_dir", &self.paths.data_dir)
            .field("sessions", &self.sessions.len())
            .field("has_git", &self.runner.is_some())
            .field(
                "has_gitlab",
                &self.gitlab.lock().map(|g| g.is_some()).unwrap_or(false),
            )
            .finish()
    }
}

impl AppState {
    pub fn runner(&self) -> Result<&GitRunner, AppError> {
        self.runner.as_ref().ok_or_else(|| {
            self.runner_error.clone().unwrap_or_else(|| {
                AppError::new(
                    "git.program_not_found",
                    ErrorCategory::Input,
                    "Git est introuvable.",
                )
            })
        })
    }

    pub fn session(
        &self,
        repo_id: &str,
    ) -> Result<Arc<beebranch_git::session::RepoSession>, AppError> {
        let id = beebranch_core::RepoId::from_raw(repo_id);
        self.sessions.get(&id).ok_or_else(|| {
            AppError::new(
                "repo.not_open",
                ErrorCategory::Repo,
                "Le dépôt n'est pas ouvert.",
            )
            .with_remediation("Ouvrez le dépôt avant de lire son état.")
        })
    }

    pub fn take_interrupted(&self) -> Vec<OperationRecord> {
        self.interrupted
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default()
    }

    pub fn cancel_operation(&self, id: &str) -> Result<bool, AppError> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| AppError::internal("verrou des opérations"))?;
        let Some((_, flag)) = operations.get(id) else {
            return Ok(false);
        };
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(true)
    }

    /// Cancel every in-flight operation of one repository (used before close).
    pub fn cancel_repository(&self, repo_id: &str) -> usize {
        let Ok(operations) = self.operations.lock() else {
            return 0;
        };
        let mut cancelled = 0;
        for (owner, flag) in operations.values() {
            if owner == repo_id {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                cancelled += 1;
            }
        }
        cancelled
    }
}

/// Build production or test state.
pub fn build_state(paths: AppPaths, store: Arc<Store>, secrets: Arc<dyn SecretStore>) -> AppState {
    let (runner, runner_error) = match GitRunner::detect() {
        Ok(runner) => (Some(runner), None),
        Err(error) => (None, Some(AppError::from(error))),
    };
    let capability = runner.as_ref().and_then(|runner| {
        GitCapability::detect(runner, &paths.data_dir)
            .map_err(|error| tracing::warn!(%error, "Git capability detection failed"))
            .ok()
    });

    AppState {
        paths,
        store,
        secrets,
        sessions: Arc::new(SessionRegistry::new()),
        runner,
        runner_error,
        capability,
        interrupted: Mutex::new(Vec::new()),
        gitlab: Mutex::new(None),
        gitlab_instance: Mutex::new(None),
        operations: Arc::new(Mutex::new(HashMap::new())),
    }
}

/// Test constructor with an in-memory secret store.
pub fn test_state(data_dir: PathBuf, store: Store) -> AppState {
    build_state(
        AppPaths { data_dir },
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
    )
}
