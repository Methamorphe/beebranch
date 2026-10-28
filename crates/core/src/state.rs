use serde::{Deserialize, Serialize};

/// State of `HEAD`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    Branch {
        name: String,
        upstream: Option<String>,
    },
    Detached {
        sha: String,
    },
    Unborn {
        branch: Option<String>,
    },
}

impl HeadState {
    pub fn is_detached(&self) -> bool {
        matches!(self, Self::Detached { .. })
    }
}

/// Interrupted or in-progress Git operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InProgressOperation {
    Merge,
    Rebase { variant: RebaseVariant },
    CherryPick,
    Revert,
    Sequencer { sequencer: SequencerKind },
    Bisect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseVariant {
    Merge,
    Apply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SequencerKind {
    CherryPick,
    Revert,
}

/// Files with unresolved conflicts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSet {
    pub files: Vec<String>,
}

impl ConflictSet {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// Working tree / index summary.
///
/// Counts are intentionally structural: the detailed file list is owned by the
/// status parser and is paginated separately.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeState {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

impl WorktreeState {
    pub fn is_clean(&self) -> bool {
        self.staged == 0 && self.unstaged == 0 && self.untracked == 0 && self.conflicted == 0
    }

    pub fn is_dirty(&self) -> bool {
        !self.is_clean()
    }
}

/// Full structural state of a repository worktree.
///
/// `operation` and `conflicts` are not mutually exclusive: a rebase can be in
/// progress with unresolved conflicts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub head: Option<HeadState>,
    pub operation: Option<InProgressOperation>,
    pub conflicts: ConflictSet,
    pub worktree: WorktreeState,
    pub sequencer: Option<SequencerKind>,
}

impl RepoState {
    pub fn has_intermediate_state(&self) -> bool {
        self.operation.is_some() || !self.conflicts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_and_dirty_are_derived_from_counts() {
        assert!(WorktreeState::default().is_clean());
        let dirty = WorktreeState {
            unstaged: 1,
            ..WorktreeState::default()
        };
        assert!(dirty.is_dirty());
        assert!(!dirty.is_clean());
    }

    #[test]
    fn operation_and_conflicts_coexist() {
        let state = RepoState {
            operation: Some(InProgressOperation::Rebase {
                variant: RebaseVariant::Merge,
            }),
            conflicts: ConflictSet {
                files: vec!["a.txt".into()],
            },
            ..RepoState::default()
        };
        assert!(state.has_intermediate_state());
    }

    #[test]
    fn serializes_as_tagged_union() {
        let state = RepoState {
            head: Some(HeadState::Detached { sha: "abc".into() }),
            ..RepoState::default()
        };
        let json = serde_json::to_value(state).expect("serialize");
        assert_eq!(json["head"]["kind"], "detached");
        assert_eq!(json["head"]["sha"], "abc");
    }
}
