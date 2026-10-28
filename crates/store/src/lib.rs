//! Local persistence.
//!
//! SQLite stores preferences, recent repositories, the operation journal,
//! GitLab instances/projects/cache and configuration. Secrets (GitLab tokens)
//! live in the OS keychain through [`SecretStore`] in release builds. Debug
//! builds use a 0600 file because macOS invalidates keychain ACLs whenever the
//! unsigned binary changes (every recompilation). No file inside a repository
//! is ever written.

mod db;
mod error;
mod gitlab;
mod operations;
mod secrets;
mod undo;
mod workspaces;

pub use error::StoreError;
pub use gitlab::{CacheEntry, IdentityRow, InstanceRow, ProjectRow, RecentRepo, RepoLink};
pub use operations::{OperationRecord, OperationState};
pub use secrets::{FileSecretStore, KeychainStore, MemorySecretStore, SecretStore};
pub use undo::{NewUndoRecord, UndoRecord, UndoState, UNDO_LIMIT};
pub use workspaces::{WorkspaceRepoRow, WorkspaceRow, WORKSPACE_REPO_LIMIT};

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// Application database handle.
pub struct Store {
    connection: Mutex<Connection>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    /// Open (or create) the database and run migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = Connection::open(path)?;
        db::configure(&connection)?;
        db::migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let mut connection = Connection::open_in_memory()?;
        db::configure(&connection)?;
        db::migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::Invalid("connexion SQLite empoisonnée".to_owned()))?;
        operation(&mut connection)
    }

    /// Dump every table as text. Used by security tests to assert that no
    /// token leaks into SQLite.
    #[doc(hidden)]
    pub fn dump_for_tests(&self) -> Result<String, StoreError> {
        self.with_connection(|connection| {
            let mut names = Vec::new();
            {
                let mut statement =
                    connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                for row in rows {
                    names.push(row?);
                }
            }
            let mut dump = String::new();
            for name in names {
                dump.push_str(&format!("[{name}]\n"));
                let mut statement =
                    connection.prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "")))?;
                let columns = statement.column_count();
                let mut rows = statement.query([])?;
                while let Some(row) = rows.next()? {
                    for index in 0..columns {
                        let value = row.get_ref(index)?;
                        dump.push_str(&format!("{value:?} "));
                    }
                    dump.push('\n');
                }
            }
            Ok(dump)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_file_database_and_applies_migrations_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.sqlite3");
        let store = Store::open(&path).expect("open");
        store
            .begin_operation("op", "fetch", None, None)
            .expect("begin");
        drop(store);

        let reopened = Store::open(&path).expect("reopen");
        let operation = reopened.operation("op").expect("get").expect("found");
        assert_eq!(operation.kind, "fetch");
    }

    #[test]
    fn preferences_roundtrip() {
        let store = Store::open_in_memory().expect("store");
        assert_eq!(store.preference("theme").unwrap(), None);
        store.set_preference("theme", "dark").unwrap();
        assert_eq!(store.preference("theme").unwrap().as_deref(), Some("dark"));
    }

    #[test]
    fn recent_repos_are_ordered() {
        let store = Store::open_in_memory().expect("store");
        store.touch_recent_repo("a", "/a", Some("A")).unwrap();
        store.touch_recent_repo("b", "/b", Some("B")).unwrap();
        let repos = store.list_recent_repos(10).unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].repo_id, "b");
    }
}
