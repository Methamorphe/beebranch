mod common;

use std::path::PathBuf;

use beebranch_core::{HeadState, InProgressOperation, RebaseVariant};
use beebranch_git::discover::discover;
use beebranch_git::session::{RepoSession, SessionOptions};
use beebranch_git::state::detect;
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand};

use common::{dirty_fixture, Fixture};

#[test]
fn discovers_worktree_and_git_directories() {
    let fixture = dirty_fixture();
    let discovery = fixture.discover();
    assert!(!discovery.bare);
    assert!(discovery.inside_worktree);
    assert!(!discovery.linked_worktree);
    assert!(!discovery.submodule);
    let canonical = std::fs::canonicalize(fixture.path()).expect("canonical");
    assert_eq!(discovery.worktree, Some(canonical));
    assert!(discovery.git_dir.ends_with(".git"));
}

#[test]
fn rejects_non_repository_paths_with_a_stable_code() {
    let runner = GitRunner::detect().expect("git");
    let dir = tempfile::tempdir().expect("tempdir");
    let error = discover(&runner, dir.path()).expect_err("must reject");
    assert_eq!(error.code, "repo.not_git");
}

#[test]
fn detects_linked_worktrees() {
    let fixture = dirty_fixture();
    fixture.branch("feature");
    let worktree = tempfile::tempdir().expect("worktree");
    let worktree_path = worktree.path().join("wt");
    fixture.run(
        GitSubcommand::Worktree,
        &["add", worktree_path.to_str().unwrap(), "feature"],
        &[],
    );

    let discovery = discover(fixture.runner(), &worktree_path).expect("discover worktree");
    assert!(discovery.linked_worktree);
    assert_eq!(discovery.common_dir, fixture.discover().common_dir);

    let session = RepoSession::open(fixture.runner(), &worktree_path, SessionOptions::default())
        .expect("session");
    assert_eq!(session.state().worktree.untracked, 0);
    session.shutdown();
}

#[test]
fn detects_detached_head_and_unborn_repository() {
    let fixture = dirty_fixture();
    let sha = fixture.rev_parse(&["HEAD"]);
    fixture.run(GitSubcommand::Switch, &["--detach", &sha], &[]);
    let state = fixture.detect();
    assert!(matches!(state.head, Some(HeadState::Detached { .. })));

    let unborn = Fixture::new();
    unborn.init();
    let state = unborn.detect();
    assert!(matches!(state.head, Some(HeadState::Unborn { .. })));
}

#[test]
fn detects_merge_conflicts_without_resolving_them() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");

    let merge = CommandSpec::new(GitSubcommand::Merge, fixture.path()).arg("feature");
    let outcome = fixture.runner().run(&merge).expect("merge");
    assert!(!outcome.success(), "merge should conflict");

    let state = fixture.detect();
    assert!(matches!(state.operation, Some(InProgressOperation::Merge)));
    assert_eq!(state.conflicts.files, vec!["a.txt"]);
    assert_eq!(state.worktree.conflicted, 1);
}

#[test]
fn detects_rebase_in_progress() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");

    let rebase = CommandSpec::new(GitSubcommand::Rebase, fixture.path()).arg("feature");
    let outcome = fixture.runner().run(&rebase).expect("rebase");
    assert!(!outcome.success(), "rebase should conflict");

    let state = fixture.detect();
    assert!(matches!(
        state.operation,
        Some(InProgressOperation::Rebase {
            variant: RebaseVariant::Merge | RebaseVariant::Apply
        })
    ));
    assert!(!state.conflicts.files.is_empty());
}

#[test]
fn detects_new_commits_and_dirty_files() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "changed\n");
    fixture.write("new.txt", "untracked\n");
    let state = fixture.detect();
    assert_eq!(state.worktree.unstaged, 1);
    assert_eq!(state.worktree.untracked, 1);
    assert!(matches!(
        state.head,
        Some(HeadState::Branch { ref name, .. }) if name == "main"
    ));
}

#[test]
fn detects_submodules() {
    std::env::set_var("GIT_ALLOW_PROTOCOL", "file");
    let child = dirty_fixture();
    let parent = dirty_fixture();
    parent.run(
        GitSubcommand::Submodule,
        &["add", child.path().to_str().unwrap(), "deps/child"],
        &[],
    );
    parent.commit("root.txt", "root\n", "add submodule");

    let discovery =
        discover(parent.runner(), parent.path().join("deps/child")).expect("discover submodule");
    assert!(discovery.submodule);
    assert!(discovery.superproject.is_some());

    let parent_discovery = parent.discover();
    assert!(!parent_discovery.submodule);
}

#[test]
fn locks_are_reported_and_never_removed() {
    let fixture = dirty_fixture();
    let lock = fixture.path().join(".git/index.lock");
    std::fs::write(&lock, b"lock").expect("lock");
    let detected = detect(fixture.runner(), &fixture.discover(), Some(100)).expect("detect");
    let expected = std::fs::canonicalize(&lock).expect("canonical lock");
    assert_eq!(detected.locks, vec![expected]);
    assert!(lock.exists(), "lock must never be removed automatically");
}

#[test]
fn state_without_conflict_has_no_intermediate_operation() {
    let fixture = dirty_fixture();
    let state = fixture.detect();
    assert!(state.operation.is_none());
    assert!(state.conflicts.files.is_empty());
}

#[test]
fn path_helpers_accept_absolute_and_reject_missing() {
    let fixture = dirty_fixture();
    assert!(fixture.discover().worktree.is_some());
    let missing = PathBuf::from("/definitely/missing/repo");
    let error = discover(fixture.runner(), &missing).expect_err("missing");
    assert_eq!(error.code, "repo.not_git");
}
