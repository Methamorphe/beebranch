mod common;

use beebranch_git::integration::{self, IntegrationMode};
use beebranch_git::{history, worktree, CommandSpec, GitSubcommand};
use common::Fixture;

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
fn merge_preview_and_start_are_consistent() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    let preview = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("preview");
    assert!(preview.applicable);
    assert_eq!(preview.ahead, 1);
    assert_eq!(preview.behind, 0);
    assert!(preview.fast_forward);
    assert!(!preview.requires_checkout);

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("merge");
    assert!(!result.outcome.conflicted);
    assert!(fixture.path().join("b.txt").exists());
    assert_eq!(current_branch(&fixture), main);
}

#[test]
fn merge_conflict_keeps_a_typed_abort_path() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch(&main);
    fixture.commit("a.txt", "main\n", "main");

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("conflicted merge is an outcome");
    assert!(result.outcome.conflicted);
    assert!(result.outcome.state.operation.is_some());
    assert_eq!(current_branch(&fixture), main);

    history::abort_operation(fixture.runner(), fixture.path()).expect("abort");
    let state = fixture.detect();
    assert!(state.operation.is_none());
    assert!(state.conflicts.is_empty());
}

#[test]
fn rebase_drop_moves_the_target_onto_the_source() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);
    fixture.commit("c.txt", "main\n", "main");
    let before = fixture.rev_parse(&["--verify", "HEAD"]);

    let preview = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Rebase,
    )
    .expect("preview");
    assert!(preview.applicable);
    assert_eq!(preview.ahead, 1);
    assert_eq!(preview.behind, 1);

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Rebase,
    )
    .expect("rebase");
    assert!(!result.outcome.conflicted);
    assert_eq!(current_branch(&fixture), main);
    let after = fixture.rev_parse(&["--verify", "HEAD"]);
    assert_ne!(before, after);
    assert!(fixture.path().join("b.txt").exists());
    assert!(fixture.path().join("c.txt").exists());
}

#[test]
fn preview_blocks_dirty_worktree_identical_branches_and_other_worktrees() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.switch(&main);

    let same = integration::preview(
        fixture.runner(),
        fixture.path(),
        &main,
        &main,
        IntegrationMode::Merge,
    )
    .expect("same");
    assert!(!same.applicable);

    fixture.write("a.txt", "dirty\n");
    let dirty = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("dirty");
    assert!(!dirty.applicable);
    assert!(dirty.worktree_dirty);
    fixture.write("a.txt", "base\n");

    let target = fixture.path().join("wt-feature");
    worktree::add(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        "feature",
        None,
        false,
    )
    .expect("worktree");
    let extracted = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        "feature",
        IntegrationMode::Merge,
    )
    .expect("extracted");
    assert!(!extracted.applicable);
}
