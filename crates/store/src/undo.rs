//! Durable undo/redo journal.
//!
//! The journal stores typed inverse payloads and fingerprints as JSON. It
//! stores no working-tree file, index copy or blob: Git remains the only
//! backup mechanism.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::StoreError;
use crate::Store;

/// Hard stack bound per repository.
pub const UNDO_LIMIT: i64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UndoState {
    /// Can be undone.
    Available,
    /// Has been undone and can be redone.
    Consumed,
    /// An undo/redo is currently executing.
    Restoring,
    /// The inverse failed; the record carries the step, command and SHA.
    RestoreFailed,
    /// The process died during restoration. Never retried automatically.
    RestoreInterrupted,
    /// Outside the redo/undo window, or redo invalidated by a new operation.
    Evicted,
}

impl UndoState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Consumed => "consumed",
            Self::Restoring => "restoring",
            Self::RestoreFailed => "restoreFailed",
            Self::RestoreInterrupted => "restoreInterrupted",
            Self::Evicted => "evicted",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "available" => Self::Available,
            "consumed" => Self::Consumed,
            "restoring" => Self::Restoring,
            "restoreFailed" => Self::RestoreFailed,
            "restoreInterrupted" => Self::RestoreInterrupted,
            _ => Self::Evicted,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRecord {
    pub id: String,
    pub repo_id: String,
    pub position: i64,
    pub kind: String,
    pub label: String,
    pub undo_json: String,
    pub redo_json: Option<String>,
    pub before_json: String,
    pub after_json: String,
    pub touched_refs_json: String,
    pub state: UndoState,
    pub step: Option<String>,
    pub command: Option<String>,
    pub detail: Option<String>,
    pub recovery_sha: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input of a new record, produced by the application layer.
#[derive(Debug, Clone)]
pub struct NewUndoRecord<'a> {
    pub repo_id: &'a str,
    pub kind: &'a str,
    pub label: &'a str,
    pub undo_json: &'a str,
    pub redo_json: Option<&'a str>,
    pub before_json: &'a str,
    pub after_json: &'a str,
    pub touched_refs_json: &'a str,
}

impl Store {
    /// Append a record, invalidating any redo branch, then enforce the bound.
    pub fn record_undo(&self, input: NewUndoRecord<'_>) -> Result<UndoRecord, StoreError> {
        let now = beebranch_core::now_unix();
        let id = unique_id(now);
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            let position: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM undo_records WHERE repo_id = ?1",
                params![input.repo_id],
                |row| row.get(0),
            )?;
            // A new operation invalidates the redo branch.
            transaction.execute(
                "UPDATE undo_records SET state = 'evicted', updated_at = ?2
                 WHERE repo_id = ?1 AND state = 'consumed'",
                params![input.repo_id, now],
            )?;
            transaction.execute(
                "INSERT INTO undo_records
                    (id, repo_id, position, kind, label, undo_json, redo_json,
                     before_json, after_json, touched_refs, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'available', ?11, ?11)",
                params![
                    id,
                    input.repo_id,
                    position,
                    input.kind,
                    input.label,
                    input.undo_json,
                    input.redo_json,
                    input.before_json,
                    input.after_json,
                    input.touched_refs_json,
                    now,
                ],
            )?;
            transaction.execute(
                "UPDATE undo_records SET state = 'evicted', updated_at = ?2
                 WHERE repo_id = ?1 AND state IN ('available', 'consumed')
                   AND id NOT IN (
                     SELECT id FROM undo_records WHERE repo_id = ?1
                     ORDER BY position DESC LIMIT ?3
                   )",
                params![input.repo_id, now, UNDO_LIMIT],
            )?;
            transaction.commit()?;
            self.get_undo_locked(connection, &id)
        })
    }

    pub fn undo_record(&self, id: &str) -> Result<Option<UndoRecord>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                            before_json, after_json, touched_refs, state, step, command,
                            detail, recovery_sha, created_at, updated_at
                     FROM undo_records WHERE id = ?1",
                    params![id],
                    map_record,
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn list_undo(&self, repo_id: &str, limit: u32) -> Result<Vec<UndoRecord>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                        before_json, after_json, touched_refs, state, step, command,
                        detail, recovery_sha, created_at, updated_at
                 FROM undo_records WHERE repo_id = ?1
                 ORDER BY position DESC LIMIT ?2",
            )?;
            let rows = statement.query_map(params![repo_id, limit.clamp(1, 200)], map_record)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        })
    }

    pub fn latest_undo(
        &self,
        repo_id: &str,
        state: UndoState,
    ) -> Result<Option<UndoRecord>, StoreError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                            before_json, after_json, touched_refs, state, step, command,
                            detail, recovery_sha, created_at, updated_at
                     FROM undo_records
                     WHERE repo_id = ?1 AND state = ?2
                     ORDER BY position DESC LIMIT 1",
                    params![repo_id, state.as_str()],
                    map_record,
                )
                .optional()
                .map_err(StoreError::from)
        })
    }

    pub fn set_undo_state(
        &self,
        id: &str,
        state: UndoState,
        step: Option<&str>,
        command: Option<&str>,
        detail: Option<&str>,
        recovery_sha: Option<&str>,
    ) -> Result<(), StoreError> {
        let detail =
            detail.map(|value| beebranch_core::redaction::redact_bounded(value, 16 * 1024));
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE undo_records
                 SET state = ?2, step = ?3, command = ?4, detail = ?5,
                     recovery_sha = ?6, updated_at = ?7
                 WHERE id = ?1",
                params![
                    id,
                    state.as_str(),
                    step,
                    command,
                    detail,
                    recovery_sha,
                    beebranch_core::now_unix(),
                ],
            )?;
            Ok(())
        })
    }

    /// Startup recovery: a restoration interrupted by a crash is surfaced and
    /// never retried silently.
    pub fn interrupt_restoring_undo(&self) -> Result<Vec<UndoRecord>, StoreError> {
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE undo_records SET state = 'restoreInterrupted', updated_at = ?1
                 WHERE state = 'restoring'",
                params![beebranch_core::now_unix()],
            )?;
            let mut statement = connection.prepare(
                "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                        before_json, after_json, touched_refs, state, step, command,
                        detail, recovery_sha, created_at, updated_at
                 FROM undo_records WHERE state = 'restoreInterrupted'
                 ORDER BY updated_at DESC LIMIT 100",
            )?;
            let rows = statement.query_map([], map_record)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        })
    }

    /// Failed or interrupted restorations across repositories.
    pub fn list_failed_undo(&self, limit: u32) -> Result<Vec<UndoRecord>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                        before_json, after_json, touched_refs, state, step, command,
                        detail, recovery_sha, created_at, updated_at
                 FROM undo_records
                 WHERE state IN ('restoreFailed', 'restoreInterrupted')
                 ORDER BY updated_at DESC LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit.clamp(1, 200)], map_record)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            Ok(records)
        })
    }

    fn get_undo_locked(
        &self,
        connection: &rusqlite::Connection,
        id: &str,
    ) -> Result<UndoRecord, StoreError> {
        connection
            .query_row(
                "SELECT id, repo_id, position, kind, label, undo_json, redo_json,
                        before_json, after_json, touched_refs, state, step, command,
                        detail, recovery_sha, created_at, updated_at
                 FROM undo_records WHERE id = ?1",
                params![id],
                map_record,
            )
            .map_err(StoreError::from)
    }
}

fn unique_id(now: i64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("undo_{now:x}_{counter:x}")
}

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<UndoRecord> {
    let state: String = row.get(10)?;
    Ok(UndoRecord {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        position: row.get(2)?,
        kind: row.get(3)?,
        label: row.get(4)?,
        undo_json: row.get(5)?,
        redo_json: row.get(6)?,
        before_json: row.get(7)?,
        after_json: row.get(8)?,
        touched_refs_json: row.get(9)?,
        state: UndoState::parse(&state),
        step: row.get(11)?,
        command: row.get(12)?,
        detail: row.get(13)?,
        recovery_sha: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(store: &Store, repo: &str, kind: &str) -> UndoRecord {
        store
            .record_undo(NewUndoRecord {
                repo_id: repo,
                kind,
                label: kind,
                undo_json: "{}",
                redo_json: Some("{}"),
                before_json: "{}",
                after_json: "{}",
                touched_refs_json: "[]",
            })
            .expect("record")
    }

    #[test]
    fn records_are_lifo_and_a_new_operation_invalidates_redo() {
        let store = Store::open_in_memory().expect("store");
        let first = record(&store, "repo", "commit");
        let second = record(&store, "repo", "branch");
        assert_eq!(second.position, first.position + 1);
        store
            .set_undo_state(&second.id, UndoState::Consumed, None, None, None, None)
            .expect("consume");
        let latest = store
            .latest_undo("repo", UndoState::Consumed)
            .expect("latest")
            .expect("record");
        assert_eq!(latest.id, second.id);

        let third = record(&store, "repo", "tag");
        let redo = store
            .latest_undo("repo", UndoState::Consumed)
            .expect("redo");
        assert!(redo.is_none(), "a new operation must invalidate redo");
        assert!(third.position > second.position);
    }

    #[test]
    fn stack_is_bounded_to_fifty_and_failures_survive() {
        let store = Store::open_in_memory().expect("store");
        for index in 0..55 {
            let item = record(&store, "repo", "commit");
            if index == 54 {
                store
                    .set_undo_state(
                        &item.id,
                        UndoState::RestoreFailed,
                        Some("restore-head"),
                        Some("git reset --hard abc"),
                        Some("failure"),
                        Some("abc"),
                    )
                    .expect("fail");
            }
        }
        let records = store.list_undo("repo", 100).expect("list");
        assert_eq!(records.len(), 55);
        let available = records
            .iter()
            .filter(|record| record.state == UndoState::Available)
            .count();
        assert_eq!(available, 49, "50 slots minus the failed record");
        let failed = store.list_failed_undo(10).expect("failed");
        assert_eq!(failed.len(), 1);
    }

    #[test]
    fn interrupted_restorations_are_surfaced_once() {
        let store = Store::open_in_memory().expect("store");
        let item = record(&store, "repo", "commit");
        store
            .set_undo_state(&item.id, UndoState::Restoring, None, None, None, None)
            .expect("restoring");
        let interrupted = store.interrupt_restoring_undo().expect("interrupt");
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].state, UndoState::RestoreInterrupted);
        // Idempotent: an already-interrupted restoration stays visible.
        assert_eq!(store.interrupt_restoring_undo().expect("second").len(), 1);
    }
}
