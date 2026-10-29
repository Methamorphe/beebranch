mod common;

use beebranch_git::history::{self, MergeFastForward};
use beebranch_git::integration::{self, IntegrationMode};
use beebranch_git::{worktree, CommandSpec, GitSubcommand};
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
        MergeFastForward::Auto,
    )
    .expect("merge");
    assert!(!result.outcome.conflicted);
    assert!(fixture.path().join("b.txt").exists());
    assert_eq!(current_branch(&fixture), main);
    assert_eq!(
        fixture.rev_parse(&["--verify", "HEAD"]),
        fixture.rev_parse(&["--verify", "feature"]),
        "without --no-ff the target fast-forwards and no merge commit exists"
    );
}

#[test]
fn never_merge_creates_a_merge_commit_even_when_fast_forward_is_possible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    let feature = fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    let preview = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("preview");
    assert!(preview.fast_forward);

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Never,
    )
    .expect("merge");
    assert!(!result.outcome.conflicted);
    assert_eq!(current_branch(&fixture), main);
    assert_eq!(
        fixture.rev_parse(&["--verify", "HEAD^2"]),
        feature,
        "HEAD is a merge commit whose second parent is the source branch"
    );
}

#[test]
fn fast_forward_is_explicit_and_ignores_a_merge_ff_false_configuration() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.config(&["merge.ff", "false"]);
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    let feature = fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Auto,
    )
    .expect("merge");
    assert_eq!(
        fixture.rev_parse(&["--verify", "HEAD"]),
        feature,
        "an explicit --ff fast-forwards even when merge.ff=false is configured"
    );
}

#[test]
fn ff_only_fast_forwards_when_possible() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    let feature = fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Only,
    )
    .expect("fast-forward");
    assert!(!result.outcome.conflicted);
    assert_eq!(fixture.rev_parse(&["--verify", "HEAD"]), feature);
    fixture.run_failure(GitSubcommand::RevParse, &["--verify", "HEAD^2"]);
}

#[test]
fn ff_only_refuses_a_diverged_target_without_mutating_the_repository() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);
    fixture.commit("c.txt", "main\n", "main");
    let diverged = fixture.rev_parse(&["--verify", "HEAD"]);

    let preview = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
    )
    .expect("preview");
    assert_eq!(preview.behind, 1);
    assert!(
        !preview.fast_forward,
        "the target has a commit the source lacks"
    );

    let error = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Only,
    )
    .expect_err("fast-forward must be refused");
    assert_eq!(error.code, "git.merge_not_fast_forward", "{error:?}");
    assert!(
        error
            .remediation
            .as_deref()
            .is_some_and(|text| text.contains("commit de fusion")),
        "{error:?}"
    );
    assert_eq!(current_branch(&fixture), main);
    assert_eq!(fixture.rev_parse(&["--verify", "HEAD"]), diverged);
    assert!(
        !fixture.path().join("b.txt").exists(),
        "the refused merge left the worktree untouched"
    );
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
        MergeFastForward::Auto,
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
        MergeFastForward::Auto,
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
fn preview_allows_a_dirty_merge_but_not_a_dirty_rebase() {
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
    assert!(dirty.applicable);
    assert!(dirty.worktree_dirty);
    assert!(dirty.stash_required);
    let rebase = integration::preview(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Rebase,
    )
    .expect("dirty rebase");
    assert!(!rebase.applicable);
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

#[test]
fn merge_with_dirty_worktree_stashes_then_restores_tracked_changes() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.commit("notes.txt", "note\n", "note");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch(&main);

    fixture.write("notes.txt", "note changed\n");
    fixture.write("a.txt", "staged change\n");
    fixture.run(GitSubcommand::Add, &["a.txt"], &[]);
    let before = fixture.detect();
    assert_eq!(before.worktree.staged, 1);
    assert_eq!(before.worktree.unstaged, 1);

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Auto,
    )
    .expect("merge");
    assert!(!result.outcome.conflicted);
    assert!(result.outcome.state.operation.is_none());
    let stash = result.auto_stash.expect("auto stash");
    assert!(stash.popped);
    assert!(stash.conflicts.is_empty());
    assert!(
        beebranch_git::stash::list(fixture.runner(), fixture.path())
            .expect("stash list")
            .is_empty(),
        "the automatic stash is popped"
    );
    assert_eq!(current_branch(&fixture), main);
    assert!(fixture.path().join("b.txt").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).expect("a.txt"),
        "staged change\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("notes.txt")).expect("notes.txt"),
        "note changed\n"
    );
    let after = fixture.detect();
    assert_eq!(after.worktree.staged, 1);
    assert_eq!(after.worktree.unstaged, 1);
}

#[test]
fn merge_requiring_checkout_restores_the_stash_on_the_target() {
    let fixture = Fixture::new();
    fixture.commit("shared.txt", "base\n", "base");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.switch_new("other");
    fixture.commit("other.txt", "other\n", "other");
    fixture.switch("feature");
    fixture.write("shared.txt", "local work\n");

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "other",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Auto,
    )
    .expect("merge");
    assert!(result.checked_out_target);
    assert!(!result.outcome.conflicted);
    assert!(result.auto_stash.expect("auto stash").popped);
    assert_eq!(current_branch(&fixture), main);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("shared.txt")).expect("shared.txt"),
        "local work\n"
    );
    assert!(fixture.path().join("other.txt").exists());
}

#[test]
fn conflicting_merge_keeps_the_auto_stash_until_abort() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture.commit("notes.txt", "note\n", "note");
    let main = current_branch(&fixture);
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch(&main);
    fixture.commit("a.txt", "main\n", "main");
    fixture.write("notes.txt", "local work\n");

    let result = integration::start(
        fixture.runner(),
        fixture.path(),
        "feature",
        &main,
        IntegrationMode::Merge,
        MergeFastForward::Auto,
    )
    .expect("conflicted merge is an outcome");
    assert!(result.outcome.conflicted);
    let stash = result.auto_stash.expect("auto stash");
    assert!(!stash.popped);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("notes.txt")).expect("notes.txt"),
        "note\n",
        "local changes wait in the stash during the conflict"
    );
    let entries = beebranch_git::stash::list(fixture.runner(), fixture.path()).expect("stash list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].sha, stash.sha);

    history::abort_operation(fixture.runner(), fixture.path()).expect("abort");
    beebranch_git::stash::pop(fixture.runner(), fixture.path(), &stash.selector).expect("pop");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("notes.txt")).expect("notes.txt"),
        "local work\n"
    );
}
