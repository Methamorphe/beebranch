//! Session identity: the id returned to the frontend must resolve in the
//! registry, whatever spelling of the path opened the repository.

use std::path::Path;

use beebranch_core::RepoId;
use beebranch_git::session::{SessionOptions, SessionRegistry};
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};

fn repository(dir: &Path, runner: &GitRunner) {
    let steps = [
        (GitSubcommand::Init, vec!["--quiet"]),
        (GitSubcommand::Config, vec!["user.email", "a@b.c"]),
        (GitSubcommand::Config, vec!["user.name", "Alice"]),
        (GitSubcommand::Add, vec!["-A"]),
    ];
    std::fs::write(dir.join("a.txt"), "one\n").expect("write");
    for (subcommand, args) in steps {
        let outcome = runner
            .run(&CommandSpec::new(subcommand, dir).args(args.iter().copied()))
            .expect("git");
        assert!(outcome.success(), "{subcommand} {args:?}");
    }
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::Commit, dir)
                .args(["-F", "-"])
                .stdin(StdinMode::Bytes(b"first\n".to_vec())),
        )
        .expect("commit");
    assert!(outcome.success(), "commit");
}

#[test]
fn a_session_is_reachable_by_the_id_it_reports() {
    let root = tempfile::tempdir().expect("root");
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).expect("mkdir");
    let runner = GitRunner::detect().expect("git");
    repository(&repo, &runner);

    let registry = SessionRegistry::new();
    // A trailing `.` is a different string for `fs::canonicalize` inputs than
    // the worktree Git reports: the registry must still agree with the session.
    let (session, created) = registry
        .open(&runner, repo.join("."), SessionOptions::default())
        .expect("open");
    assert!(created);

    let by_id = RepoId::from_raw(session.id().as_str());
    assert!(
        registry.get(&by_id).is_some(),
        "the id returned to the frontend must resolve in the registry"
    );

    let (again, created_again) = registry
        .open(&runner, &repo, SessionOptions::default())
        .expect("reopen");
    assert!(!created_again, "the same worktree reuses its session");
    assert_eq!(again.id(), session.id());
    assert_eq!(registry.len(), 1);
}
