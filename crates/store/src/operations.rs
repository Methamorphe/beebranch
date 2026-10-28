use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::StoreError;
use crate::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

impl OperationState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Interrupted,
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: String,
    pub kind: String,
    pub state: OperationState,
    pub repo_id: Option<String>,
    pub repo_path: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub detail: Option<String>,
    pub error_code: Option<String>,
}

impl Store {
    /// Journal an operation before it starts running.
    pub fn begin_operation(
        &self,
        id: &str,
        kind: &str,
        repo_id: Option<&str>,
        repo_path: Option<&str>,
    ) -> Result<(), StoreError> {
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO operations
                    (id, kind, state, repo_id, repo_path, started_at, updated_at)
                 VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?5)",
                params![id, kind, repo_id, repo_path, now],
            )?;
            Ok(())
        })
    }

    /// Finish an operation with a terminal state.
    pub fn finish_operation(
        &self,
        id: &str,
        state: OperationState,
        error_code: Option<&str>,
    ) -> Result<(), StoreError> {
        debug_assert!(state.is_terminal());
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE operations
                 SET state = ?2, finished_at = ?3, updated_at = ?3, error_code = ?4
                 WHERE id = ?1",
                params![id, state.as_str(), now, error_code],
            )?;
            Ok(())
        })
    }

    /// Attach a bounded, redacted detail to an operation.
    pub fn set_operation_detail(&self, id: &str, detail: &str) -> Result<(), StoreError> {
        let detail = beebranch_core::redaction::redact_bounded(detail, 16 * 1024);
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE operations SET detail = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, detail, beebranch_core::now_unix()],
            )?;
            Ok(())
        })
    }

    pub fn operation(&self, id: &str) -> Result<Option<OperationRecord>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, kind, state, repo_id, repo_path, started_at, updated_at,
                            finished_at, detail, error_code
                     FROM operations WHERE id = ?1",
                    params![id],
                    map_operation,
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn list_operations(&self, limit: u32) -> Result<Vec<OperationRecord>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, kind, state, repo_id, repo_path, started_at, updated_at,
                        finished_at, detail, error_code
                 FROM operations
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit.clamp(1, 1000)], map_operation)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        })
    }

    /// Startup recovery: mark every `running` operation as `interrupted` and
    /// return the operations that need attention. Locks are never removed.
    pub fn interrupt_running_operations(&self) -> Result<Vec<OperationRecord>, StoreError> {
        let now = beebranch_core::now_unix();
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE operations
                 SET state = 'interrupted', updated_at = ?1
                 WHERE state = 'running'",
                params![now],
            )?;
            let mut statement = connection.prepare(
                "SELECT id, kind, state, repo_id, repo_path, started_at, updated_at,
                        finished_at, detail, error_code
                 FROM operations
                 WHERE state = 'interrupted'
                 ORDER BY started_at DESC
                 LIMIT 200",
            )?;
            let rows = statement.query_map([], map_operation)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        })
    }
}

fn map_operation(row: &rusqlite::Row<'_>) -> rusqlite::Result<OperationRecord> {
    let state: String = row.get(2)?;
    Ok(OperationRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        state: OperationState::parse(&state),
        repo_id: row.get(3)?,
        repo_path: row.get(4)?,
        started_at: row.get(5)?,
        updated_at: row.get(6)?,
        finished_at: row.get(7)?,
        detail: row.get(8)?,
        error_code: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_roundtrip_and_recovery() {
        let store = Store::open_in_memory().expect("store");
        store
            .begin_operation("op_1", "fetch", Some("repo_1"), Some("/tmp/repo"))
            .expect("begin");
        let running = store.operation("op_1").expect("get").expect("found");
        assert_eq!(running.state, OperationState::Running);

        let interrupted = store.interrupt_running_operations().expect("recover");
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].state, OperationState::Interrupted);
        assert_eq!(interrupted[0].kind, "fetch");

        store
            .finish_operation("op_1", OperationState::Done, None)
            .expect("finish");
        let done = store.operation("op_1").expect("get").expect("found");
        assert_eq!(done.state, OperationState::Done);
        assert!(done.finished_at.is_some());
    }

    #[test]
    fn details_are_redacted() {
        let store = Store::open_in_memory().expect("store");
        store
            .begin_operation("op_1", "fetch", None, None)
            .expect("begin");
        store
            .set_operation_detail("op_1", "token glpat-secret")
            .expect("detail");
        let record = store.operation("op_1").expect("get").expect("found");
        assert_eq!(record.detail.as_deref(), Some("token ***"));
    }
}
