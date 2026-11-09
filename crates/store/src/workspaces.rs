//! Local repository workspaces.
//!
//! A workspace is a named list of local repository paths. It stores no remote
//! credential and no repository content; actions are performed by the
//! application on each path independently.

use rusqlite::{params, OptionalExtension};
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
    /// `lucide`, `image`, or absent when the workspace shows its monogram.
    pub icon_kind: Option<String>,
    /// Lucide icon name when `icon_kind` is `lucide`.
    pub icon_key: Option<String>,
}

const WORKSPACE_LIST_SQL: &str = "SELECT id, name, created_at, updated_at, icon_kind, icon_key
     FROM workspaces ORDER BY name COLLATE NOCASE";
const WORKSPACE_BY_ID_SQL: &str =
    "SELECT id, name, created_at, updated_at, icon_kind, icon_key FROM workspaces WHERE id = ?1";

fn read_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        icon_kind: row.get(4)?,
        icon_key: row.get(5)?,
    })
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
            let mut statement = connection.prepare(WORKSPACE_LIST_SQL)?;
            let rows = statement.query_map([], read_workspace)?;
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
            connection
                .query_row(WORKSPACE_BY_ID_SQL, params![id], read_workspace)
                .map_err(StoreError::from)
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
                .query_row(WORKSPACE_BY_ID_SQL, params![id], read_workspace)
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

    pub fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRow>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(WORKSPACE_BY_ID_SQL, params![id], read_workspace)
                .optional()
                .map_err(StoreError::from)
        })
    }

    /// `kind` is `lucide`, `image`, or `None` for the monogram.
    /// `key` is the Lucide name when `kind` is `lucide`.
    pub fn set_workspace_icon(
        &self,
        id: &str,
        kind: Option<&str>,
        key: Option<&str>,
    ) -> Result<WorkspaceRow, StoreError> {
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE workspaces
                 SET icon_kind = ?2, icon_key = ?3, updated_at = MAX(?4, updated_at + 1)
                 WHERE id = ?1",
                params![id, kind, key, now],
            )?;
            if changed == 0 {
                return Err(StoreError::Invalid("workspace introuvable".to_owned()));
            }
            connection
                .query_row(WORKSPACE_BY_ID_SQL, params![id], read_workspace)
                .map_err(StoreError::from)
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
            let existing = connection
                .query_row(
                    "SELECT workspace_id, path, name, added_at FROM workspace_repos
                     WHERE workspace_id = ?1 AND path = ?2",
                    params![workspace_id, path],
                    |row| {
                        Ok(WorkspaceRepoRow {
                            workspace_id: row.get(0)?,
                            path: row.get(1)?,
                            name: row.get(2)?,
                            added_at: row.get(3)?,
                        })
                    },
                )
                .optional()?;
            if let Some(row) = existing {
                return Ok(row);
            }
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
                "INSERT INTO workspace_repos (workspace_id, path, name, added_at)
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

    #[test]
    fn adding_the_same_path_keeps_its_place_and_name() {
        let store = Store::open_in_memory().expect("store");
        let workspace = store.create_workspace("Client").expect("create");
        let first = store
            .add_workspace_repo(&workspace.id, "/tmp/a", Some("a"))
            .expect("first");
        store
            .add_workspace_repo(&workspace.id, "/tmp/b", None)
            .expect("second");
        let again = store
            .add_workspace_repo(&workspace.id, "/tmp/a", Some("renamed"))
            .expect("again");
        assert_eq!(again.added_at, first.added_at);
        assert_eq!(again.name.as_deref(), Some("a"));
        let repos = store.workspace_repos(&workspace.id).expect("list");
        assert_eq!(repos[0].path, "/tmp/a");
        assert_eq!(repos[1].path, "/tmp/b");
    }

    #[test]
    fn icon_is_optional_and_replaceable() {
        let store = Store::open_in_memory().expect("store");
        let workspace = store.create_workspace("Client").expect("create");
        assert_eq!(workspace.icon_kind, None);
        let with_icon = store
            .set_workspace_icon(&workspace.id, Some("lucide"), Some("rocket"))
            .expect("icon");
        assert_eq!(with_icon.icon_kind.as_deref(), Some("lucide"));
        assert_eq!(with_icon.icon_key.as_deref(), Some("rocket"));
        assert!(with_icon.updated_at >= workspace.updated_at);
        let cleared = store
            .set_workspace_icon(&workspace.id, None, None)
            .expect("clear");
        assert_eq!(cleared.icon_kind, None);
        assert_eq!(cleared.icon_key, None);
        assert!(store.set_workspace_icon("missing", None, None).is_err());
    }
}
