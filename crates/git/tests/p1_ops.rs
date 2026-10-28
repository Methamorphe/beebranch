mod common;

use std::path::Path;

use beebranch_core::PageRequest;
use beebranch_git::branches;
use beebranch_git::commit::{self, CommitOptions};
use beebranch_git::diff::{read_diff, DiffLimits, DiffTarget};
use beebranch_git::history;
use beebranch_git::index::{self, Fingerprint, HunkSelection, PathSelection};
use beebranch_git::search::{self, SearchMode, SearchQuery};
use beebranch_git::stash;
use beebranch_git::sync::{self, PullStrategy, PushRequest, SyncKind};
use beebranch_git::{CommandSpec, GitSubcommand};

use common::{dirty_fixture, Fixture};

fn diff(repo: &Path, target: DiffTarget) -> beebranch_git::diff::DiffReport {
    let runner = beebranch_git::GitRunner::detect().expect("git");
    read_diff(&runner, repo, &target, &[], DiffLimits::default()).expect("diff")
}

fn file_content(fixture: &Fixture, spec: &str) -> String {
    let outcome = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Show, fixture.path())
                .arg(spec)
                .capture_limits(beebranch_git::CaptureLimits {
                    stdout: 1024 * 1024,
                    stderr: 1024,
                }),
        )
        .expect("show");
    assert!(outcome.success(), "show {spec}");
    String::from_utf8_lossy(outcome.stdout.bytes()).into_owned()
}

#[test]
fn stages_a_single_line_and_leaves_the_rest_unstaged() {
    let fixture = dirty_fixture();
    fixture.commit("lines.txt", "one\ntwo\nthree\n", "lines");
    fixture.write("lines.txt", "one\nTWO\nthree\nfour\n");

    let working = diff(fixture.path(), DiffTarget::WorkingTree);
    let file = &working.files[0];
    let hunk = &file.hunks[0];
    let added = hunk
        .lines
        .iter()
        .position(|line| {
            line.kind == beebranch_git::diff::DiffLineKind::Added && line.content == "TWO"
        })
        .expect("TWO line");

    let selection = PathSelection {
        path: "lines.txt".into(),
        hunks: vec![HunkSelection {
            hunk: 0,
            lines: Some(vec![added]),
        }],
    };
    index::stage(fixture.runner(), fixture.path(), &[selection]).expect("stage line");

    let staged = diff(fixture.path(), DiffTarget::Index);
    let text: String = staged.files[0]
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter(|line| line.kind == beebranch_git::diff::DiffLineKind::Added)
        .map(|line| line.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(text, "TWO");
    assert_eq!(
        file_content(&fixture, ":lines.txt"),
        "one\ntwo\nTWO\nthree\n"
    );

    let unstaged = diff(fixture.path(), DiffTarget::WorkingTree);
    let added_unstaged: Vec<&str> = unstaged.files[0]
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter(|line| line.kind == beebranch_git::diff::DiffLineKind::Added)
        .map(|line| line.content.as_str())
        .collect();
    assert_eq!(added_unstaged, vec!["four"]);
}

#[test]
fn stages_and_unstages_a_whole_hunk() {
    let fixture = dirty_fixture();
    let base: String = (1..=30).map(|index| format!("line {index}\n")).collect();
    fixture.commit("large.txt", &base, "large");
    let modified = base
        .replace("line 2\n", "line two\n")
        .replace("line 25\n", "line twenty-five\n");
    fixture.write("large.txt", &modified);

    let working = diff(fixture.path(), DiffTarget::WorkingTree);
    assert_eq!(working.files[0].hunks.len(), 2);
    let selection = PathSelection {
        path: "large.txt".into(),
        hunks: vec![HunkSelection {
            hunk: 0,
            lines: None,
        }],
    };
    index::stage(fixture.runner(), fixture.path(), &[selection]).expect("stage hunk");
    let staged = diff(fixture.path(), DiffTarget::Index);
    assert_eq!(staged.files[0].hunks.len(), 1);
    assert!(staged.files[0].hunks[0]
        .lines
        .iter()
        .any(|line| line.content == "line two"));
    assert!(!staged.files[0]
        .lines()
        .iter()
        .any(|line| line.content == "line twenty-five"));

    let unstage = PathSelection {
        path: "large.txt".into(),
        hunks: vec![HunkSelection {
            hunk: 0,
            lines: None,
        }],
    };
    index::unstage(fixture.runner(), fixture.path(), &[unstage]).expect("unstage line");
    assert!(diff(fixture.path(), DiffTarget::Index).files.is_empty());
}

trait Lines {
    fn lines(&self) -> &[beebranch_git::diff::DiffLine];
}

impl Lines for beebranch_git::diff::FileDiff {
    fn lines(&self) -> &[beebranch_git::diff::DiffLine] {
        self.hunks
            .first()
            .map(|hunk| hunk.lines.as_slice())
            .unwrap_or(&[])
    }
}

#[test]
fn discard_requires_the_displayed_fingerprint() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "changed\n");
    let report = diff(fixture.path(), DiffTarget::WorkingTree);
    let fingerprint = report.files[0].fingerprint.clone().expect("fingerprint");
    let selection = PathSelection {
        path: "a.txt".into(),
        hunks: Vec::new(),
    };
    let expected = vec![Fingerprint {
        path: "a.txt".into(),
        sha256: Some(fingerprint),
    }];

    fixture.write("a.txt", "changed again\n");
    let error = index::discard(
        fixture.runner(),
        fixture.path(),
        std::slice::from_ref(&selection),
        &expected,
    )
    .expect_err("stale");
    assert_eq!(error.code, "discard.stale");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "changed again\n"
    );

    let current = diff(fixture.path(), DiffTarget::WorkingTree).files[0]
        .fingerprint
        .clone()
        .expect("fingerprint");
    index::discard(
        fixture.runner(),
        fixture.path(),
        &[selection],
        &[Fingerprint {
            path: "a.txt".into(),
            sha256: Some(current),
        }],
    )
    .expect("discard");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "base\n"
    );
}

#[test]
fn never_discards_an_untracked_file() {
    let fixture = dirty_fixture();
    fixture.write("untracked.txt", "keep me\n");
    let selection = PathSelection {
        path: "untracked.txt".into(),
        hunks: Vec::new(),
    };
    let fingerprint = index::fingerprint(fixture.path(), "untracked.txt").unwrap();
    let error = index::discard(
        fixture.runner(),
        fixture.path(),
        &[selection],
        &[Fingerprint {
            path: "untracked.txt".into(),
            sha256: fingerprint,
        }],
    )
    .expect_err("untracked");
    assert_eq!(error.code, "discard.untracked");
    assert!(fixture.path().join("untracked.txt").exists());
}

#[test]
fn preserves_crlf_and_missing_final_newline() {
    let fixture = dirty_fixture();
    fixture.write_bytes("crlf.txt", b"one\r\ntwo\r\nthree\r\n");
    fixture.add_all();
    fixture.commit_staged("crlf");
    fixture.write_bytes("crlf.txt", b"one\r\nTWO\r\nthree\r\n");
    let selection = PathSelection {
        path: "crlf.txt".into(),
        hunks: vec![HunkSelection {
            hunk: 0,
            lines: None,
        }],
    };
    index::stage(fixture.runner(), fixture.path(), &[selection]).expect("crlf stage");
    assert_eq!(
        file_content(&fixture, ":crlf.txt"),
        "one\r\nTWO\r\nthree\r\n"
    );

    fixture.write_bytes("nonewline.txt", b"first\nsecond");
    fixture.add_all();
    fixture.commit_staged("nonewline");
    fixture.write_bytes("nonewline.txt", b"first\nSECOND");
    index::stage(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "nonewline.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        }],
    )
    .expect("no newline stage");
    assert_eq!(file_content(&fixture, ":nonewline.txt"), "first\nSECOND");
}

#[test]
fn stages_a_unicode_and_executable_file() {
    let fixture = dirty_fixture();
    fixture.write("café.sh", "#!/bin/sh\necho base\n");
    fixture.add_all();
    fixture.commit_staged("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            fixture.path().join("café.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    fixture.write("café.sh", "#!/bin/sh\necho changed\n");
    index::stage(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "café.sh".into(),
            hunks: Vec::new(),
        }],
    )
    .expect("stage unicode");
    let staged = diff(fixture.path(), DiffTarget::Index);
    assert_eq!(staged.files[0].new_path, "café.sh");
    #[cfg(unix)]
    {
        let mode = CommandSpec::new(GitSubcommand::LsFiles, fixture.path())
            .arg("--stage")
            .arg("--");
        let outcome = fixture.runner().run(&mode).expect("ls-files");
        assert!(outcome.stdout.text_lossy().contains("100755"));
    }
}

#[test]
fn stages_rename_as_a_whole_file() {
    let fixture = dirty_fixture();
    fixture.commit("old.txt", "content\n", "old");
    std::fs::rename(
        fixture.path().join("old.txt"),
        fixture.path().join("new.txt"),
    )
    .unwrap();
    index::stage(
        fixture.runner(),
        fixture.path(),
        &[
            PathSelection {
                path: "old.txt".into(),
                hunks: Vec::new(),
            },
            PathSelection {
                path: "new.txt".into(),
                hunks: Vec::new(),
            },
        ],
    )
    .expect("stage rename");
    let status = fixture
        .runner()
        .run(&CommandSpec::new(GitSubcommand::Status, fixture.path()).args(["--porcelain=v2"]))
        .expect("status");
    assert!(!status.stdout.text_lossy().starts_with("1"));
}

#[test]
fn commit_runs_hooks_and_keeps_the_message_on_failure() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "next\n");
    fixture.add_all();
    let hook = fixture.path().join(".git/hooks/pre-commit");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&hook, "#!/bin/sh\necho hook failure\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let options = CommitOptions {
            message: "should not commit".into(),
            ..CommitOptions::default()
        };
        let error =
            commit::create(fixture.runner(), fixture.path(), &options).expect_err("hook must fail");
        assert!(error.message.contains("commit") || error.detail.is_some());
        assert!(error.detail.unwrap_or_default().contains("hook failure"));
        let head = fixture.rev_parse(&["HEAD"]);
        assert_eq!(head, fixture.rev_parse(&["HEAD"]));
        assert_eq!(fixture.detect().worktree.staged, 1);

        std::fs::write(&hook, "#!/bin/sh\necho hook ok\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let outcome = commit::create(fixture.runner(), fixture.path(), &options).expect("commit");
        assert!(outcome.output.contains("hook ok"));
        assert_ne!(outcome.sha, "base");
        assert_eq!(fixture.detect().worktree.staged, 0);
    }
}

#[test]
fn refuses_missing_identity_and_empty_index() {
    let fixture = dirty_fixture();
    fixture.config(&["user.email", ""]);
    fixture.write("a.txt", "next\n");
    fixture.add_all();
    let error = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "no identity".into(),
            ..CommitOptions::default()
        },
    )
    .expect_err("identity");
    assert_eq!(error.code, "git.identity_missing");

    fixture.config(&["user.email", "alice@example.test"]);
    fixture.run(GitSubcommand::Restore, &["--staged", "--", "a.txt"], &[]);
    let error = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "empty".into(),
            ..CommitOptions::default()
        },
    )
    .expect_err("empty");
    assert_eq!(error.code, "commit.empty");
}

#[test]
fn branch_preflight_and_delete_rules() {
    let fixture = dirty_fixture();
    fixture.branch("feature");
    let preflight =
        branches::preflight(fixture.runner(), fixture.path(), "feature").expect("preflight");
    assert!(preflight.merged);
    assert!(!preflight.current);

    fixture.switch_new("unmerged");
    fixture.commit("b.txt", "feature work\n", "feature work");
    fixture.switch("main");

    let unmerged =
        branches::preflight(fixture.runner(), fixture.path(), "unmerged").expect("preflight");
    assert!(!unmerged.merged);
    let error = branches::delete(fixture.runner(), fixture.path(), "unmerged", false)
        .expect_err("unmerged without force");
    assert_eq!(error.code, "branch.not_merged");
    let current = branches::preflight(fixture.runner(), fixture.path(), "main").expect("preflight");
    assert!(current.current);
    let error =
        branches::delete(fixture.runner(), fixture.path(), "main", true).expect_err("current");
    assert_eq!(error.code, "branch.current_delete");

    let sha =
        branches::delete(fixture.runner(), fixture.path(), "unmerged", true).expect("force delete");
    assert_eq!(sha.len(), 40);
}

#[test]
fn checkout_refuses_to_overwrite_local_changes() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.write("a.txt", "dirty\n");
    let error = branches::checkout(fixture.runner(), fixture.path(), Some("feature"), None)
        .expect_err("dirty checkout");
    assert!(matches!(
        error.code,
        "git.dirty_worktree" | "git.exit_unknown"
    ));
}

#[test]
fn merge_conflict_can_be_resolved_and_continued() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");

    let outcome =
        history::merge(fixture.runner(), fixture.path(), "feature", false).expect("merge");
    assert!(outcome.conflicted);
    assert!(!outcome.state.conflicts.files.is_empty());

    let refused = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "bypass".into(),
            ..CommitOptions::default()
        },
    )
    .expect_err("commit during merge must be refused");
    assert_eq!(refused.code, "operation.in_progress");

    fixture.write("a.txt", "resolved\n");
    history::mark_resolved(fixture.runner(), fixture.path(), "a.txt").expect("resolve");
    let continued =
        history::continue_operation(fixture.runner(), fixture.path()).expect("continue");
    assert!(continued.state.operation.is_none());
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "resolved\n"
    );
}

#[test]
fn merge_abort_restores_the_previous_state() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");
    let before = fixture.rev_parse(&["HEAD"]);

    let outcome =
        history::merge(fixture.runner(), fixture.path(), "feature", false).expect("merge");
    assert!(outcome.conflicted);
    let aborted = history::abort_operation(fixture.runner(), fixture.path()).expect("abort");
    assert!(aborted.state.operation.is_none());
    assert!(aborted.state.conflicts.is_empty());
    assert_eq!(fixture.rev_parse(&["HEAD"]), before);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "main\n"
    );
}

#[test]
fn stash_create_pop_and_drop_keep_work_recoverable() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "stashed change\n");
    stash::create(fixture.runner(), fixture.path(), "wip", false).expect("stash");
    assert_eq!(fixture.detect().worktree.unstaged, 0);
    let entries = stash::list(fixture.runner(), fixture.path()).expect("list");
    assert_eq!(entries.len(), 1);
    assert!(entries[0].message.contains("wip"));

    let outcome = stash::pop(fixture.runner(), fixture.path(), &entries[0].selector).expect("pop");
    assert!(outcome.applied);
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("a.txt")).unwrap(),
        "stashed change\n"
    );
    assert!(stash::list(fixture.runner(), fixture.path())
        .unwrap()
        .is_empty());

    stash::create(fixture.runner(), fixture.path(), "again", false).expect("stash again");
    let entry = stash::list(fixture.runner(), fixture.path())
        .unwrap()
        .remove(0);
    let sha = stash::drop(fixture.runner(), fixture.path(), &entry.selector).expect("drop");
    assert_eq!(sha, entry.sha);
}

#[test]
fn stash_pop_conflict_leaves_the_stash_intact() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "stashed\n");
    stash::create(fixture.runner(), fixture.path(), "conflict", false).expect("stash");
    fixture.write("a.txt", "committed\n");
    fixture.add_all();
    fixture.commit_staged("conflicting");

    let entries = stash::list(fixture.runner(), fixture.path()).unwrap();
    let outcome = stash::pop(fixture.runner(), fixture.path(), &entries[0].selector).expect("pop");
    assert!(!outcome.conflicts.is_empty());
    assert_eq!(
        stash::list(fixture.runner(), fixture.path()).unwrap().len(),
        1
    );
}

#[test]
fn search_is_bounded_and_filters_by_message_author_and_sha() {
    let fixture = dirty_fixture();
    fixture.commit("one.txt", "1\n", "alpha feature");
    fixture.commit("two.txt", "2\n", "beta fix");
    let sha = fixture.rev_parse(&["HEAD"]);

    let mut query = SearchQuery::new("alpha", SearchMode::Message);
    query.request = PageRequest::first(10);
    let result = search::run(fixture.runner(), fixture.path(), &query, 1).expect("search");
    assert_eq!(result.commits.len(), 1);
    assert!(result.commits[0].subject.contains("alpha"));

    let mut author = SearchQuery::new("Alice", SearchMode::Author);
    author.request = PageRequest::first(10);
    assert_eq!(
        search::run(fixture.runner(), fixture.path(), &author, 1)
            .unwrap()
            .commits
            .len(),
        3
    );

    let mut by_sha = SearchQuery::new(&sha, SearchMode::Sha);
    by_sha.request = PageRequest::first(10);
    let found = search::run(fixture.runner(), fixture.path(), &by_sha, 1).unwrap();
    assert_eq!(found.commits.len(), 1);
    assert_eq!(found.commits[0].sha, sha);

    let mut bounded = SearchQuery::new("", SearchMode::Message);
    bounded.depth = 1;
    bounded.text = "a".into();
    bounded.request = PageRequest::first(1);
    let result = search::run(fixture.runner(), fixture.path(), &bounded, 1).unwrap();
    assert!(result.truncated || result.next.is_none());
}

#[test]
fn ignore_pattern_is_written_once() {
    let fixture = dirty_fixture();
    index::add_ignore_pattern(fixture.path(), "*.log").expect("ignore");
    index::add_ignore_pattern(fixture.path(), "*.log").expect("ignore twice");
    let content = std::fs::read_to_string(fixture.path().join(".gitignore")).unwrap();
    assert_eq!(content.matches("*.log").count(), 1);
    assert!(index::add_ignore_pattern(fixture.path(), "../escape").is_err());
}

#[test]
fn fetch_and_push_stream_against_a_local_bare_remote() {
    let fixture = dirty_fixture();
    let bare = tempfile::tempdir().expect("bare");
    fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::Init, bare.path())
                .arg("--quiet")
                .arg("--bare"),
        )
        .expect("init bare")
        .ensure_success()
        .expect("bare init");
    fixture.run(
        GitSubcommand::Remote,
        &["add", "origin", bare.path().to_str().unwrap()],
        &[],
    );
    fixture.run(GitSubcommand::Push, &["-u", "origin", "main"], &[]);
    let first_sha = fixture.rev_parse(&["HEAD"]);

    fixture.commit("b.txt", "second\n", "second");
    let second_sha = fixture.rev_parse(&["HEAD"]);
    fixture.run(GitSubcommand::Push, &["origin", "main"], &[]);

    let push = PushRequest {
        remote: "origin".into(),
        branch: "main".into(),
        set_upstream: false,
        force_with_lease: None,
    };
    let command = sync::spawn_push(
        fixture.runner(),
        fixture.path(),
        &push,
        &beebranch_git::OperationContext::default(),
        |_| {},
    )
    .expect("spawn push");
    let outcome = sync::finish(command, SyncKind::Push, || None).expect("push");
    assert!(!outcome.output.is_empty());

    let bare_head = fixture
        .runner()
        .run(&CommandSpec::new(GitSubcommand::RevParse, bare.path()).args(["--verify", "HEAD"]))
        .expect("rev-parse bare");
    assert_eq!(bare_head.stdout.text_lossy().trim(), second_sha);
    assert_ne!(first_sha, second_sha);

    fixture.run(GitSubcommand::Reset, &["--hard", "HEAD~1"], &[]);
    let command = sync::spawn_fetch(
        fixture.runner(),
        fixture.path(),
        "origin",
        &beebranch_git::OperationContext::default(),
        |_| {},
    )
    .expect("spawn fetch");
    sync::finish(command, SyncKind::Fetch, || None).expect("fetch");
    let remote = fixture
        .runner()
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, fixture.path())
                .args(["--verify", "refs/remotes/origin/main"]),
        )
        .expect("remote ref");
    assert_eq!(remote.stdout.text_lossy().trim(), second_sha);

    let clean = fixture.rev_parse(&["HEAD"]);
    let pull = sync::spawn_pull(
        fixture.runner(),
        fixture.path(),
        "origin",
        "main",
        PullStrategy::FfOnly,
        &beebranch_git::OperationContext::default(),
        |_| {},
    )
    .expect("pull");
    sync::finish(pull, SyncKind::Pull, || None).expect("pull result");
    assert_ne!(fixture.rev_parse(&["HEAD"]), clean);
}

#[test]
fn amends_without_and_with_a_new_message() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "amended content\n");
    fixture.add_all();
    let first = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "first subject\n\nbody".into(),
            ..CommitOptions::default()
        },
    )
    .expect("commit");

    fixture.write("b.txt", "more\n");
    fixture.add_all();
    let keep = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: String::new(),
            amend: true,
            keep_message: true,
            allow_empty: false,
        },
    )
    .expect("amend keep");
    assert_ne!(keep.sha, first.sha);
    let detail = beebranch_git::commit::read_commit(fixture.runner(), fixture.path(), &keep.sha)
        .expect("detail");
    assert!(detail.message.starts_with("first subject"));

    let replaced = commit::create(
        fixture.runner(),
        fixture.path(),
        &CommitOptions {
            message: "replaced subject".into(),
            amend: true,
            ..CommitOptions::default()
        },
    )
    .expect("amend replace");
    let detail =
        beebranch_git::commit::read_commit(fixture.runner(), fixture.path(), &replaced.sha)
            .expect("detail");
    assert!(detail.message.starts_with("replaced subject"));
}

#[test]
fn compares_branches_and_reports_upstream() {
    let fixture = dirty_fixture();
    fixture.branch("feature");
    fixture.switch("feature");
    fixture.commit("b.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("c.txt", "main\n", "main");

    let comparison =
        branches::compare(fixture.runner(), fixture.path(), "main", "feature").expect("compare");
    assert_eq!(comparison.ahead, 1);
    assert_eq!(comparison.behind, 1);

    branches::set_upstream(fixture.runner(), fixture.path(), "feature", "main").expect("upstream");
    let preflight =
        branches::preflight(fixture.runner(), fixture.path(), "feature").expect("preflight");
    assert_eq!(preflight.upstream.as_deref(), Some("main"));
}

#[test]
fn state_is_recovered_after_restart_during_a_conflict() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");
    history::merge(fixture.runner(), fixture.path(), "feature", false).expect("merge");

    let session = beebranch_git::session::RepoSession::open(
        fixture.runner(),
        fixture.path(),
        beebranch_git::session::SessionOptions::default(),
    )
    .expect("reopen");
    assert!(session.state().operation.is_some());
    assert!(!session.state().conflicts.is_empty());
    session.shutdown();
}

#[test]
fn an_idle_operation_refuses_a_second_history_operation() {
    let fixture = dirty_fixture();
    fixture.switch_new("feature");
    fixture.commit("a.txt", "feature\n", "feature");
    fixture.switch("main");
    fixture.commit("a.txt", "main\n", "main");
    history::merge(fixture.runner(), fixture.path(), "feature", false).expect("merge");
    let error = history::rebase(fixture.runner(), fixture.path(), "feature").expect_err("busy");
    assert_eq!(error.code, "operation.in_progress");
}

#[test]
fn lists_ignored_files_only_on_request() {
    let fixture = dirty_fixture();
    index::add_ignore_pattern(fixture.path(), "*.log").expect("ignore");
    fixture.write("debug.log", "ignored\n");
    let without =
        beebranch_git::status::read_status_opts(fixture.runner(), fixture.path(), Some(100), false)
            .expect("status");
    assert!(without.ignored.is_empty());
    let with =
        beebranch_git::status::read_status_opts(fixture.runner(), fixture.path(), Some(100), true)
            .expect("status ignored");
    assert!(with.ignored.iter().any(|path| path == "debug.log"));
    assert!(with.entries.iter().any(|entry| entry.path == "debug.log"));
}

#[test]
fn unstages_and_discards_a_line_inside_a_mixed_hunk() {
    let fixture = dirty_fixture();
    fixture.commit("mixed.txt", "one\ntwo\nthree\n", "mixed");
    fixture.write("mixed.txt", "one\nTWO\nthree\nfour\n");

    let working = diff(fixture.path(), DiffTarget::WorkingTree);
    let two = working.files[0].hunks[0]
        .lines
        .iter()
        .position(|line| {
            line.kind == beebranch_git::diff::DiffLineKind::Added && line.content == "TWO"
        })
        .expect("TWO");
    index::stage(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "mixed.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![two]),
            }],
        }],
    )
    .expect("stage TWO");
    let staged = diff(fixture.path(), DiffTarget::Index);
    let staged_two = staged.files[0].hunks[0]
        .lines
        .iter()
        .position(|line| {
            line.kind == beebranch_git::diff::DiffLineKind::Added && line.content == "TWO"
        })
        .expect("staged TWO");
    index::unstage(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "mixed.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![staged_two]),
            }],
        }],
    )
    .expect("unstage TWO line");
    assert!(diff(fixture.path(), DiffTarget::Index).files.is_empty());

    let working = diff(fixture.path(), DiffTarget::WorkingTree);
    let four = working.files[0].hunks[0]
        .lines
        .iter()
        .position(|line| {
            line.kind == beebranch_git::diff::DiffLineKind::Added && line.content == "four"
        })
        .expect("four");
    let fingerprint = working.files[0].fingerprint.clone();
    index::discard(
        fixture.runner(),
        fixture.path(),
        &[PathSelection {
            path: "mixed.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![four]),
            }],
        }],
        &[Fingerprint {
            path: "mixed.txt".into(),
            sha256: fingerprint,
        }],
    )
    .expect("discard four");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("mixed.txt")).unwrap(),
        "one\nTWO\nthree\n"
    );
}

#[test]
fn rejects_mixed_whole_file_and_hunk_selections() {
    let fixture = dirty_fixture();
    fixture.write("a.txt", "changed\n");
    let error = index::stage(
        fixture.runner(),
        fixture.path(),
        &[
            PathSelection {
                path: "a.txt".into(),
                hunks: Vec::new(),
            },
            PathSelection {
                path: "a.txt".into(),
                hunks: vec![HunkSelection {
                    hunk: 0,
                    lines: None,
                }],
            },
        ],
    )
    .expect_err("mixed selection");
    assert_eq!(error.code, "index.mixed_selection");
}
