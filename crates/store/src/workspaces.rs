//! Local repository workspaces.
//!
//! A workspace is a named list of local repository paths. It stores no remote
//! credential and no repository content; actions are performed by the
//! application on each path independently.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::StoreError;
use crate::Store;

/// Maximum number of repositories in one workspace (bounded memory/actions).
pub const WORKSPACE_REPO_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoRow {
    pub workspace_id: String,
    pub path: String,
    pub name: Option<String>,
    pub added_at: i64,
}

impl Store {
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceRow>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, created_at, updated_at FROM workspaces
                 ORDER BY name COLLATE NOCASE",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(WorkspaceRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;
            let mut workspaces = Vec::new();
            for row in rows {
                workspaces.push(row?);
            }
            Ok(workspaces)
        })
    }

    pub fn create_workspace(&self, name: &str) -> Result<WorkspaceRow, StoreError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(StoreError::Invalid(
                "le nom du workspace doit contenir 1 à 120 caractères".to_owned(),
            ));
        }
        let now = beebranch_core::now_unix();
        let id = unique_workspace_id(now);
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![id, name, now],
            )?;
            Ok(WorkspaceRow {
                id,
                name: name.to_owned(),
                created_at: now,
                updated_at: now,
            })
        })
    }

    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<WorkspaceRow, StoreError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err(StoreError::Invalid(
                "le nom du workspace doit contenir 1 à 120 caractères".to_owned(),
            ));
        }
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, name, now],
            )?;
            if changed == 0 {
                return Err(StoreError::Invalid("workspace introuvable".to_owned()));
            }
            connection
                .query_row(
                    "SELECT id, name, created_at, updated_at FROM workspaces WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok(WorkspaceRow {
                            id: row.get(0)?,
                            name: row.get(1)?,
                            created_at: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .map_err(StoreError::from)
        })
    }

    pub fn delete_workspace(&self, id: &str) -> Result<bool, StoreError> {
        self.with_connection(|connection| {
            let changed =
                connection.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
            Ok(changed > 0)
        })
    }

    pub fn workspace_repos(&self, id: &str) -> Result<Vec<WorkspaceRepoRow>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT workspace_id, path, name, added_at FROM workspace_repos
                 WHERE workspace_id = ?1 ORDER BY added_at, path",
            )?;
            let rows = statement.query_map(params![id], |row| {
                Ok(WorkspaceRepoRow {
                    workspace_id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    added_at: row.get(3)?,
                })
            })?;
            let mut repos = Vec::new();
            for row in rows {
                repos.push(row?);
            }
            Ok(repos)
        })
    }

    pub fn add_workspace_repo(
        &self,
        workspace_id: &str,
        path: &str,
        name: Option<&str>,
    ) -> Result<WorkspaceRepoRow, StoreError> {
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM workspace_repos WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )?;
            if count as usize >= WORKSPACE_REPO_LIMIT {
                return Err(StoreError::Invalid(format!(
                    "un workspace est limité à {WORKSPACE_REPO_LIMIT} dépôts"
                )));
            }
            let exists: i64 = connection.query_row(
                "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(StoreError::Invalid("workspace introuvable".to_owned()));
            }
            connection.execute(
                "INSERT OR REPLACE INTO workspace_repos
                    (workspace_id, path, name, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace_id, path, name, now],
            )?;
            connection.execute(
                "UPDATE workspaces SET updated_at = ?2 WHERE id = ?1",
                params![workspace_id, now],
            )?;
            Ok(WorkspaceRepoRow {
                workspace_id: workspace_id.to_owned(),
                path: path.to_owned(),
                name: name.map(str::to_owned),
                added_at: now,
            })
        })
    }

    pub fn remove_workspace_repo(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<bool, StoreError> {
        self.with_connection(|connection| {
            let changed = connection.execute(
                "DELETE FROM workspace_repos WHERE workspace_id = ?1 AND path = ?2",
                params![workspace_id, path],
            )?;
            Ok(changed > 0)
        })
    }
}

fn unique_workspace_id(now: i64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ws_{now:x}_{counter:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_repos_are_ordered_and_bounded() {
        let store = Store::open_in_memory().expect("store");
        let workspace = store.create_workspace("Produit").expect("create");
        for index in 0..WORKSPACE_REPO_LIMIT {
            store
                .add_workspace_repo(&workspace.id, &format!("/tmp/repo-{index}"), None)
                .expect("add");
        }
        let error = store
            .add_workspace_repo(&workspace.id, "/tmp/overflow", None)
            .expect_err("bounded");
        assert!(matches!(error, StoreError::Invalid(_)));
        assert_eq!(
            store.workspace_repos(&workspace.id).expect("list").len(),
            WORKSPACE_REPO_LIMIT
        );
        store
            .remove_workspace_repo(&workspace.id, "/tmp/repo-0")
            .expect("remove");
        assert_eq!(
            store.workspace_repos(&workspace.id).expect("list").len(),
            WORKSPACE_REPO_LIMIT - 1
        );
    }

    #[test]
    fn deleting_a_workspace_cascades() {
        let store = Store::open_in_memory().expect("store");
        let workspace = store.create_workspace("Client").expect("create");
        store
            .add_workspace_repo(&workspace.id, "/tmp/repo", Some("repo"))
            .expect("add");
        assert!(store.delete_workspace(&workspace.id).expect("delete"));
        assert!(store
            .workspace_repos(&workspace.id)
            .expect("list")
            .is_empty());
    }
}
