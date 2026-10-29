use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::StoreError;
use crate::Store;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRow {
    pub id: String,
    /// `gitlab` or `github`.
    #[serde(default = "default_provider")]
    pub provider: String,
    pub base_url: String,
    pub api_url: String,
    pub display_name: Option<String>,
    pub ca_bundle_id: Option<String>,
    pub created_at: i64,
}

fn default_provider() -> String {
    "gitlab".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRow {
    pub instance_id: String,
    pub user_id: u64,
    pub username: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub validated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub instance_id: String,
    pub project_id: u64,
    pub path_with_namespace: String,
    pub name: String,
    pub web_url: String,
    pub ssh_url: Option<String>,
    pub http_url: Option<String>,
    pub default_branch: Option<String>,
    pub last_activity_at: Option<String>,
    pub fetched_at: i64,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLink {
    pub repo_id: String,
    pub instance_id: String,
    pub project_id: u64,
    /// `url`, `path` or `manual`.
    pub match_kind: String,
    pub verified_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheEntry {
    pub etag: Option<String>,
    pub body: Vec<u8>,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub repo_id: String,
    pub path: String,
    pub name: Option<String>,
    pub last_opened_at: i64,
}

impl Store {
    pub fn upsert_instance(&self, instance: &InstanceRow) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO gitlab_instances
                    (id, provider, base_url, api_url, display_name, ca_bundle_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    provider = excluded.provider,
                    base_url = excluded.base_url,
                    api_url = excluded.api_url,
                    display_name = excluded.display_name,
                    ca_bundle_id = excluded.ca_bundle_id",
                params![
                    instance.id,
                    instance.provider,
                    instance.base_url,
                    instance.api_url,
                    instance.display_name,
                    instance.ca_bundle_id,
                    instance.created_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn instance(&self, id: &str) -> Result<Option<InstanceRow>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, provider, base_url, api_url, display_name, ca_bundle_id, created_at
                     FROM gitlab_instances WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok(InstanceRow {
                            id: row.get(0)?,
                            provider: row.get(1)?,
                            base_url: row.get(2)?,
                            api_url: row.get(3)?,
                            display_name: row.get(4)?,
                            ca_bundle_id: row.get(5)?,
                            created_at: row.get(6)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn list_instances(&self) -> Result<Vec<InstanceRow>, StoreError> {
        self.list_instances_where(None)
    }

    /// Instances belonging to one forge provider (`gitlab` or `github`).
    pub fn list_instances_for(&self, provider: &str) -> Result<Vec<InstanceRow>, StoreError> {
        self.list_instances_where(Some(provider))
    }

    fn list_instances_where(&self, provider: Option<&str>) -> Result<Vec<InstanceRow>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, provider, base_url, api_url, display_name, ca_bundle_id, created_at
                 FROM gitlab_instances
                 WHERE ?1 IS NULL OR provider = ?1
                 ORDER BY created_at",
            )?;
            let rows = statement.query_map(params![provider], |row| {
                Ok(InstanceRow {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    base_url: row.get(2)?,
                    api_url: row.get(3)?,
                    display_name: row.get(4)?,
                    ca_bundle_id: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StoreError::from)
        })
    }

    pub fn delete_instance(&self, id: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute("DELETE FROM gitlab_instances WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    pub fn set_identity(&self, identity: &IdentityRow) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO gitlab_identity
                    (instance_id, user_id, username, name, avatar_url, validated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(instance_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    username = excluded.username,
                    name = excluded.name,
                    avatar_url = excluded.avatar_url,
                    validated_at = excluded.validated_at",
                params![
                    identity.instance_id,
                    identity.user_id,
                    identity.username,
                    identity.name,
                    identity.avatar_url,
                    identity.validated_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn identity(&self, instance_id: &str) -> Result<Option<IdentityRow>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT instance_id, user_id, username, name, avatar_url, validated_at
                     FROM gitlab_identity WHERE instance_id = ?1",
                    params![instance_id],
                    |row| {
                        Ok(IdentityRow {
                            instance_id: row.get(0)?,
                            user_id: row.get(1)?,
                            username: row.get(2)?,
                            name: row.get(3)?,
                            avatar_url: row.get(4)?,
                            validated_at: row.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    /// Replace the project cache for an instance in one transaction.
    pub fn replace_projects(
        &self,
        instance_id: &str,
        projects: &[ProjectRow],
    ) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM gitlab_projects WHERE instance_id = ?1",
                params![instance_id],
            )?;
            for project in projects {
                transaction.execute(
                    "INSERT INTO gitlab_projects
                        (instance_id, project_id, path_with_namespace, name, web_url,
                         ssh_url, http_url, default_branch, last_activity_at, fetched_at, etag)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        project.instance_id,
                        project.project_id,
                        project.path_with_namespace,
                        project.name,
                        project.web_url,
                        project.ssh_url,
                        project.http_url,
                        project.default_branch,
                        project.last_activity_at,
                        project.fetched_at,
                        project.etag
                    ],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    /// Insert or update projects without deleting other cached rows.
    pub fn upsert_projects(&self, projects: &[ProjectRow]) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            for project in projects {
                transaction.execute(
                    "INSERT INTO gitlab_projects
                        (instance_id, project_id, path_with_namespace, name, web_url,
                         ssh_url, http_url, default_branch, last_activity_at, fetched_at, etag)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(instance_id, project_id) DO UPDATE SET
                        path_with_namespace = excluded.path_with_namespace,
                        name = excluded.name,
                        web_url = excluded.web_url,
                        ssh_url = excluded.ssh_url,
                        http_url = excluded.http_url,
                        default_branch = excluded.default_branch,
                        last_activity_at = excluded.last_activity_at,
                        fetched_at = excluded.fetched_at,
                        etag = excluded.etag",
                    params![
                        project.instance_id,
                        project.project_id,
                        project.path_with_namespace,
                        project.name,
                        project.web_url,
                        project.ssh_url,
                        project.http_url,
                        project.default_branch,
                        project.last_activity_at,
                        project.fetched_at,
                        project.etag
                    ],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn list_projects(
        &self,
        instance_id: &str,
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ProjectRow>, StoreError> {
        self.with_connection(|connection| {
            let pattern = format!("%{}%", search.unwrap_or(""));
            let mut statement = connection.prepare(
                "SELECT instance_id, project_id, path_with_namespace, name, web_url,
                        ssh_url, http_url, default_branch, last_activity_at, fetched_at, etag
                 FROM gitlab_projects
                 WHERE instance_id = ?1
                   AND (?2 = '%%' OR path_with_namespace LIKE ?2 OR name LIKE ?2)
                 ORDER BY last_activity_at DESC
                 LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![instance_id, pattern, limit.clamp(1, 1000)],
                |row| {
                    Ok(ProjectRow {
                        instance_id: row.get(0)?,
                        project_id: row.get(1)?,
                        path_with_namespace: row.get(2)?,
                        name: row.get(3)?,
                        web_url: row.get(4)?,
                        ssh_url: row.get(5)?,
                        http_url: row.get(6)?,
                        default_branch: row.get(7)?,
                        last_activity_at: row.get(8)?,
                        fetched_at: row.get(9)?,
                        etag: row.get(10)?,
                    })
                },
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StoreError::from)
        })
    }

    pub fn set_repo_link(&self, link: &RepoLink) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO repo_project_links
                    (repo_id, instance_id, project_id, match_kind, verified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(repo_id) DO UPDATE SET
                    instance_id = excluded.instance_id,
                    project_id = excluded.project_id,
                    match_kind = excluded.match_kind,
                    verified_at = excluded.verified_at",
                params![
                    link.repo_id,
                    link.instance_id,
                    link.project_id,
                    link.match_kind,
                    link.verified_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn repo_link(&self, repo_id: &str) -> Result<Option<RepoLink>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT repo_id, instance_id, project_id, match_kind, verified_at
                     FROM repo_project_links WHERE repo_id = ?1",
                    params![repo_id],
                    |row| {
                        Ok(RepoLink {
                            repo_id: row.get(0)?,
                            instance_id: row.get(1)?,
                            project_id: row.get(2)?,
                            match_kind: row.get(3)?,
                            verified_at: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    /// Repository link belonging to one forge provider.
    ///
    /// A repository has at most one link; this lookup keeps a GitLab command
    /// from reading a GitHub association (and vice versa).
    pub fn repo_link_for(
        &self,
        repo_id: &str,
        provider: &str,
    ) -> Result<Option<RepoLink>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT l.repo_id, l.instance_id, l.project_id, l.match_kind, l.verified_at
                     FROM repo_project_links l
                     JOIN gitlab_instances i ON i.id = l.instance_id
                     WHERE l.repo_id = ?1 AND i.provider = ?2",
                    params![repo_id, provider],
                    |row| {
                        Ok(RepoLink {
                            repo_id: row.get(0)?,
                            instance_id: row.get(1)?,
                            project_id: row.get(2)?,
                            match_kind: row.get(3)?,
                            verified_at: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn delete_repo_link(&self, repo_id: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "DELETE FROM repo_project_links WHERE repo_id = ?1",
                params![repo_id],
            )?;
            Ok(())
        })
    }

    pub fn get_cache(&self, key: &str) -> Result<Option<CacheEntry>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT etag, body, fetched_at, expires_at
                     FROM gitlab_cache WHERE cache_key = ?1",
                    params![key],
                    |row| {
                        Ok(CacheEntry {
                            etag: row.get(0)?,
                            body: row.get(1)?,
                            fetched_at: row.get(2)?,
                            expires_at: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn put_cache(&self, key: &str, entry: &CacheEntry) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO gitlab_cache (cache_key, etag, body, fetched_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(cache_key) DO UPDATE SET
                    etag = excluded.etag,
                    body = excluded.body,
                    fetched_at = excluded.fetched_at,
                    expires_at = excluded.expires_at",
                params![
                    key,
                    entry.etag,
                    entry.body,
                    entry.fetched_at,
                    entry.expires_at
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_cache_prefix(&self, prefix: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "DELETE FROM gitlab_cache WHERE cache_key LIKE ?1",
                params![format!("{prefix}%")],
            )?;
            Ok(())
        })
    }

    pub fn put_ca_bundle(&self, id: &str, pem: &[u8]) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO ca_bundles (id, pem, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET pem = excluded.pem",
                params![id, pem, beebranch_core::now_unix()],
            )?;
            Ok(())
        })
    }

    pub fn delete_ca_bundle(&self, id: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute("DELETE FROM ca_bundles WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    pub fn ca_bundle(&self, id: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT pem FROM ca_bundles WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn touch_recent_repo(
        &self,
        repo_id: &str,
        path: &str,
        name: Option<&str>,
    ) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO recent_repos (repo_id, path, name, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(repo_id) DO UPDATE SET
                    path = excluded.path,
                    name = COALESCE(excluded.name, recent_repos.name),
                    last_opened_at = excluded.last_opened_at",
                params![repo_id, path, name, beebranch_core::now_unix()],
            )?;
            Ok(())
        })
    }

    pub fn list_recent_repos(&self, limit: u32) -> Result<Vec<RecentRepo>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT repo_id, path, name, last_opened_at
                 FROM recent_repos ORDER BY last_opened_at DESC, rowid DESC LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit.clamp(1, 100)], |row| {
                Ok(RecentRepo {
                    repo_id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    last_opened_at: row.get(3)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StoreError::from)
        })
    }

    pub fn remove_recent_repo(&self, repo_id: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "DELETE FROM recent_repos WHERE repo_id = ?1",
                params![repo_id],
            )?;
            Ok(())
        })
    }

    pub fn set_preference(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at",
                params![key, value, beebranch_core::now_unix()],
            )?;
            Ok(())
        })
    }

    pub fn preference(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT value FROM preferences WHERE key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(StoreError::from)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance() -> InstanceRow {
        InstanceRow {
            id: "gl_1".into(),
            provider: "gitlab".into(),
            base_url: "https://gitlab.example.test".into(),
            api_url: "https://gitlab.example.test/api/v4".into(),
            display_name: None,
            ca_bundle_id: None,
            created_at: 1,
        }
    }

    #[test]
    fn instances_and_identity_roundtrip() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_instance(&instance()).expect("insert");
        store
            .set_identity(&IdentityRow {
                instance_id: "gl_1".into(),
                user_id: 42,
                username: "alice".into(),
                name: Some("Alice".into()),
                avatar_url: None,
                validated_at: 2,
            })
            .expect("identity");
        let loaded = store.instance("gl_1").expect("get").expect("found");
        assert_eq!(loaded.api_url, "https://gitlab.example.test/api/v4");
        let identity = store.identity("gl_1").expect("get").expect("found");
        assert_eq!(identity.username, "alice");
    }

    #[test]
    fn projects_are_replaced_and_searchable() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_instance(&instance()).expect("insert");
        let project = ProjectRow {
            instance_id: "gl_1".into(),
            project_id: 7,
            path_with_namespace: "group/app".into(),
            name: "App".into(),
            web_url: "https://gitlab.example.test/group/app".into(),
            ssh_url: None,
            http_url: None,
            default_branch: Some("main".into()),
            last_activity_at: None,
            fetched_at: 1,
            etag: None,
        };
        store
            .replace_projects("gl_1", std::slice::from_ref(&project))
            .expect("replace");
        assert_eq!(
            store
                .list_projects("gl_1", Some("group"), 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.list_projects("gl_1", Some("nope"), 10).unwrap().len(),
            0
        );
    }

    #[test]
    fn instances_and_links_are_provider_scoped() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_instance(&instance()).expect("gitlab");
        store
            .upsert_instance(&InstanceRow {
                id: "gh_1".into(),
                provider: "github".into(),
                base_url: "https://github.com".into(),
                api_url: "https://api.github.com".into(),
                display_name: None,
                ca_bundle_id: None,
                created_at: 2,
            })
            .expect("github");

        assert_eq!(store.list_instances().unwrap().len(), 2);
        assert_eq!(store.list_instances_for("gitlab").unwrap().len(), 1);
        assert_eq!(store.list_instances_for("github").unwrap()[0].id, "gh_1");

        store
            .set_repo_link(&RepoLink {
                repo_id: "repo_1".into(),
                instance_id: "gh_1".into(),
                project_id: 12,
                match_kind: "url".into(),
                verified_at: 1,
            })
            .expect("link");
        assert!(store.repo_link_for("repo_1", "gitlab").unwrap().is_none());
        assert_eq!(
            store
                .repo_link_for("repo_1", "github")
                .unwrap()
                .map(|link| link.project_id),
            Some(12)
        );
    }

    #[test]
    fn cache_roundtrip() {
        let store = Store::open_in_memory().expect("store");
        let entry = CacheEntry {
            etag: Some("\"abc\"".into()),
            body: br#"{"ok":true}"#.to_vec(),
            fetched_at: 1,
            expires_at: None,
        };
        store.put_cache("k", &entry).expect("put");
        assert_eq!(store.get_cache("k").expect("get"), Some(entry));
        store.delete_cache_prefix("k").expect("delete");
        assert!(store.get_cache("k").expect("get").is_none());
    }

    #[test]
    fn tokens_are_never_stored_in_tables() {
        let store = Store::open_in_memory().expect("store");
        store.upsert_instance(&instance()).expect("insert");
        let dump = store.dump_for_tests().expect("dump");
        assert!(!dump.contains("glpat-"));
        assert!(!dump.to_lowercase().contains("token"));
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn repo_links_roundtrip_and_can_be_removed() {
        let store = Store::open_in_memory().expect("store");
        store
            .upsert_instance(&InstanceRow {
                id: "gl_1".into(),
                provider: "gitlab".into(),
                base_url: "https://gitlab.example.test".into(),
                api_url: "https://gitlab.example.test/api/v4".into(),
                display_name: None,
                ca_bundle_id: None,
                created_at: 1,
            })
            .expect("instance");
        let link = RepoLink {
            repo_id: "repo_1".into(),
            instance_id: "gl_1".into(),
            project_id: 7,
            match_kind: "url".into(),
            verified_at: 1,
        };
        store.set_repo_link(&link).expect("set");
        assert_eq!(store.repo_link("repo_1").expect("get"), Some(link));
        store.delete_repo_link("repo_1").expect("delete");
        assert!(store.repo_link("repo_1").expect("get").is_none());
    }
}
