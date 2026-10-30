mod common;

use beebranch_git::{branches, stash, status, GitSubcommand};
use common::dirty_fixture;

#[test]
fn checkout_saves_staged_unstaged_and_untracked_work() {
    let repo = dirty_fixture();
    repo.branch("feature");
    repo.switch("feature");
    repo.commit("a.txt", "feature\n", "feature");
    repo.switch("main");
    repo.write("a.txt", "staged\n");
    repo.add_all();
    repo.write("a.txt", "unstaged\n");
    repo.write("new.txt", "new work\n");
    stash::create(repo.runner(), repo.path(), "older stash", true).unwrap();
    repo.write("a.txt", "staged\n");
    repo.add_all();
    repo.write("a.txt", "unstaged\n");
    repo.write("new.txt", "new work\n");

    let entry = branches::checkout_stashed(repo.runner(), repo.path(), Some("feature"), None)
        .unwrap()
        .unwrap();
    assert!(entry.message.contains("main → feature"));
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "feature\n"
    );
    assert!(!repo.path().join("new.txt").exists());
    assert!(status::read_status(repo.runner(), repo.path(), None)
        .unwrap()
        .counts
        .is_clean());
    assert_eq!(stash::list(repo.runner(), repo.path()).unwrap().len(), 2);

    repo.switch("main");
    stash::pop_indexed(repo.runner(), repo.path(), &entry.selector).unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.path().join("new.txt")).unwrap(),
        "new work\n"
    );
    assert_eq!(
        status::read_status(repo.runner(), repo.path(), None)
            .unwrap()
            .counts
            .staged,
        1
    );
    assert_eq!(
        stash::list(repo.runner(), repo.path()).unwrap()[0].message,
        "older stash"
    );
}

#[test]
fn failed_switch_restores_local_work_and_index() {
    let repo = dirty_fixture();
    repo.write("a.txt", "staged\n");
    repo.add_all();
    repo.write("a.txt", "unstaged\n");
    repo.write("new.txt", "new\n");
    let before = status::read_status(repo.runner(), repo.path(), None).unwrap();
    assert!(branches::checkout_stashed(repo.runner(), repo.path(), Some("missing"), None).is_err());
    assert_eq!(
        status::read_status(repo.runner(), repo.path(), None).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.path().join("new.txt")).unwrap(),
        "new\n"
    );
    assert!(stash::list(repo.runner(), repo.path()).unwrap().is_empty());
}

#[test]
fn clean_or_same_branch_checkout_does_not_stash() {
    let repo = dirty_fixture();
    repo.branch("feature");
    assert!(
        branches::checkout_stashed(repo.runner(), repo.path(), Some("feature"), None)
            .unwrap()
            .is_none()
    );
    repo.write("a.txt", "local\n");
    assert!(
        branches::checkout_stashed(repo.runner(), repo.path(), Some("feature"), None)
            .unwrap()
            .is_none()
    );
    assert!(stash::list(repo.runner(), repo.path()).unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "local\n"
    );
}

#[test]
fn remote_and_detached_checkout_also_stash() {
    let repo = dirty_fixture();
    let sha = repo.rev_parse(&["HEAD"]);
    repo.write("a.txt", "local\n");
    assert!(
        branches::checkout_reset_stashed(repo.runner(), repo.path(), "remote-feature", &sha)
            .unwrap()
            .is_some()
    );
    repo.write("new.txt", "new\n");
    assert!(
        branches::checkout_stashed(repo.runner(), repo.path(), None, Some(&sha))
            .unwrap()
            .is_some()
    );
    let report = status::read_status(repo.runner(), repo.path(), None).unwrap();
    assert!(report.branch.detached);
    assert!(report.counts.is_clean());
    assert_eq!(stash::list(repo.runner(), repo.path()).unwrap().len(), 2);
}

#[test]
fn unfinished_merge_is_not_stashed_or_switched() {
    let repo = dirty_fixture();
    repo.branch("feature");
    repo.commit("a.txt", "main\n", "main");
    repo.switch("feature");
    repo.commit("a.txt", "feature\n", "feature");
    repo.switch("main");
    repo.run_failure(GitSubcommand::Merge, &["feature"]);
    let before = status::read_status(repo.runner(), repo.path(), None).unwrap();
    assert!(branches::checkout_stashed(repo.runner(), repo.path(), Some("feature"), None).is_err());
    assert_eq!(
        status::read_status(repo.runner(), repo.path(), None).unwrap(),
        before
    );
    assert!(stash::list(repo.runner(), repo.path()).unwrap().is_empty());
}
