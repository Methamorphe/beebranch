mod common;

use beebranch_git::capability::GitCapability;
use beebranch_git::preview::{self, ConflictCheck, PreviewOperation};
use beebranch_git::process::StdinMode;
use beebranch_git::{CommandSpec, GitSubcommand};
use common::Fixture;
use std::path::Path;

fn merge_tree(fixture: &Fixture) -> bool {
    GitCapability::detect(fixture.runner(), fixture.path())
        .map(|capability| capability.features.merge_tree_write)
        .unwrap_or(false)
}

fn run_in(fixture: &Fixture, dir: &Path, subcommand: GitSubcommand, args: &[&str]) {
    run_in_input(fixture, dir, subcommand, args, &[]);
}

fn run_in_input(
    fixture: &Fixture,
    dir: &Path,
    subcommand: GitSubcommand,
    args: &[&str],
    stdin: &[u8],
) {
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(subcommand, dir)
                .args(args.iter().copied())
                .stdin(StdinMode::Bytes(stdin.to_vec())),
        )
        .expect("git");
    assert!(
        outcome.success(),
        "{subcommand} {args:?}: {}",
        outcome.stderr.text_lossy()
    );
}

fn current_branch(fixture: &Fixture) -> String {
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, fixture.path())
                .arg("--abbrev-ref")
                .arg("HEAD"),
        )
        .expect("branch");
    outcome.stdout.text_lossy().trim().to_owned()
}

#[test]
fn merge_preview_reports_counts_and_conflicts() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.commit("b.txt", "feature\n", "feature file");
    fixture.switch(&main);
    fixture.commit("a.txt", "main\n", "main");

    let discovery = fixture.discover();
    let supported = merge_tree(&fixture);
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Merge {
            source: "feature".to_owned(),
            target: main.clone(),
        },
        supported,
    )
    .expect("preview");

    assert_eq!(preview.commits, 2);
    assert_eq!(preview.behind, 1);
    assert_eq!(preview.files, 2, "a.txt and b.txt");
    assert!(preview.additions >= 2);
    assert!(preview.blocked_reason.is_none());
    if supported {
        assert_eq!(preview.conflict_check, ConflictCheck::Conflicts);
        assert_eq!(preview.conflicted_files, vec!["a.txt".to_owned()]);
    } else {
        assert_eq!(preview.conflict_check, ConflictCheck::Unavailable);
    }
}

#[test]
fn merge_preview_is_clean_without_overlap() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Merge {
            source: "feature".to_owned(),
            target: main,
        },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert_eq!(preview.commits, 1);
    assert_eq!(preview.files, 1);
    assert_eq!(preview.conflict_check, ConflictCheck::Clean);
    assert!(preview.conflicted_files.is_empty());
}

#[test]
fn reset_preview_counts_the_commits_that_disappear() {
    let fixture = Fixture::new();
    let base = fixture.commit("a.txt", "base\n", "base");
    fixture.commit("b.txt", "two\n", "second");
    fixture.commit("c.txt", "three\n", "third");

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Reset { revision: base },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert_eq!(preview.commits, 2);
    assert_eq!(preview.files, 2);
    assert_eq!(preview.additions, 2);
    assert_eq!(preview.conflict_check, ConflictCheck::Clean);
}

#[test]
fn checkout_preview_flags_local_changes() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.branch("feature");

    let discovery = fixture.discover();
    let clean = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Checkout {
            name: Some("feature".to_owned()),
            detached_at: None,
        },
        merge_tree(&fixture),
    )
    .expect("preview");
    assert!(!clean.stashes_local_changes);
    assert_eq!(clean.files, 0);

    fixture.write("a.txt", "edited\n");
    let dirty = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Checkout {
            name: Some("feature".to_owned()),
            detached_at: None,
        },
        merge_tree(&fixture),
    )
    .expect("preview");
    assert!(dirty.stashes_local_changes);
}

#[test]
fn stash_pop_preview_reports_files_without_blocking() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.write("a.txt", "edited\n");
    beebranch_git::stash::create(fixture.runner(), fixture.path(), "wip", false, &[])
        .expect("stash");

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::StashPop {
            selector: "stash@{0}".to_owned(),
        },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert!(preview.files >= 1);
    assert!(preview.blocked_reason.is_none());
}

#[test]
fn cherry_pick_preview_counts_picked_commits() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("side");
    let first = fixture.commit("b.txt", "one\n", "one");
    fixture.commit("c.txt", "two\n", "two");
    fixture.switch(&main);

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::CherryPick { shas: vec![first] },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert_eq!(preview.commits, 1);
    assert_eq!(preview.files, 1);
    assert_eq!(preview.additions, 1);
    assert!(!preview.upstream_missing);
}

#[test]
fn push_preview_reports_a_missing_upstream() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Push {
            remote: "origin".to_owned(),
            branch: current_branch(&fixture),
        },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert!(preview.upstream_missing);
    assert_eq!(preview.commits, 0);
}

#[test]
fn pull_preview_uses_the_remote_tracking_branch() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);

    let remote = tempfile::tempdir().expect("remote");
    let remote_path = remote.path().to_string_lossy().into_owned();
    run_in(
        &fixture,
        fixture.path(),
        GitSubcommand::Init,
        &["--bare", "--initial-branch=main", remote_path.as_str()],
    );
    run_in(
        &fixture,
        fixture.path(),
        GitSubcommand::Remote,
        &["add", "origin", remote_path.as_str()],
    );
    run_in(
        &fixture,
        fixture.path(),
        GitSubcommand::Push,
        &["origin", &format!("{main}:{main}")],
    );

    let clone = tempfile::tempdir().expect("clone");
    let clone_path = clone.path().to_string_lossy().into_owned();
    run_in(
        &fixture,
        fixture.path(),
        GitSubcommand::Clone,
        &[remote_path.as_str(), clone_path.as_str()],
    );
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Config, clone.path())
                .arg("user.email")
                .arg("bob@example.test"),
        )
        .expect("config");
    assert!(outcome.success());
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Config, clone.path())
                .arg("user.name")
                .arg("Bob"),
        )
        .expect("config");
    assert!(outcome.success());
    std::fs::write(clone.path().join("remote.txt"), "remote\n").expect("write");
    run_in(&fixture, clone.path(), GitSubcommand::Add, &["-A"]);
    run_in_input(
        &fixture,
        clone.path(),
        GitSubcommand::Commit,
        &["-F", "-"],
        b"remote change\n",
    );
    run_in(
        &fixture,
        clone.path(),
        GitSubcommand::Push,
        &["origin", main.as_str()],
    );
    run_in(&fixture, fixture.path(), GitSubcommand::Fetch, &["origin"]);

    let discovery = fixture.discover();
    let preview = preview::operation(
        fixture.runner(),
        &discovery,
        &PreviewOperation::Pull {
            remote: "origin".to_owned(),
            branch: main,
        },
        merge_tree(&fixture),
    )
    .expect("preview");

    assert_eq!(preview.commits, 1);
    assert_eq!(preview.files, 1);
    assert_eq!(preview.conflict_check, ConflictCheck::Clean);
    assert!(preview.blocked_reason.is_none());
}
