mod common;

use beebranch_core::PageRequest;
use beebranch_git::commit::read_commit;
use beebranch_git::diff::{
    read_diff, read_root_patch, read_untracked_file, DiffLimits, DiffTarget, FileChangeKind,
};
use beebranch_git::log::{read_log, validate_revision};
use beebranch_git::refs::{read_refs, RefKind};
use beebranch_git::session::{RepoSession, SessionOptions};
use beebranch_git::status::{read_status, EntryKind};
use beebranch_git::GitSubcommand;

use common::{dirty_fixture, Fixture};

#[test]
fn reads_refs_status_and_detects_changes() {
    let fixture = dirty_fixture();
    fixture.branch("feature");
    fixture.run(beebranch_git::GitSubcommand::Tag, &["v1"], &[]);

    let refs = read_refs(fixture.runner(), fixture.path()).expect("refs");
    assert_eq!(
        refs.head.as_ref().map(|head| head.name.as_str()),
        Some("main")
    );
    assert!(refs
        .entries
        .iter()
        .any(|entry| entry.kind == RefKind::Branch && entry.name == "feature"));
    assert!(refs
        .entries
        .iter()
        .any(|entry| entry.kind == RefKind::Tag && entry.name == "v1"));

    fixture.write("a.txt", "changed\n");
    fixture.write("staged.txt", "staged\n");
    fixture.write("untracked.txt", "new\n");
    fixture.run(beebranch_git::GitSubcommand::Add, &["staged.txt"], &[]);

    let status = read_status(fixture.runner(), fixture.path(), None).expect("status");
    assert_eq!(status.branch.head.as_deref(), Some("main"));
    assert_eq!(status.counts.staged, 1);
    assert_eq!(status.counts.unstaged, 1);
    assert_eq!(status.counts.untracked, 1);
    assert!(status
        .entries
        .iter()
        .any(|entry| entry.path == "staged.txt" && entry.kind == EntryKind::Ordinary));
    assert!(status
        .entries
        .iter()
        .any(|entry| entry.path == "untracked.txt" && entry.kind == EntryKind::Untracked));
}

#[test]
fn log_is_paginated_and_ordered() {
    let fixture = Fixture::new();
    let mut shas = Vec::new();
    for index in 0..5 {
        shas.push(fixture.commit(
            "a.txt",
            &format!("line {index}\n"),
            &format!("commit {index}"),
        ));
    }

    let first = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest::first(2),
        None,
        7,
    )
    .expect("first page");
    assert_eq!(first.items.len(), 2);
    assert!(first.next.as_deref().unwrap().ends_with(&shas[3]));
    assert_eq!(first.generation, 7);
    assert_eq!(first.items[0].sha, shas[4]);

    let second = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest {
            after: first.next.clone(),
            limit: Some(2),
        },
        None,
        7,
    )
    .expect("second page");
    assert_eq!(second.items.len(), 2);
    assert!(second.next.as_deref().unwrap().ends_with(&shas[1]));

    let last = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest {
            after: second.next.clone(),
            limit: Some(2),
        },
        None,
        7,
    )
    .expect("last page");
    assert_eq!(last.items.len(), 1);
    assert_eq!(last.next, None);
    assert_eq!(last.items[0].sha, shas[0]);
}

#[test]
fn log_rejects_invalid_cursors_and_revisions() {
    let fixture = dirty_fixture();
    let error = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest {
            after: Some("nope".into()),
            limit: None,
        },
        None,
        1,
    )
    .expect_err("bad cursor");
    assert_eq!(error.code, "input.invalid");

    assert!(validate_revision("--all").is_err());
    let error = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest::first(10),
        Some("--all"),
        1,
    )
    .expect_err("option injection");
    assert_eq!(error.code, "input.invalid");
}

#[test]
fn cursor_pages_reconstruct_the_full_date_order_with_same_second_commits() {
    let fixture = Fixture::new();
    for index in 0..12 {
        fixture.commit(
            "a.txt",
            &format!("line {index}\n"),
            &format!("commit {index}"),
        );
    }
    let full = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest::first(100),
        None,
        1,
    )
    .expect("full log");
    let expected: Vec<String> = full.items.iter().map(|commit| commit.sha.clone()).collect();

    let mut collected = Vec::new();
    let mut after = None;
    for _ in 0..20 {
        let page = read_log(
            fixture.runner(),
            fixture.path(),
            &PageRequest {
                after: after.clone(),
                limit: Some(3),
            },
            None,
            1,
        )
        .expect("page");
        collected.extend(page.items.iter().map(|commit| commit.sha.clone()));
        after = page.next.clone();
        if after.is_none() {
            break;
        }
    }
    assert_eq!(collected, expected);
}

#[test]
fn cursor_pages_reconstruct_a_merge_history() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    let base = fixture.rev_parse(&["--abbrev-ref", "HEAD"]);
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch(&base);
    fixture.commit("b.txt", "main\n", "main");
    fixture.run(
        GitSubcommand::Merge,
        &["--no-ff", "--no-edit", "feature"],
        &[],
    );

    let full = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest::first(100),
        None,
        1,
    )
    .expect("full log");
    let expected: Vec<String> = full.items.iter().map(|commit| commit.sha.clone()).collect();

    let mut collected = Vec::new();
    let mut after = None;
    for _ in 0..20 {
        let page = read_log(
            fixture.runner(),
            fixture.path(),
            &PageRequest {
                after: after.clone(),
                limit: Some(1),
            },
            None,
            1,
        )
        .expect("page");
        collected.extend(page.items.iter().map(|commit| commit.sha.clone()));
        after = page.next.clone();
        if after.is_none() {
            break;
        }
    }
    assert_eq!(collected, expected);
}

#[test]
fn session_graph_stream_pages_match_the_full_log() {
    let fixture = Fixture::new();
    for index in 0..20 {
        fixture.commit(
            "a.txt",
            &format!("line {index}\n"),
            &format!("commit {index}"),
        );
    }
    let full = read_log(
        fixture.runner(),
        fixture.path(),
        &PageRequest::first(100),
        None,
        1,
    )
    .expect("full log");
    let expected: Vec<String> = full.items.iter().map(|commit| commit.sha.clone()).collect();

    let session = RepoSession::open(fixture.runner(), fixture.path(), SessionOptions::default())
        .expect("session");
    let mut collected = Vec::new();
    let mut after = None;
    for _ in 0..40 {
        let (page, rows) = session
            .graph_page(
                &PageRequest {
                    after: after.clone(),
                    limit: Some(3),
                },
                None,
            )
            .expect("graph page");
        assert_eq!(rows.len(), page.items.len());
        collected.extend(page.items.iter().map(|commit| commit.sha.clone()));
        after = page.next.clone();
        if after.is_none() {
            break;
        }
    }
    assert_eq!(collected, expected);
}

#[test]
fn commit_detail_includes_message_and_file_stats() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "first");
    fixture.write("a.txt", "one\ntwo\n");
    fixture.write("added.txt", "new\n");
    fixture.add_all();
    fixture.commit_staged("second\n\nBody with details\n");

    let head = fixture.rev_parse(&["HEAD"]);
    let detail = read_commit(fixture.runner(), fixture.path(), &head).expect("commit");
    assert_eq!(detail.summary.subject, "second");
    assert!(detail.message.contains("Body with details"));
    assert!(!detail.files_truncated);
    let a = detail
        .files
        .iter()
        .find(|file| file.path == "a.txt")
        .expect("a");
    assert_eq!(a.additions, Some(1));
    assert_eq!(a.deletions, Some(0));
    let added = detail
        .files
        .iter()
        .find(|file| file.path == "added.txt")
        .expect("added");
    assert_eq!(added.status, "A");
}

#[test]
fn diff_parses_modifications_binary_and_untracked() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "base");
    fixture.write_bytes("logo.bin", &[0, 1, 2, 3, 0, 4]);
    fixture.add_all();
    fixture.commit_staged("binary");

    fixture.write("a.txt", "one\ntwo\n");
    let report = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::WorkingTree,
        &["a.txt".to_owned()],
        DiffLimits::default(),
    )
    .expect("diff");
    assert_eq!(report.files.len(), 1);
    assert_eq!(report.files[0].additions, 1);
    assert_eq!(report.files[0].deletions, 0);
    assert!(!report.files[0].binary);
    assert_eq!(
        report.files[0].hunks[0]
            .lines
            .last()
            .map(|line| line.new_lineno),
        Some(Some(2))
    );

    fixture.write_bytes("logo.bin", &[0, 1, 2, 3, 0, 5]);
    let binary = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::WorkingTree,
        &["logo.bin".to_owned()],
        DiffLimits::default(),
    )
    .expect("binary diff");
    assert!(binary.files[0].binary);

    fixture.write("untracked.txt", "a\nb\n");
    let untracked = read_untracked_file(fixture.path(), "untracked.txt", DiffLimits::default())
        .expect("untracked");
    assert_eq!(untracked.kind, FileChangeKind::Added);
    assert_eq!(untracked.additions, 2);
    assert_eq!(untracked.hunks[0].lines.len(), 2);
}

#[test]
fn diff_handles_missing_newline_and_crlf() {
    let fixture = Fixture::new();
    fixture.write("crlf.txt", "one\r\ntwo\r\n");
    fixture.add_all();
    fixture.commit_staged("crlf");
    fixture.write("crlf.txt", "one\r\ntwo\r\nthree");

    let report = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::WorkingTree,
        &["crlf.txt".to_owned()],
        DiffLimits::default(),
    )
    .expect("diff");
    let file = &report.files[0];
    assert_eq!(file.additions, 1);
    assert!(file.hunks[0].lines.iter().any(|line| line.no_newline));
}

#[test]
fn rename_and_unicode_paths_survive_the_diff() {
    let fixture = Fixture::new();
    fixture.write("café.txt", "one\ntwo\nthree\n");
    fixture.add_all();
    fixture.commit_staged("unicode");
    std::fs::rename(
        fixture.path().join("café.txt"),
        fixture.path().join("renommé.txt"),
    )
    .expect("rename");
    fixture.write("renommé.txt", "one\ntwo\nthree\nfour\n");
    fixture.add_all();

    let status = read_status(fixture.runner(), fixture.path(), None).expect("status");
    let entry = status
        .entries
        .iter()
        .find(|entry| entry.path == "renommé.txt")
        .expect("renamed entry");
    assert_eq!(entry.kind, EntryKind::Renamed);
    assert_eq!(entry.orig_path.as_deref(), Some("café.txt"));

    let report = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::Index,
        &[],
        DiffLimits::default(),
    )
    .expect("diff");
    assert!(report
        .files
        .iter()
        .any(|file| file.kind == FileChangeKind::Renamed));
}

#[test]
fn range_and_root_patches_are_available() {
    let fixture = Fixture::new();
    let first = fixture.commit("a.txt", "one\n", "first");
    fixture.write("a.txt", "one\ntwo\n");
    fixture.add_all();
    let second = fixture.commit_staged("second");

    let range = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::Range {
            base: first.clone(),
            target: Some(second),
        },
        &[],
        DiffLimits::default(),
    )
    .expect("range");
    assert_eq!(range.files.len(), 1);
    assert_eq!(range.files[0].additions, 1);

    let root = read_root_patch(
        fixture.runner(),
        fixture.path(),
        &first,
        &[],
        DiffLimits::default(),
    )
    .expect("root patch");
    assert!(root.files.iter().any(|file| file.new_path == "a.txt"));
}

#[test]
fn diff_rejects_paths_outside_the_worktree() {
    let fixture = dirty_fixture();
    let error = read_diff(
        fixture.runner(),
        fixture.path(),
        &DiffTarget::WorkingTree,
        &["../escape".to_owned()],
        DiffLimits::default(),
    )
    .expect_err("escape");
    assert_eq!(error.code, "input.invalid");

    let error = read_untracked_file(fixture.path(), ".git/config", DiffLimits::default())
        .expect_err(".git");
    assert_eq!(error.code, "input.invalid");
}

#[test]
fn graph_draws_one_stash_node_above_the_history() {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "one\n", "first");
    fixture.commit("a.txt", "two\n", "second");
    // A side branch keeps the base commit expected by two lanes, so the stash
    // line has to join it from above instead of sharing its lane.
    fixture.switch_new("topic");
    fixture.commit("b.txt", "topic\n", "topic work");
    fixture.switch("main");
    fixture.write("a.txt", "local change\n");
    fixture.write("notes.txt", "untracked\n");
    fixture.run(
        GitSubcommand::Stash,
        &["push", "--include-untracked", "-m", "BeeBranch stash"],
        &[],
    );
    let base = fixture.rev_parse(&["stash@{0}^"]);

    let session = RepoSession::open(fixture.runner(), fixture.path(), SessionOptions::default())
        .expect("session");
    let (page, rows) = session
        .graph_page_scoped(&PageRequest::first(50), None, true)
        .expect("graph page");
    assert_eq!(rows.len(), page.items.len());

    // One node per stash, labelled with the typed message, above the history.
    assert_eq!(rows[0].stash.as_deref(), Some("stash@{0}"));
    assert_eq!(page.items[0].subject, "BeeBranch stash");
    assert_eq!(page.items[0].parents, vec![base.clone()]);
    assert_eq!(rows[0].node_lane, 0);
    assert!(rows[0].departures.is_empty());
    // The index and untracked snapshots are not commits of the history.
    assert!(
        !page.items.iter().any(
            |commit| commit.subject.contains("files on") || commit.subject.contains("index on")
        ),
        "stash snapshots leaked into the graph: {:?}",
        page.items
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>()
    );
    // The stash line ends on its base, which also receives the side branch.
    let base_row = page
        .items
        .iter()
        .position(|commit| commit.sha == base)
        .expect("base row");
    assert_eq!(rows[base_row].node_lane, 0);
    assert_eq!(rows[base_row].arrivals, vec![1]);
}
