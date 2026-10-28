use rusqlite::Connection;

use crate::error::StoreError;

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    repo_id TEXT,
    repo_path TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    detail TEXT,
    error_code TEXT
);
CREATE INDEX IF NOT EXISTS operations_state ON operations(state);

CREATE TABLE IF NOT EXISTS recent_repos (
    repo_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT,
    last_opened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gitlab_instances (
    id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    api_url TEXT NOT NULL UNIQUE,
    display_name TEXT,
    ca_bundle_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gitlab_identity (
    instance_id TEXT PRIMARY KEY REFERENCES gitlab_instances(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    validated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gitlab_projects (
    instance_id TEXT NOT NULL REFERENCES gitlab_instances(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL,
    path_with_namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    web_url TEXT NOT NULL,
    ssh_url TEXT,
    http_url TEXT,
    default_branch TEXT,
    last_activity_at TEXT,
    fetched_at INTEGER NOT NULL,
    etag TEXT,
    PRIMARY KEY (instance_id, project_id)
);
CREATE INDEX IF NOT EXISTS gitlab_projects_path
    ON gitlab_projects(instance_id, path_with_namespace);

CREATE TABLE IF NOT EXISTS repo_project_links (
    repo_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    match_kind TEXT NOT NULL,
    verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gitlab_cache (
    cache_key TEXT PRIMARY KEY,
    etag TEXT,
    body BLOB NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS ca_bundles (
    id TEXT PRIMARY KEY,
    pem BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
"#,
    r#"
CREATE TABLE IF NOT EXISTS undo_records (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    undo_json TEXT NOT NULL,
    redo_json TEXT,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    touched_refs TEXT NOT NULL,
    state TEXT NOT NULL,
    step TEXT,
    command TEXT,
    detail TEXT,
    recovery_sha TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS undo_records_repo
    ON undo_records(repo_id, position DESC);
CREATE INDEX IF NOT EXISTS undo_records_state
    ON undo_records(state);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, path)
);
"#,
];

pub(crate) fn configure(connection: &Connection) -> Result<(), StoreError> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

pub(crate) fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );",
    )?;
    let current: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    for (index, statement) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i64;
        if version <= current {
            continue;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(statement)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, beebranch_core::now_unix()],
        )?;
        transaction.commit()?;
    }
    Ok(())
}
