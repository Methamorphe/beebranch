mod common;

use beebranch_git::branches;
use beebranch_git::commit::{self, CommitOptions};
use beebranch_git::diff::{read_diff, DiffLimits, DiffTarget};
use beebranch_git::history;
use beebranch_git::index::{self, HunkSelection, PathSelection};
use beebranch_git::stash;
use beebranch_git::sync::{self, PushRequest, SyncKind};
use beebranch_git::{CommandSpec, GitSubcommand};

use common::dirty_fixture;

/// One developer-day workflow without a terminal: branch, partial staging,
/// commit, push, review-ready branch, stash, merge with a conflict, resolution.
#[test]
fn full_daily_workflow_without_external_git_commands() {
    let fixture = dirty_fixture();
    let bare = tempfile::tempdir().expect("bare");
    fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Init, bare.path())
                .arg("--quiet")
                .arg("--bare"),
        )
        .expect("init")
        .ensure_success()
        .expect("bare");
    fixture.run(
        GitSubcommand::Remote,
        &["add", "origin", bare.path().to_str().unwrap()],
        &[],
    );
    fixture.run(GitSubcommand::Push, &["-u", "origin", "main"], &[]);

    // Branch and two independent changes.
    branches::create(
        fixture.runner(),
        fixture.path(),
        "feature/workflow",
        Some("main"),
        true,
    )
    .expect("create branch");
    fixture.write("a.txt", "line 1\nline 2 changed\nline 3\n");
    fixture.commit("other.txt", "other\n", "chore: other");
    fixture.write("a.txt", "line 1\nline 2 changed\nline 3\nline 4 added\n");
    // Stage only the second hunk (the added line) then whole file.
    let working = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::WorkingTree,
        &["a.txt".to_owned()],
        DiffLimits::default(),
    )
    .expect("diff");
    let hunk = working.files[0]
        .hunks
        .iter()
        .position(|hunk| hunk.new_lines > 0)
        .expect("hunk");
    index::stage(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "a.txt".into(),
            hunks: vec![HunkSelection { hunk, lines: None }],
        }],
    )
    .expect("stage hunk");
    let first_commit = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "feat: workflow\n\nPartial staging and hookless commit".into(),
            ..CommitOptions::default()
        },
    )
    .expect("commit");
    assert_eq!(fixture.detect().worktree.staged, 0);

    // Push the feature branch, then stash unrelated work.
    fixture.write("scratch.txt", "temporary\n");
    stash::create(fixture.runner(), fixture.path(), "wip scratch", true).expect("stash");
    assert_eq!(fixture.detect().worktree.untracked, 0);
    let stash_entry = stash::list(fixture.runner(), fixture.path())
        .expect("list")
        .remove(0);
    stash::apply(fixture.runner(), fixture.path(), &stash_entry.selector).expect("apply");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("scratch.txt")).unwrap(),
        "temporary\n"
    );

    let command = sync::spawn_push(
        fixture.runner(),
        fixture.path(),
        &PushRequest {
            remote: "origin".into(),
            branch: "feature/workflow".into(),
            set_upstream: true,
            force_with_lease: None,
        },
        &beebranch_git::OperationContext::default(),
        |_| {},
    )
    .expect("push");
    sync::finish(command, SyncKind::Push, || None).expect("push done");

    // Main moves concurrently and conflicts with the feature branch.
    fixture.switch("main");
    fixture.commit("a.txt", "line 1\nmain change\nline 3\n", "fix: main change");
    fixture.switch("feature/workflow");
    let outcome = history::merge(fixture.runner(), fixture.path(), "main", false).expect("merge");
    assert!(outcome.conflicted);
    fixture.write("a.txt", "line 1\nresolved\nline 3\nline 4 added\n");
    history::mark_resolved(fixture.runner(), fixture.path(), "a.txt").expect("resolve");
    let merged = history::continue_operation(fixture.runner(), fixture.path()).expect("continue");
    assert!(merged.state.operation.is_none());
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "line 1\nresolved\nline 3\nline 4 added\n"
    );

    // The pushed feature tip is still the pre-merge commit; no force push.
    let remote_sha = sync::remote_branch_sha(
        fixture.runner(),
        fixture.path(),
        "origin",
        "feature/workflow",
    )
    .expect("remote branch");
    assert_eq!(remote_sha, first_commit.sha);

    // Fetch remains available and leaves a valid repository.
    let fetch = sync::spawn_fetch(
        fixture.runner(),
        fixture.path(),
        "origin",
        &beebranch_git::OperationContext::default(),
        |_| {},
    )
    .expect("fetch");
    sync::finish(fetch, SyncKind::Fetch, || None).expect("fetch done");
    assert!(fixture.detect().conflicts.is_empty());
}
