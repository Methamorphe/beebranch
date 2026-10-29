//! Types shared by BeeBranch.
//!
//! This crate stays free of I/O, process spawning and Tauri dependencies.
//! It owns identifiers, the error taxonomy, repository state, pagination and
//! the single redaction policy.

pub mod actions;
pub mod app;
pub mod error;
pub mod http_cache;
pub mod ids;
pub mod pagination;
pub mod redaction;
pub mod state;

pub use actions::{Confirmation, DestructiveAction};
pub use app::AppInfo;
pub use error::{classify_git_failure, AppError, ErrorCategory, MAX_DETAIL_BYTES};
pub use http_cache::{CachedResponse, ResponseCache};
pub use ids::{InstanceId, MergeRequestIid, OperationId, ProjectId, RepoId};
pub use pagination::{Page, PageRequest, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE};
pub use state::{
    ConflictSet, HeadState, InProgressOperation, RebaseVariant, RepoState, SequencerKind,
    WorktreeState,
};

/// Product name displayed by the application shell.
pub const APP_NAME: &str = "BeeBranch";

/// Version of the application crate.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Current UTC timestamp in seconds.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_app_identity() {
        assert_eq!(APP_NAME, "BeeBranch");
        assert!(!APP_VERSION.is_empty());
    }

    #[test]
    fn serializes_app_info_with_camel_case_keys() {
        let info = AppInfo {
            name: APP_NAME.to_owned(),
            version: APP_VERSION.to_owned(),
            platform: "test".to_owned(),
            arch: "test".to_owned(),
            data_dir: "/tmp/beebranch".to_owned(),
        };

        let json = serde_json::to_value(info).expect("serialize AppInfo");

        assert_eq!(json["dataDir"], "/tmp/beebranch");
        assert!(json.get("data_dir").is_none());
    }

    #[test]
    fn timestamps_are_plausible() {
        assert!(now_unix() > 1_700_000_000);
    }
}
