mod common;

use std::path::Path;

use beebranch_git::blame;
use beebranch_git::conflict;
use beebranch_git::history::{self, RebaseAction, RebaseStep};
use beebranch_git::patch::{self, PatchSource};
use beebranch_git::refs_admin;
use beebranch_git::search::{self};
use beebranch_git::submodule;
use beebranch_git::worktree;
use beebranch_git::{CommandSpec, GitSubcommand};

use common::{dirty_fixture, Fixture};

fn bare_repo(root: &Path, name: &str) -> std::path::PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).expect("mkdir");
    let fixture = Fixture::new();
    let spec = CommandSpec::new(GitSubcommand::Init, &path).arg("--bare");
    fixture
        .runner()
        .run(&spec)
        .expect("init bare")
        .ensure_success()
        .expect("bare");
    path
}

#[test]
fn worktrees_are_listed_locked_and_removed() {
    let fixture = dirty_fixture();
    fixture.run(GitSubcommand::Branch, &["feature"], &[]);
    let target = fixture.path().join("wt-feature");
    let report = worktree::add(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        "feature",
        None,
        false,
    )
    .expect("add worktree");
    assert_eq!(report.entries.len(), 2);
    let canonical = target.canonicalize().expect("canonical target");
    let entry = report
        .entries
        .iter()
        .find(|entry| std::fs::canonicalize(&entry.path).ok() == Some(canonical.clone()))
        .expect("new worktree");
    assert_eq!(entry.branch.as_deref(), Some("feature"));

    let locked = worktree::lock(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        Some("maintenance"),
    )
    .expect("lock");
    assert!(locked
        .entries
        .iter()
        .any(|entry| entry.locked.as_deref() == Some("maintenance")));

    let unlocked = worktree::unlock(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
    )
    .expect("unlock");
    assert!(unlocked.entries.iter().all(|entry| entry.locked.is_none()));

    let after = worktree::remove(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        false,
    )
    .expect("remove");
    assert_eq!(after.entries.len(), 1);
}

#[test]
fn removing_a_dirty_worktree_requires_force() {
    let fixture = dirty_fixture();
    fixture.run(GitSubcommand::Branch, &["feature"], &[]);
    let target = fixture.path().join("wt-dirty");
    worktree::add(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        "feature",
        None,
        false,
    )
    .expect("add");
    std::fs::write(target.join("a.txt"), "changed\n").expect("write");
    let error = worktree::remove(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        false,
    )
    .expect_err("dirty worktree");
    assert!(error.code.starts_with("git."), "{}", error.code);
    worktree::remove(
        fixture.runner(),
        fixture.path(),
        &target.display().to_string(),
        true,
    )
    .expect("forced remove");
}

#[test]
fn blame_and_file_history_follow_renames() {
    let fixture = Fixture::new();
    fixture.commit("src/a.txt", "one\ntwo\nthree\n", "first");
    std::fs::create_dir_all(fixture.path().join("lib")).expect("mkdir");
    std::fs::rename(
        fixture.path().join("src/a.txt"),
        fixture.path().join("lib/b.txt"),
    )
    .expect("rename");
    fixture.add_all();
    fixture.commit_staged("rename");
    fixture.write("lib/b.txt", "one\nTWO\nthree\n");
    fixture.add_all();
    fixture.commit_staged("edit");

    let report = blame::blame(
        fixture.runner(),
        fixture.path(),
        "lib/b.txt",
        Some(1),
        Some(2),
        None,
    )
    .expect("blame");
    assert_eq!(report.lines.len(), 2);
    assert_eq!(report.lines[1].content, "TWO");
    assert_eq!(report.lines[1].summary, "edit");

    let history = blame::history(
        fixture.runner(),
        fixture.path(),
        "lib/b.txt",
        true,
        Some(10),
        None,
    )
    .expect("history");
    assert!(history.entries.len() >= 2);
    assert!(history
        .entries
        .iter()
        .any(|entry| entry.status.starts_with('R')));
}

fn linear_fixture() -> (Fixture, Vec<String>, String) {
    let fixture = Fixture::new();
    fixture.commit("base.txt", "0\n", "base");
    let first = fixture.commit("one.txt", "1\n", "one");
    let second = fixture.commit("two.txt", "2\n", "two");
    let third = fixture.commit("three.txt", "3\n", "three");
    let upstream = fixture.rev_parse(&["HEAD~3"]);
    (fixture, vec![first, second, third], upstream)
}

fn subjects(fixture: &Fixture) -> Vec<String> {
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Log, fixture.path())
                .arg("--format=%s")
                .arg("--max-count=10"),
        )
        .expect("log");
    let mut values: Vec<String> = outcome
        .stdout
        .text_lossy()
        .lines()
        .map(str::to_owned)
        .collect();
    values.reverse();
    values
}

#[test]
fn interactive_rebase_reorders_reworks_and_drops() {
    let (fixture, shas, upstream) = linear_fixture();
    let plan = vec![
        RebaseStep {
            sha: shas[2].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
        RebaseStep {
            sha: shas[0].clone(),
            action: RebaseAction::Drop,
            message: None,
        },
        RebaseStep {
            sha: shas[1].clone(),
            action: RebaseAction::Reword,
            message: Some("two reworded".into()),
        },
    ];
    let outcome = history::rebase_interactive(fixture.runner(), fixture.path(), &upstream, &plan)
        .expect("interactive rebase");
    assert!(outcome.state.operation.is_none());
    assert_eq!(subjects(&fixture), vec!["base", "three", "two reworded"]);
}

#[test]
fn interactive_rebase_squashes_with_combined_message() {
    let (fixture, shas, upstream) = linear_fixture();
    let plan = vec![
        RebaseStep {
            sha: shas[0].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
        RebaseStep {
            sha: shas[1].clone(),
            action: RebaseAction::Squash,
            message: Some("two squashed".into()),
        },
        RebaseStep {
            sha: shas[2].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
    ];
    history::rebase_interactive(fixture.runner(), fixture.path(), &upstream, &plan)
        .expect("squash rebase");
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Show, fixture.path())
                .arg("-s")
                .arg("--format=%B")
                .arg("HEAD~1"),
        )
        .expect("show");
    let message = outcome.stdout.text_lossy();
    assert!(message.contains("one"), "{message}");
    assert!(message.contains("two squashed"), "{message}");
}

#[test]
fn interactive_rebase_rejects_a_partial_plan() {
    let (fixture, shas, upstream) = linear_fixture();
    let plan = vec![RebaseStep {
        sha: shas[2].clone(),
        action: RebaseAction::Pick,
        message: None,
    }];
    let error = history::rebase_interactive(fixture.runner(), fixture.path(), &upstream, &plan)
        .expect_err("partial plan");
    assert_eq!(error.code, "rebase.plan_invalid");
}

#[test]
fn cherry_pick_and_revert_keep_order() {
    let fixture = Fixture::new();
    fixture.commit("base.txt", "base\n", "base");
    fixture.run(GitSubcommand::Switch, &["-c", "feature"], &[]);
    let first = fixture.commit("one.txt", "1\n", "one");
    let second = fixture.commit("two.txt", "2\n", "two");
    fixture.switch("main");
    let outcome = history::cherry_pick(
        fixture.runner(),
        fixture.path(),
        &[first.clone(), second.clone()],
    )
    .expect("cherry pick");
    assert!(outcome.state.operation.is_none());
    assert_eq!(subjects(&fixture), vec!["base", "one", "two"]);

    history::revert(fixture.runner(), fixture.path(), &[second]).expect("revert");
    assert_eq!(
        subjects(&fixture),
        vec!["base", "one", "two", "Revert \"two\""]
    );
}

#[test]
fn conflict_workspace_reads_stages_and_saves_atomically() {
    let fixture = Fixture::new();
    fixture.commit("shared.txt", "line\n", "base");
    fixture.run(GitSubcommand::Switch, &["-c", "ours"], &[]);
    fixture.commit("shared.txt", "ours\n", "ours");
    fixture.switch("main");
    fixture.run(GitSubcommand::Switch, &["-c", "theirs"], &[]);
    fixture.commit("shared.txt", "theirs\n", "theirs");
    fixture.switch("ours");
    let outcome = history::merge(fixture.runner(), fixture.path(), "theirs", false).expect("merge");
    assert!(outcome.conflicted);

    let view = conflict::read(fixture.runner(), fixture.path(), "shared.txt").expect("read");
    assert!(view.has_markers);
    assert_eq!(
        view.ours.as_ref().map(|side| side.content.as_str()),
        Some("ours\n")
    );
    assert_eq!(
        view.theirs.as_ref().map(|side| side.content.as_str()),
        Some("theirs\n")
    );

    let error = conflict::save(
        fixture.runner(),
        fixture.path(),
        "shared.txt",
        "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> theirs\n",
        false,
        false,
    )
    .expect_err("markers");
    assert_eq!(error.code, "conflict.markers_remaining");

    let saved = conflict::save(
        fixture.runner(),
        fixture.path(),
        "shared.txt",
        "resolved\n",
        false,
        true,
    )
    .expect("save");
    assert!(!saved.has_markers);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("shared.txt")).unwrap(),
        "resolved\n"
    );
    history::continue_operation(fixture.runner(), fixture.path()).expect("continue");
}

#[test]
fn submodule_status_and_update_are_bounded() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "root\n", "root");
    let child = Fixture::new();
    child.commit("lib.txt", "lib\n", "lib");

    let report = submodule::add(
        fixture.runner(),
        fixture.path(),
        &child.path().display().to_string(),
        "vendor/lib",
        None,
    )
    .expect("submodule add");
    assert!(report
        .entries
        .iter()
        .any(|entry| entry.path == "vendor/lib"));
    fixture.add_all();
    fixture.commit_staged("add submodule");
    let listed = submodule::list(fixture.runner(), fixture.path()).expect("list");
    assert_eq!(listed.entries.len(), 1);
    let updated = submodule::update(
        fixture.runner(),
        fixture.path(),
        true,
        true,
        false,
        Some("vendor/lib"),
    )
    .expect("update");
    assert!(!updated.entries.is_empty());
}

#[test]
fn tags_and_remotes_are_validated() {
    let fixture = dirty_fixture();
    let tag = refs_admin::create_tag(
        fixture.runner(),
        fixture.path(),
        "v1.0.0",
        Some("Release"),
        None,
        false,
    )
    .expect("tag");
    assert!(tag.annotated);
    assert_eq!(tag.message.as_deref(), Some("Release"));
    assert!(!tag.tagger.as_deref().unwrap_or("").is_empty());

    let remotes = refs_admin::add_remote(
        fixture.runner(),
        fixture.path(),
        "origin",
        "https://example.test/team/repo.git",
    )
    .expect("remote add");
    assert_eq!(
        remotes[0].fetch_url.as_deref(),
        Some("https://example.test/team/repo.git")
    );
    assert!(refs_admin::add_remote(
        fixture.runner(),
        fixture.path(),
        "bad",
        "https://user:secret@example.test/repo.git",
    )
    .is_err());
    refs_admin::set_remote_url(
        fixture.runner(),
        fixture.path(),
        "origin",
        "git@example.test:team/repo.git",
        false,
    )
    .expect("set url");
    let remotes =
        refs_admin::remove_remote(fixture.runner(), fixture.path(), "origin").expect("remove");
    assert!(remotes.is_empty());
    refs_admin::delete_tag(fixture.runner(), fixture.path(), "v1.0.0").expect("delete tag");
}

#[test]
fn patch_roundtrip_and_conflict_leave_the_worktree_untouched() {
    let fixture = dirty_fixture();
    fixture.commit("file.txt", "one\n", "file");
    fixture.write("file.txt", "one\ntwo\n");
    let report = patch::create(
        fixture.runner(),
        fixture.path(),
        &PatchSource::Worktree {
            paths: vec!["file.txt".into()],
        },
    )
    .expect("create patch");
    assert_eq!(report.files, vec!["file.txt"]);

    let error = patch::apply(fixture.runner(), fixture.path(), &report.text, false, false)
        .expect_err("already applied");
    assert_eq!(error.code, "patch.conflict");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
        "one\ntwo\n"
    );

    fixture.run(
        GitSubcommand::Restore,
        &["--worktree", "--", "file.txt"],
        &[],
    );
    let applied = patch::apply(fixture.runner(), fixture.path(), &report.text, false, false)
        .expect("apply patch");
    assert_eq!(applied.files, vec!["file.txt"]);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
        "one\ntwo\n"
    );
}

#[test]
fn deep_search_is_bounded_and_scoped() {
    let fixture = Fixture::new();
    fixture.commit("src/app.rs", "fn main() { let needle = 1; }\n", "add app");
    fixture.commit("docs/readme.md", "needle in docs\n", "docs");

    let paths =
        search::search_paths(fixture.runner(), fixture.path(), "app", 10, 0).expect("paths");
    assert_eq!(paths.items.len(), 1);
    assert_eq!(paths.items[0].path, "src/app.rs");

    let content = search::search_content(
        fixture.runner(),
        fixture.path(),
        "needle",
        Some("src"),
        10,
        0,
    )
    .expect("content");
    assert_eq!(content.items.len(), 1);
    assert_eq!(content.items[0].path, "src/app.rs");
    assert_eq!(content.items[0].line, 1);
}

#[test]
fn pushing_a_tag_to_a_bare_remote_is_explicit() {
    let fixture = dirty_fixture();
    let remote = bare_repo(fixture.path(), "remote.git");
    refs_admin::add_remote(
        fixture.runner(),
        fixture.path(),
        "origin",
        &remote.display().to_string(),
    )
    .expect("remote");
    refs_admin::create_tag(
        fixture.runner(),
        fixture.path(),
        "v0.1.0",
        None,
        None,
        false,
    )
    .expect("tag");
    let report = refs_admin::push_tag(fixture.runner(), fixture.path(), "origin", "v0.1.0")
        .expect("push tag");
    assert_eq!(report.reference, "refs/tags/v0.1.0");
    let spec = CommandSpec::new(GitSubcommand::ForEachRef, &remote).arg("refs/tags");
    let outcome = fixture.runner().run(&spec).expect("for-each-ref");
    assert!(outcome.stdout.text_lossy().contains("v0.1.0"));
}

#[test]
fn rebase_conflict_is_visible_and_abortable() {
    let fixture = Fixture::new();
    fixture.commit("shared.txt", "base\n", "base");
    fixture.commit("shared.txt", "A\n", "A");
    fixture.commit("shared.txt", "B\n", "B");
    fixture.commit("other.txt", "other\n", "other");
    let upstream = fixture.rev_parse(&["HEAD~3"]);
    let log = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Log, fixture.path())
                .arg("--format=%H %s")
                .arg("--max-count=3"),
        )
        .expect("log");
    let mut shas: Vec<String> = log
        .stdout
        .text_lossy()
        .lines()
        .map(|line| line.split(' ').next().unwrap_or_default().to_owned())
        .collect();
    shas.reverse();
    let plan = vec![
        RebaseStep {
            sha: shas[1].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
        RebaseStep {
            sha: shas[0].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
        RebaseStep {
            sha: shas[2].clone(),
            action: RebaseAction::Pick,
            message: None,
        },
    ];
    let outcome = history::rebase_interactive(fixture.runner(), fixture.path(), &upstream, &plan)
        .expect("conflicting rebase");
    assert!(outcome.conflicted);
    assert!(outcome.state.operation.is_some());
    let conflicted =
        conflict::read(fixture.runner(), fixture.path(), "shared.txt").expect("conflict read");
    assert!(conflicted.has_markers);
    assert!(conflicted.marker_lines.len() >= 3);

    let aborted = history::abort_operation(fixture.runner(), fixture.path()).expect("abort");
    assert!(aborted.state.operation.is_none());
    assert_eq!(subjects(&fixture), vec!["base", "A", "B", "other"]);
}

#[test]
fn cherry_pick_conflict_can_be_aborted() {
    let fixture = Fixture::new();
    fixture.commit("shared.txt", "base\n", "base");
    fixture.run(GitSubcommand::Switch, &["-c", "feature"], &[]);
    fixture.commit("shared.txt", "feature\n", "feature change");
    fixture.switch("main");
    fixture.commit("shared.txt", "main\n", "main change");
    let feature_sha = fixture.rev_parse(&["feature"]);

    let outcome = history::cherry_pick(fixture.runner(), fixture.path(), &[feature_sha])
        .expect("conflict cherry-pick");
    assert!(outcome.conflicted);
    assert!(outcome.state.operation.is_some());
    history::abort_operation(fixture.runner(), fixture.path()).expect("abort");
    assert_eq!(subjects(&fixture), vec!["base", "main change"]);
}

#[test]
fn conflict_save_preserves_crlf() {
    let fixture = Fixture::new();
    fixture.commit("shared.txt", "base\r\n", "base");
    fixture.run(GitSubcommand::Switch, &["-c", "ours"], &[]);
    fixture.commit("shared.txt", "ours\r\n", "ours");
    fixture.switch("main");
    fixture.run(GitSubcommand::Switch, &["-c", "theirs"], &[]);
    fixture.commit("shared.txt", "theirs\r\n", "theirs");
    fixture.switch("ours");
    history::merge(fixture.runner(), fixture.path(), "theirs", false).expect("merge");
    // Git may normalise markers to LF; write CRLF markers to exercise the
    // line-ending preserving save path explicitly.
    std::fs::write(
        fixture.path().join("shared.txt"),
        b"<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\n",
    )
    .expect("write crlf");
    conflict::save(
        fixture.runner(),
        fixture.path(),
        "shared.txt",
        "resolved\n",
        false,
        true,
    )
    .expect("save");
    let bytes = std::fs::read(fixture.path().join("shared.txt")).expect("read");
    assert_eq!(bytes, b"resolved\r\n");
}

#[test]
fn rebase_candidates_detail_keeps_replay_order() {
    let (fixture, shas, upstream) = linear_fixture();
    let detail = history::rebase_candidates_detail(fixture.runner(), fixture.path(), &upstream)
        .expect("detail");
    assert_eq!(detail.len(), 3);
    assert_eq!(detail[0].sha, shas[0]);
    assert_eq!(detail[0].subject, "one");
    assert_eq!(detail[2].sha, shas[2]);
}

#[test]
fn deep_search_pages_are_offset_based() {
    let fixture = Fixture::new();
    fixture.commit("src/a.rs", "needle a\n", "a");
    fixture.commit("src/b.rs", "needle b\n", "b");

    let first =
        search::search_paths(fixture.runner(), fixture.path(), "src/", 1, 0).expect("paths page 1");
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.next, Some(1));
    let second =
        search::search_paths(fixture.runner(), fixture.path(), "src/", 1, 1).expect("paths page 2");
    assert_eq!(second.items.len(), 1);
    assert_ne!(first.items[0].path, second.items[0].path);

    let content = search::search_content(
        fixture.runner(),
        fixture.path(),
        "needle",
        Some("src"),
        1,
        0,
    )
    .expect("content page 1");
    assert_eq!(content.items.len(), 1);
    assert_eq!(content.next, Some(1));
    let content_next = search::search_content(
        fixture.runner(),
        fixture.path(),
        "needle",
        Some("src"),
        1,
        1,
    )
    .expect("content page 2");
    assert_eq!(content_next.items.len(), 1);
    assert_ne!(content.items[0].path, content_next.items[0].path);
}

#[test]
fn clones_a_local_repository_into_a_new_directory() {
    let source = dirty_fixture();
    let parent = tempfile::tempdir().expect("parent");
    let destination = parent.path().join("cloned");
    let cloned = beebranch_git::clone::clone(
        source.runner(),
        &source.path().display().to_string(),
        &destination.display().to_string(),
        &beebranch_git::clone::CloneOptions::default(),
    )
    .expect("clone");
    assert_eq!(cloned, destination.canonicalize().expect("canonical"));
    assert_eq!(
        std::fs::read_to_string(cloned.join("a.txt")).expect("file"),
        "base\n"
    );

    let error = beebranch_git::clone::clone(
        source.runner(),
        &source.path().display().to_string(),
        &destination.display().to_string(),
        &beebranch_git::clone::CloneOptions::default(),
    )
    .expect_err("destination exists");
    assert_eq!(error.code, "clone.destination_exists");
}
