//! `AppState::session` is the lookup every read command performs; it must find
//! a repository opened through the registry under the id it returned.

use std::path::Path;
use std::sync::Arc;

use beebranch_app::state::{build_state, AppPaths};
use beebranch_git::session::SessionOptions;
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};
use beebranch_store::{MemorySecretStore, Store};

fn repository(dir: &Path, runner: &GitRunner) {
    std::fs::write(dir.join("a.txt"), "one\n").expect("write");
    for (subcommand, args) in [
        (GitSubcommand::Init, vec!["--quiet"]),
        (GitSubcommand::Config, vec!["user.email", "a@b.c"]),
        (GitSubcommand::Config, vec!["user.name", "Alice"]),
        (GitSubcommand::Add, vec!["-A"]),
    ] {
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
fn an_opened_repository_is_reachable_by_the_id_returned_to_the_frontend() {
    let data = tempfile::tempdir().expect("data");
    let root = tempfile::tempdir().expect("root");
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).expect("mkdir");
    let runner = GitRunner::detect().expect("git");
    repository(&repo, &runner);

    let state = build_state(
        AppPaths {
            data_dir: data.path().to_path_buf(),
        },
        Arc::new(Store::open_in_memory().expect("store")),
        Arc::new(MemorySecretStore::new()),
    );

    let (session, created) = state
        .sessions
        .open(&runner, &repo, SessionOptions::default())
        .expect("open");
    assert!(created);

    // Exactly what `repo_get_state`, `status_get`, `refs_get`… do with the
    // `repoId` echoed by the frontend. On Windows this used to fail with
    // `repo.not_open` because the registry key and the session id came from
    // two different spellings of the worktree path.
    let resolved = state
        .session(session.id().as_str())
        .expect("session found by its own id");
    assert_eq!(resolved.id(), session.id());
    assert_eq!(resolved.worktree(), session.worktree());
}
