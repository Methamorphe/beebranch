//! End-to-end undo pipeline: serialized recording, precondition refusal and
//! redo through the same commands the shell uses.

use std::path::Path;
use std::sync::Arc;

use beebranch_app::commands::undo::{redo_now, undo_now};
use beebranch_app::commands::util::{run_undoable_mutation, MutationResult, UndoDraft, UndoMeta};
use beebranch_app::state::{build_state, AppPaths};
use beebranch_git::commit::{CommitOptions, CommitOutcome};
use beebranch_git::session::{InvalidationArea, SessionOptions};
use beebranch_git::undo::{self, RestoreMode};
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};
use beebranch_store::{MemorySecretStore, Store};

fn git(runner: &GitRunner, dir: &Path, subcommand: GitSubcommand, args: &[&str], stdin: &[u8]) {
    let spec = CommandSpec::new(subcommand, dir)
        .args(args.iter().copied())
        .stdin(StdinMode::Bytes(stdin.to_vec()));
    let outcome = runner.run(&spec).expect("git");
    assert!(
        outcome.success(),
        "{subcommand} {args:?}: {}",
        outcome.stderr.text_lossy()
    );
}

fn repository(dir: &Path, runner: &GitRunner) -> String {
    git(runner, dir, GitSubcommand::Init, &["--quiet"], &[]);
    git(
        runner,
        dir,
        GitSubcommand::Config,
        &["user.email", "a@b.c"],
        &[],
    );
    git(
        runner,
        dir,
        GitSubcommand::Config,
        &["user.name", "Alice"],
        &[],
    );
    std::fs::write(dir.join("a.txt"), "one\n").expect("write");
    git(runner, dir, GitSubcommand::Add, &["-A"], &[]);
    git(runner, dir, GitSubcommand::Commit, &["-F", "-"], b"first\n");
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, dir)
                .arg("--verify")
                .arg("HEAD"),
        )
        .expect("rev-parse");
    outcome.stdout.text_lossy().trim().to_owned()
}

fn head(runner: &GitRunner, dir: &Path) -> String {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, dir)
                .arg("--verify")
                .arg("HEAD"),
        )
        .expect("rev-parse");
    outcome.stdout.text_lossy().trim().to_owned()
}

#[test]
fn commit_is_recorded_undone_redone_and_refused_after_a_new_commit() {
    tauri::async_runtime::block_on(async {
        let data = tempfile::tempdir().expect("data");
        let repo = tempfile::tempdir().expect("repo");
        let runner = GitRunner::detect().expect("git");
        let first = repository(repo.path(), &runner);

        let store = Arc::new(Store::open_in_memory().expect("store"));
        let state = build_state(
            AppPaths {
                data_dir: data.path().to_path_buf(),
            },
            store.clone(),
            Arc::new(MemorySecretStore::new()),
        );
        let (session, _) = state
            .sessions
            .open(&runner, repo.path(), SessionOptions::default())
            .expect("session");

        std::fs::write(repo.path().join("a.txt"), "two\n").expect("write");
        git(&runner, repo.path(), GitSubcommand::Add, &["-A"], &[]);

        let outcome: MutationResult<CommitOutcome> = run_undoable_mutation(
            session.clone(),
            store.clone(),
            UndoMeta {
                kind: "commit",
                label: "commit de test".to_owned(),
                touched_refs: Vec::new(),
                affected_files: Vec::new(),
            },
            |runner, discovery| {
                let worktree = discovery.worktree()?;
                let outcome = beebranch_git::commit::create(
                    runner,
                    worktree,
                    &CommitOptions {
                        message: "second".to_owned(),
                        amend: false,
                        keep_message: false,
                        allow_empty: false,
                        ..CommitOptions::default()
                    },
                )?;
                let builder = Box::new(
                    |before: &beebranch_git::undo::Fingerprint,
                     after: &beebranch_git::undo::Fingerprint| UndoDraft {
                        kind: "commit".to_owned(),
                        label: "commit de test".to_owned(),
                        undo: undo::restore_to(before, RestoreMode::Soft),
                        redo: Some(undo::restore_to(after, RestoreMode::Soft)),
                    },
                );
                Ok((
                    outcome,
                    vec![InvalidationArea::Head, InvalidationArea::Index],
                    builder,
                ))
            },
        )
        .await
        .expect("recorded commit");
        let second = outcome.data.sha;
        assert_ne!(first, second);

        let undone = undo_now(&state, session.id().as_str()).await.expect("undo");
        assert_eq!(head(&runner, repo.path()), first);
        assert!(undone.record.state == "consumed");

        let redone = redo_now(&state, session.id().as_str()).await.expect("redo");
        assert_eq!(head(&runner, repo.path()), second);
        assert!(redone.record.state == "available");

        // A new commit changed the state after the recorded operation; undo
        // must refuse without touching HEAD.
        std::fs::write(repo.path().join("a.txt"), "three\n").expect("write");
        git(&runner, repo.path(), GitSubcommand::Add, &["-A"], &[]);
        git(
            &runner,
            repo.path(),
            GitSubcommand::Commit,
            &["-F", "-"],
            b"third\n",
        );
        let third = head(&runner, repo.path());
        let error = undo_now(&state, session.id().as_str())
            .await
            .expect_err("stale fingerprint must refuse");
        assert_eq!(error.code, "undo.precondition", "{}", error.code);
        assert_eq!(head(&runner, repo.path()), third);
    });
}

#[test]
fn an_interrupted_restoration_is_never_retried_on_startup() {
    let store = Store::open_in_memory().expect("store");
    let record = store
        .record_undo(beebranch_store::NewUndoRecord {
            repo_id: "repo_1",
            kind: "commit",
            label: "commit",
            undo_json: "{}",
            redo_json: None,
            before_json: "{}",
            after_json: "{}",
            touched_refs_json: "[]",
        })
        .expect("record");
    store
        .set_undo_state(
            &record.id,
            beebranch_store::UndoState::Restoring,
            Some("restore-head"),
            Some("git reset --soft abc"),
            None,
            Some("abc"),
        )
        .expect("restoring");
    let interrupted = store.interrupt_restoring_undo().expect("interrupt");
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].step.as_deref(), Some("restore-head"));
    assert_eq!(
        interrupted[0].command.as_deref(),
        Some("git reset --soft abc")
    );
    assert_eq!(interrupted[0].recovery_sha.as_deref(), Some("abc"));
    assert_eq!(
        interrupted[0].state,
        beebranch_store::UndoState::RestoreInterrupted
    );
}
