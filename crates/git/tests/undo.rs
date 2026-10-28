mod common;

use std::path::Path;

use beebranch_git::undo::{self, Fingerprint, HeadTarget, RestoreMode, ReversibleAction};
use beebranch_git::{refs_admin, CommandSpec, GitSubcommand};
use common::Fixture;

fn capture(fixture: &Fixture, refs: &[&str], files: &[&str]) -> Fingerprint {
    let discovery = fixture.discover();
    undo::capture(
        fixture.runner(),
        &discovery,
        &refs
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
        &files
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
    )
    .expect("capture")
}

fn apply(fixture: &Fixture, action: &ReversibleAction) {
    let discovery = fixture.discover();
    undo::apply(fixture.runner(), &discovery, action, &mut |_| Ok(())).expect("apply inverse");
}

fn head(fixture: &Fixture) -> String {
    fixture.rev_parse(&["--verify", "HEAD"])
}

fn current_branch(fixture: &Fixture) -> String {
    fixture.rev_parse(&["--abbrev-ref", "HEAD"])
}

fn status(fixture: &Fixture) -> String {
    let spec = CommandSpec::new(GitSubcommand::Status, fixture.path())
        .arg("--porcelain=v2")
        .arg("-z");
    let outcome = fixture.runner().run(&spec).expect("status");
    String::from_utf8_lossy(outcome.stdout.bytes()).into_owned()
}

#[test]
fn commit_undo_restores_head_index_and_redo_restores_commit() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.write("a.txt", "staged\n");
    fixture.run(GitSubcommand::Add, &["a.txt"], &[]);
    fixture.write("b.txt", "untracked\n");
    let before = capture(&fixture, &[], &["a.txt"]);
    let committed = fixture.commit_staged("second");
    let after = capture(&fixture, &[], &["a.txt"]);
    assert!(before.status_hash != after.status_hash);

    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&before),
            sha: before.head_sha.clone(),
            mode: RestoreMode::Soft,
            index_tree: before.index_tree.clone(),
        },
    );
    let restored = capture(&fixture, &[], &["a.txt"]);
    assert_eq!(restored.head_sha, before.head_sha);
    assert_eq!(restored.index_tree, before.index_tree);
    assert_eq!(restored.status_hash, before.status_hash);
    assert!(
        fixture.path().join("b.txt").exists(),
        "untracked is preserved"
    );

    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&after),
            sha: after.head_sha.clone(),
            mode: RestoreMode::Soft,
            index_tree: after.index_tree.clone(),
        },
    );
    assert_eq!(head(&fixture), committed);
    let redone = capture(&fixture, &[], &["a.txt"]);
    assert_eq!(redone.status_hash, after.status_hash);
}

#[test]
fn amend_undo_restores_the_previous_commit_object() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "first");
    let original = head(&fixture);
    fixture.write("a.txt", "amended\n");
    fixture.run(GitSubcommand::Add, &["a.txt"], &[]);
    let before = capture(&fixture, &[], &["a.txt"]);
    fixture.run(GitSubcommand::Commit, &["--amend", "-F", "-"], b"amended\n");
    let amended = head(&fixture);
    assert_ne!(original, amended);
    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&before),
            sha: before.head_sha.clone(),
            mode: RestoreMode::Soft,
            index_tree: before.index_tree.clone(),
        },
    );
    assert_eq!(head(&fixture), original);
    let restored = capture(&fixture, &[], &["a.txt"]);
    assert_eq!(restored.index_tree, before.index_tree);
    assert_eq!(restored.status_hash, before.status_hash);
}

#[test]
fn checkout_undo_restores_branch_and_detached_head() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    let feature = head(&fixture);
    fixture.switch(&main);
    let main_sha = head(&fixture);

    let before = capture(&fixture, &[], &[]);
    fixture.switch("feature");
    let after = capture(&fixture, &[], &[]);
    apply(
        &fixture,
        &ReversibleAction::Checkout {
            target: undo::head_target(&before),
        },
    );
    assert_eq!(head(&fixture), main_sha);
    apply(
        &fixture,
        &ReversibleAction::Checkout {
            target: undo::head_target(&after),
        },
    );
    assert_eq!(head(&fixture), feature);

    fixture.run(GitSubcommand::Switch, &["--detach", &main_sha], &[]);
    let detached = capture(&fixture, &[], &[]);
    fixture.run(GitSubcommand::Switch, &["--detach", &feature], &[]);
    apply(
        &fixture,
        &ReversibleAction::Checkout {
            target: undo::head_target(&detached),
        },
    );
    assert_eq!(head(&fixture), main_sha);
    assert!(detached.detached);
}

#[test]
fn branch_create_delete_and_rename_are_reversible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let base = head(&fixture);
    let reference = "refs/heads/feature".to_owned();

    let before = capture(&fixture, &[&reference], &[]);
    fixture.run(GitSubcommand::Branch, &["feature"], &[]);
    let after = capture(&fixture, &[&reference], &[]);
    apply(
        &fixture,
        &ReversibleAction::DeleteRef {
            reference: reference.clone(),
            expected: after.refs[&reference].clone(),
        },
    );
    assert!(!fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, fixture.path())
                .arg("--verify")
                .arg("--quiet")
                .arg(&reference)
        )
        .expect("rev-parse")
        .success());

    apply(
        &fixture,
        &ReversibleAction::CreateRef {
            reference: reference.clone(),
            sha: base.clone(),
            upstream: None,
        },
    );
    assert!(fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, fixture.path())
                .arg("--verify")
                .arg(&reference)
        )
        .expect("rev-parse")
        .success());

    apply(
        &fixture,
        &ReversibleAction::RenameRef {
            from: "feature".to_owned(),
            to: "renamed".to_owned(),
        },
    );
    assert!(fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, fixture.path())
                .arg("--verify")
                .arg("refs/heads/renamed")
        )
        .expect("rev-parse")
        .success());
    apply(
        &fixture,
        &ReversibleAction::RenameRef {
            from: "renamed".to_owned(),
            to: "feature".to_owned(),
        },
    );
    assert!(before.refs[&reference] != after.refs[&reference] || after.refs[&reference] == base);
}

#[test]
fn tag_creation_and_deletion_are_reversible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let before = capture(&fixture, &["refs/tags/v1"], &[]);
    let tag = refs_admin::create_tag(
        fixture.runner(),
        fixture.path(),
        "v1",
        Some("release"),
        None,
        false,
    )
    .expect("tag");
    let after = capture(&fixture, &["refs/tags/v1"], &[]);
    apply(
        &fixture,
        &ReversibleAction::DeleteTag {
            name: "v1".to_owned(),
            expected: tag.oid.clone(),
        },
    );
    assert_eq!(
        capture(&fixture, &["refs/tags/v1"], &[]).refs["refs/tags/v1"],
        "absent"
    );
    apply(
        &fixture,
        &ReversibleAction::CreateTag {
            name: "v1".to_owned(),
            object: tag.target_oid.clone().unwrap_or_else(|| tag.oid.clone()),
            message: tag.message.clone(),
            tagger: tag.tagger.clone(),
            tagger_email: tag.tagger_email.clone(),
            tagger_time: tag.tagger_time,
        },
    );
    let restored = refs_admin::list_tags(fixture.runner(), fixture.path()).expect("tags");
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].message.as_deref(), Some("release"));
    assert_eq!(
        restored[0].tagger_email.as_deref(),
        Some("alice@example.test")
    );
    assert!(after.refs["refs/tags/v1"] != before.refs["refs/tags/v1"]);
}

#[test]
fn remote_add_and_remove_are_reversible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    fixture.run(
        GitSubcommand::Remote,
        &["add", "origin", "https://example.test/team/repo.git"],
        &[],
    );
    let (urls, push, fetch) =
        undo::remote_config(fixture.runner(), fixture.path(), "origin").expect("config");
    apply(
        &fixture,
        &ReversibleAction::RemoveRemote {
            name: "origin".to_owned(),
            expected_urls: urls.clone(),
        },
    );
    assert!(fixture
        .runner()
        .run(&CommandSpec::new(GitSubcommand::Remote, fixture.path()).arg("-v"))
        .expect("remote")
        .stdout
        .is_empty());
    apply(
        &fixture,
        &ReversibleAction::AddRemote {
            name: "origin".to_owned(),
            urls: urls.clone(),
            push_urls: push,
            fetch,
        },
    );
    let restored = refs_admin::list_remotes(fixture.runner(), fixture.path()).expect("remotes");
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].name, "origin");
}

#[test]
fn conflicted_merge_is_undone_by_a_typed_abort() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.run(GitSubcommand::Branch, &["other"], &[]);
    fixture.write("a.txt", "main\n");
    fixture.add_all();
    fixture.commit_staged("main");
    fixture.switch("other");
    fixture.write("a.txt", "other\n");
    fixture.add_all();
    fixture.commit_staged("other");
    fixture.switch(&main);
    let spec = CommandSpec::new(GitSubcommand::Merge, fixture.path())
        .arg("--no-edit")
        .arg("other");
    let outcome = fixture.runner().run(&spec).expect("merge");
    assert!(!outcome.success());
    let state = fixture.detect();
    let operation = state.operation.expect("merge in progress");
    apply(&fixture, &ReversibleAction::AbortOperation { operation });
    assert!(fixture.detect().operation.is_none());
    assert_eq!(status(&fixture).trim(), "");
}

#[test]
fn a_conflicted_branch_drop_is_undone_by_abort_then_checkout() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch(&main);
    fixture.commit("a.txt", "main\n", "main");
    let before = capture(&fixture, &[], &[]);

    let spec = CommandSpec::new(GitSubcommand::Merge, fixture.path())
        .arg("--no-edit")
        .arg("feature");
    let outcome = fixture.runner().run(&spec).expect("merge");
    assert!(!outcome.success());
    let operation = fixture.detect().operation.expect("merge in progress");
    let action = ReversibleAction::Sequence {
        actions: vec![
            ReversibleAction::AbortOperation { operation },
            ReversibleAction::Checkout {
                target: undo::head_target(&before),
            },
        ],
    };
    let discovery = fixture.discover();
    undo::ensure_restorable(fixture.runner(), &discovery, &action).expect("abort is allowed");
    undo::apply(fixture.runner(), &discovery, &action, &mut |_| Ok(())).expect("undo");
    let restored = capture(&fixture, &[], &[]);
    assert_eq!(restored.head_sha, before.head_sha);
    assert_eq!(restored.status_hash, before.status_hash);
}

#[test]
fn completed_merge_undoes_to_a_clean_before_state_and_preserves_untracked() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.run(GitSubcommand::Branch, &["other"], &[]);
    fixture.switch("other");
    fixture.write("b.txt", "other\n");
    fixture.add_all();
    fixture.commit_staged("other");
    fixture.switch(&main);
    fixture.write("untracked.txt", "keep me\n");
    let before = capture(&fixture, &[], &[]);
    fixture.run(
        GitSubcommand::Merge,
        &["--no-ff", "--no-edit", "other"],
        &[],
    );
    let after = capture(&fixture, &[], &[]);
    assert_ne!(before.head_sha, after.head_sha);
    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&before),
            sha: before.head_sha.clone(),
            mode: RestoreMode::Hard,
            index_tree: before.index_tree.clone(),
        },
    );
    assert_eq!(head(&fixture), before.head_sha.clone().unwrap());
    assert!(!fixture.path().join("b.txt").exists());
    assert!(fixture.path().join("untracked.txt").exists());
    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&after),
            sha: after.head_sha.clone(),
            mode: RestoreMode::Hard,
            index_tree: after.index_tree.clone(),
        },
    );
    assert_eq!(head(&fixture), after.head_sha.clone().unwrap());
}

#[test]
fn a_changed_worktree_or_head_invalidates_the_fingerprint() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let before = capture(&fixture, &[], &["a.txt"]);
    fixture.write("a.txt", "two\n");
    let current = capture(&fixture, &[], &["a.txt"]);
    let reason = Fingerprint::compare(&before, &current).expect_err("changed file");
    assert!(reason.contains("worktree") || reason.contains("a.txt"));
    fixture.add_all();
    fixture.commit_staged("two");
    let after_commit = capture(&fixture, &[], &["a.txt"]);
    assert!(Fingerprint::compare(&before, &after_commit).is_err());
    assert!(Fingerprint::compare(&after_commit, &after_commit).is_ok());
}

#[test]
fn stash_creation_restores_the_dirty_worktree_and_drops_only_after_exact_apply() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.write("a.txt", "dirty\n");
    let before = capture(&fixture, &["refs/stash"], &["a.txt"]);
    fixture.run(
        GitSubcommand::Stash,
        &["push", "-m", "work in progress"],
        &[],
    );
    let entry = beebranch_git::stash::list(fixture.runner(), fixture.path())
        .expect("stash list")
        .into_iter()
        .next()
        .expect("stash");
    apply(
        &fixture,
        &ReversibleAction::ApplyStash {
            selector: entry.selector.clone(),
            expected_sha: entry.sha.clone(),
            drop: true,
            expected_status_hash: Some(before.status_hash.clone()),
        },
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).expect("read"),
        "dirty\n"
    );
    assert!(beebranch_git::stash::list(fixture.runner(), fixture.path())
        .expect("stash list")
        .is_empty());
    let restored = capture(&fixture, &["refs/stash"], &["a.txt"]);
    assert_eq!(restored.status_hash, before.status_hash);
}

#[test]
fn worktree_add_and_remove_are_reversible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    fixture.run(GitSubcommand::Branch, &["feature"], &[]);
    let target = fixture.path().join("wt-feature");
    let path = target.display().to_string();
    apply(
        &fixture,
        &ReversibleAction::AddWorktree {
            path: path.clone(),
            reference: "feature".to_owned(),
            new_branch: None,
            detach: false,
        },
    );
    assert!(target.exists());
    apply(
        &fixture,
        &ReversibleAction::RemoveWorktree {
            path: path.clone(),
            force: false,
        },
    );
    assert!(!target.exists());
}

#[test]
fn a_failure_reports_the_step_and_leaves_a_reflog_recovery_sha() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let before = capture(&fixture, &[], &[]);
    fixture.commit("a.txt", "two\n", "two");
    let after = capture(&fixture, &[], &[]);
    let discovery = fixture.discover();
    let failure = undo::apply(
        fixture.runner(),
        &discovery,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&before),
            sha: before.head_sha.clone(),
            mode: RestoreMode::Soft,
            index_tree: before.index_tree.clone(),
        },
        &mut |step| {
            if step.step == "restore-index" {
                Err(beebranch_core::AppError::new(
                    "test.injected",
                    beebranch_core::ErrorCategory::Internal,
                    "injected",
                ))
            } else {
                Ok(())
            }
        },
    )
    .expect_err("injected failure");
    assert_eq!(failure.step, "restore-index");
    assert!(failure.command.starts_with("git read-tree"));
    assert!(failure.sha.is_some());
    assert_eq!(head(&fixture), before.head_sha.clone().unwrap());
    assert_eq!(
        after.head_sha.clone().unwrap(),
        after.head_sha.clone().unwrap()
    );
}

#[test]
fn only_the_worktree_is_written_by_the_application() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "one");
    let before = capture(&fixture, &[], &[]);
    fixture.commit("a.txt", "two\n", "two");
    apply(
        &fixture,
        &ReversibleAction::RestoreHead {
            target: undo::head_target(&before),
            sha: before.head_sha.clone(),
            mode: RestoreMode::Soft,
            index_tree: before.index_tree.clone(),
        },
    );
    // No application backup file may appear anywhere in the repository.
    let entries = std::fs::read_dir(fixture.path())
        .expect("read")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(!entries.iter().any(|name| name.contains("backup")));
}

#[test]
fn detached_target_is_accepted_by_the_restore_helper() {
    let target = HeadTarget::Detached {
        sha: "abc".to_owned(),
    };
    let json = serde_json::to_value(&target).expect("serialize");
    assert_eq!(json["kind"], "detached");
    assert!(Path::new(".").exists());
}
