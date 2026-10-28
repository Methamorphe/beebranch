//! Git engine.
//!
//! This crate is the only owner of the `git` process. It provides the process
//! layer (allowlisted argv, controlled environment, bounded capture,
//! streaming, cancellation), capability detection, repository discovery,
//! state detection, the read model (refs, status, log, commit, diff), lane
//! computation and the per-repository session with its mutation queue and
//! watcher.

mod allowlist;
pub mod blame;
pub mod branches;
pub mod capability;
pub mod clone;
pub mod commit;
pub mod conflict;
pub mod diff;
pub mod discover;
mod environment;
mod error;
mod exec;
pub mod graph;
pub mod history;
pub mod index;
pub mod integration;
pub mod log;
pub mod patch;
pub mod process;
mod program;
pub mod redaction;
pub mod refs;
pub mod refs_admin;
pub mod search;
pub mod session;
pub mod stash;
pub mod state;
pub mod status;
pub mod submodule;
pub mod sync;
pub mod undo;
pub mod worktree;

pub use allowlist::GitSubcommand;
pub use capability::{
    DetectOptions, GitCapability, GitFeatures, GitVersion, LfsCapability, MINIMUM_GIT_VERSION,
};
pub use error::{GitError, GitErrorCode};
pub use process::{
    CaptureLimits, CaptureMode, CapturePolicy, Captured, CommandOutcome, CommandSpec, GitRunner,
    OperationContext, ProcessEvent, RunningCommand, StdinMode,
};
pub use program::GitProgram;
pub use redaction::{redact, redact_bytes};
pub use session::{ChangeSink, RepoChange, RepoSession, SessionOptions, SessionRegistry};
