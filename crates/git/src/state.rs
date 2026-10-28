//! Detection of intermediate Git states and stale lock files.

use std::path::{Path, PathBuf};

use beebranch_core::{
    AppError, ConflictSet, InProgressOperation, RebaseVariant, RepoState, SequencerKind,
};

use crate::discover::RepoDiscovery;
use crate::process::{CommandSpec, GitRunner};
use crate::status::{read_status, StatusReport};
use crate::GitSubcommand;

const MARKERS: &[&str] = &[
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_LOG",
    "BISECT_START",
    "index.lock",
    "HEAD.lock",
];

/// Detected state and the marker paths used to detect it.
#[derive(Debug, Clone)]
pub struct DetectedState {
    pub state: RepoState,
    pub status: StatusReport,
    /// Existing lock files (`index.lock`, `HEAD.lock`).
    pub locks: Vec<PathBuf>,
}

/// Read the structural state of a repository.
pub fn detect(
    runner: &GitRunner,
    discovery: &RepoDiscovery,
    max_status_entries: Option<usize>,
) -> Result<DetectedState, AppError> {
    let worktree = discovery.worktree()?;
    let status = read_status(runner, worktree, max_status_entries)?;
    let markers = resolve_markers(runner, worktree)?;

    let mut markers = markers;
    let merge = exists(&mut markers, "MERGE_HEAD");
    let cherry_pick = exists(&mut markers, "CHERRY_PICK_HEAD");
    let revert = exists(&mut markers, "REVERT_HEAD");
    let rebase_merge = exists(&mut markers, "rebase-merge");
    let rebase_apply = exists(&mut markers, "rebase-apply");
    let sequencer = exists(&mut markers, "sequencer");
    let bisect = exists(&mut markers, "BISECT_LOG") || exists(&mut markers, "BISECT_START");

    let operation = if rebase_merge {
        Some(InProgressOperation::Rebase {
            variant: RebaseVariant::Merge,
        })
    } else if rebase_apply {
        Some(InProgressOperation::Rebase {
            variant: RebaseVariant::Apply,
        })
    } else if cherry_pick {
        Some(InProgressOperation::CherryPick)
    } else if revert {
        Some(InProgressOperation::Revert)
    } else if sequencer {
        sequencer_kind(&markers["sequencer"])
            .map(|sequencer| InProgressOperation::Sequencer { sequencer })
    } else if bisect {
        Some(InProgressOperation::Bisect)
    } else if merge {
        Some(InProgressOperation::Merge)
    } else {
        None
    };

    let sequencer = if sequencer {
        sequencer_kind(&markers["sequencer"])
    } else {
        None
    };

    let mut state = RepoState {
        operation,
        sequencer,
        conflicts: ConflictSet {
            files: status.conflicts(),
        },
        ..RepoState::default()
    };
    crate::status::apply_to_state(&mut state, &status);

    let locks = ["index.lock", "HEAD.lock"]
        .iter()
        .filter_map(|name| {
            let path = markers.get(*name)?;
            path.exists().then(|| path.clone())
        })
        .collect();

    Ok(DetectedState {
        state,
        status,
        locks,
    })
}

fn resolve_markers(
    runner: &GitRunner,
    worktree: &Path,
) -> Result<std::collections::BTreeMap<String, PathBuf>, AppError> {
    let mut spec =
        CommandSpec::new(GitSubcommand::RevParse, worktree).arg("--path-format=absolute");
    for marker in MARKERS {
        spec = spec.arg("--git-path").arg(marker);
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    let output = outcome.stdout.text_lossy();
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() < MARKERS.len() {
        return Err(AppError::internal(
            "rev-parse --git-path n'a pas renvoyé tous les marqueurs",
        ));
    }
    Ok(MARKERS
        .iter()
        .zip(lines)
        .map(|(name, path)| ((*name).to_owned(), PathBuf::from(path)))
        .collect())
}

fn exists(markers: &mut std::collections::BTreeMap<String, PathBuf>, name: &str) -> bool {
    markers.get(name).is_some_and(|path| path.exists())
}

fn sequencer_kind(path: &Path) -> Option<SequencerKind> {
    let todo = path.join("todo");
    let content = std::fs::read_to_string(todo).ok()?;
    for line in content.lines() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("pick ") || line.starts_with("p ") {
            return Some(SequencerKind::CherryPick);
        }
        if line.starts_with("revert ") {
            return Some(SequencerKind::Revert);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sequencer_todo() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("todo"), "pick abc subject\n").expect("todo");
        assert_eq!(sequencer_kind(dir.path()), Some(SequencerKind::CherryPick));

        std::fs::write(dir.path().join("todo"), "revert abc subject\n").expect("todo");
        assert_eq!(sequencer_kind(dir.path()), Some(SequencerKind::Revert));

        std::fs::write(dir.path().join("todo"), "# comment only\n").expect("todo");
        assert_eq!(sequencer_kind(dir.path()), None);
    }
}
