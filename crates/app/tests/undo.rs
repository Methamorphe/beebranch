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

// --- Regression scenarios of the undo/redo reliability audit -------------

mod reliability {
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;

    use beebranch_app::commands::undo::{redo_now, status_now, undo_exact, undo_now};
    use beebranch_app::commands::util::{
        run_mutation, run_undoable_mutation, UndoBuilder, UndoDraft, UndoMeta,
    };
    use beebranch_app::state::{build_state, AppPaths, AppState};
    use beebranch_core::AppError;
    use beebranch_git::session::{InvalidationArea, RepoSession, SessionOptions};
    use beebranch_git::undo::{self, Fingerprint, RestoreMode, ReversibleAction};
    use beebranch_git::GitRunner;
    use beebranch_store::{MemorySecretStore, Store};

    type Inverse = (ReversibleAction, Option<ReversibleAction>);

    /// Plain `git`, with a stable locale and dates, for fixtures and checks.
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("LC_ALL", "C")
            .env("GIT_COMMITTER_DATE", "2026-11-03T10:00:00+0100")
            .env("GIT_AUTHOR_DATE", "2026-11-03T10:00:00+0100")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn git_ok(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .expect("git")
            .status
            .success()
    }

    fn head(dir: &Path) -> String {
        git(dir, &["rev-parse", "HEAD"])
    }

    fn read(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).expect("read")
    }

    fn base(dir: &Path) {
        std::fs::write(dir.join("a.txt"), "one\n").expect("write");
        std::fs::write(dir.join("b.txt"), "bee\n").expect("write");
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "base"]);
    }

    struct Env {
        _data: tempfile::TempDir,
        repo: tempfile::TempDir,
        state: AppState,
        store: Arc<Store>,
        session: Arc<RepoSession>,
    }

    impl Env {
        fn new(init: impl FnOnce(&Path)) -> Self {
            let data = tempfile::tempdir().expect("data");
            let repo = tempfile::tempdir().expect("repo");
            git(repo.path(), &["init", "-q", "--initial-branch=main"]);
            git(repo.path(), &["config", "user.email", "a@b.c"]);
            git(repo.path(), &["config", "user.name", "Alice"]);
            init(repo.path());
            let runner = GitRunner::detect().expect("git");
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
            Self {
                _data: data,
                repo,
                state,
                store,
                session,
            }
        }

        fn dir(&self) -> &Path {
            self.repo.path()
        }

        fn id(&self) -> String {
            self.session.id().as_str().to_owned()
        }

        /// Record an operation through the real pipeline, with the inverse the
        /// matching Tauri command builds.
        async fn record(
            &self,
            touched: Vec<String>,
            job: impl FnOnce(&Path) + Send + 'static,
            inverse: impl FnOnce(&Fingerprint, &Fingerprint) -> Inverse + Send + 'static,
        ) -> String {
            run_undoable_mutation(
                self.session.clone(),
                self.store.clone(),
                UndoMeta {
                    kind: "test",
                    label: "test".to_owned(),
                    touched_refs: touched,
                    affected_files: Vec::new(),
                },
                move |_runner, discovery| {
                    job(discovery.worktree()?);
                    let builder: UndoBuilder =
                        Box::new(move |before: &Fingerprint, after: &Fingerprint| {
                            let (undo, redo) = inverse(before, after);
                            UndoDraft {
                                kind: "test".to_owned(),
                                label: "test".to_owned(),
                                undo,
                                redo,
                            }
                        });
                    Ok(((), vec![InvalidationArea::Head], builder))
                },
            )
            .await
            .expect("record")
            .undo_id
            .expect("recorded id")
        }

        /// Stage `content` in `file` and commit it like `commit_create`.
        async fn commit(&self, file: &str, content: &str) -> String {
            std::fs::write(self.dir().join(file), content).expect("write");
            git(self.dir(), &["add", "-A"]);
            let message = content.to_owned();
            self.record(
                Vec::new(),
                move |dir| {
                    git(dir, &["commit", "-q", "-m", &message]);
                },
                commit_inverse,
            )
            .await
        }

        async fn undo(&self) -> Result<String, AppError> {
            undo_now(&self.state, &self.id())
                .await
                .map(|outcome| outcome.record.state)
        }

        async fn redo(&self) -> Result<String, AppError> {
            redo_now(&self.state, &self.id())
                .await
                .map(|outcome| outcome.record.state)
        }
    }

    fn commit_inverse(before: &Fingerprint, after: &Fingerprint) -> Inverse {
        (
            undo::restore_to(before, RestoreMode::Soft),
            Some(undo::restore_to(after, RestoreMode::Soft)),
        )
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn successive_commit_undos_keep_the_staged_content_and_redo_in_order() {
        run(async {
            let env = Env::new(base);
            let c0 = head(env.dir());
            env.commit("a.txt", "two\n").await;
            let c1 = head(env.dir());
            env.commit("a.txt", "three\n").await;
            let c2 = head(env.dir());
            // An unrelated untracked file must not block a commit undo.
            std::fs::write(env.dir().join("notes.tmp"), "x").expect("write");

            env.undo().await.expect("undo second commit");
            assert_eq!(head(env.dir()), c1);
            env.undo().await.expect("undo first commit");
            assert_eq!(head(env.dir()), c0);
            assert_eq!(
                git(env.dir(), &["diff", "--cached", "--name-only"]),
                "a.txt"
            );
            assert_eq!(git(env.dir(), &["show", ":a.txt"]), "three");
            assert_eq!(read(env.dir(), "a.txt"), "three\n");

            env.redo().await.expect("redo first commit");
            assert_eq!(head(env.dir()), c1, "the last undo is redone first");
            env.redo().await.expect("redo second commit");
            assert_eq!(head(env.dir()), c2);
            assert_eq!(git(env.dir(), &["status", "--porcelain"]), "?? notes.tmp");
        });
    }

    #[test]
    fn a_commit_undo_is_refused_when_the_branch_moved() {
        run(async {
            let env = Env::new(base);
            env.commit("a.txt", "two\n").await;
            std::fs::write(env.dir().join("a.txt"), "outside\n").expect("write");
            git(env.dir(), &["commit", "-qam", "outside"]);
            let moved = head(env.dir());
            let error = env.undo().await.expect_err("HEAD moved");
            assert_eq!(error.code, "undo.precondition");
            assert_eq!(head(env.dir()), moved);
        });
    }

    #[test]
    fn redo_after_several_ref_undos_replays_them_in_reverse_order() {
        run(async {
            let env = Env::new(base);
            let sha = head(env.dir());
            for name in ["one", "two"] {
                let reference = format!("refs/heads/{name}");
                let (owned, sha) = (name.to_owned(), sha.clone());
                env.record(
                    vec![reference.clone()],
                    move |dir| {
                        git(dir, &["branch", &owned]);
                    },
                    move |_, _| {
                        (
                            ReversibleAction::DeleteRef {
                                reference: reference.clone(),
                                expected: sha.clone(),
                            },
                            Some(ReversibleAction::CreateRef {
                                reference,
                                sha,
                                upstream: None,
                            }),
                        )
                    },
                )
                .await;
            }
            env.undo().await.expect("undo two");
            env.undo().await.expect("undo one");
            let branches = || git(env.dir(), &["branch", "--format=%(refname:short)"]);
            assert_eq!(branches(), "main");

            env.redo().await.expect("redo one");
            assert_eq!(branches(), "main\none");
            env.redo().await.expect("redo two");
            assert_eq!(branches(), "main\none\ntwo");
            let error = env.redo().await.expect_err("nothing left to redo");
            assert_eq!(error.code, "redo.empty");
            env.undo().await.expect("undo two again");
            assert_eq!(branches(), "main\none");
        });
    }

    #[test]
    fn a_ref_undo_ignores_unrelated_worktree_changes() {
        run(async {
            let env = Env::new(|dir| {
                base(dir);
                git(dir, &["branch", "feature"]);
            });
            let sha = git(env.dir(), &["rev-parse", "feature"]);
            let reference = "refs/heads/feature".to_owned();
            let (undo_ref, redo_ref, undo_sha) =
                (reference.clone(), reference.clone(), sha.clone());
            env.record(
                vec![reference],
                |dir| {
                    git(dir, &["branch", "-D", "feature"]);
                },
                move |_, _| {
                    (
                        ReversibleAction::CreateRef {
                            reference: undo_ref,
                            sha: undo_sha.clone(),
                            upstream: None,
                        },
                        Some(ReversibleAction::DeleteRef {
                            reference: redo_ref,
                            expected: undo_sha,
                        }),
                    )
                },
            )
            .await;
            std::fs::write(env.dir().join("b.txt"), "edited\n").expect("write");
            git(env.dir(), &["add", "b.txt"]);
            std::fs::write(env.dir().join("new.txt"), "untracked\n").expect("write");

            env.undo().await.expect("undo branch deletion");
            assert_eq!(git(env.dir(), &["rev-parse", "feature"]), sha);
            assert_eq!(read(env.dir(), "b.txt"), "edited\n");
            assert_eq!(read(env.dir(), "new.txt"), "untracked\n");
        });
    }

    #[test]
    fn a_fetch_moving_the_upstream_does_not_block_a_commit_undo() {
        run(async {
            let env = Env::new(|dir| {
                base(dir);
                git(dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
                git(dir, &["config", "remote.origin.url", "/nonexistent"]);
                git(
                    dir,
                    &[
                        "config",
                        "remote.origin.fetch",
                        "+refs/heads/*:refs/remotes/origin/*",
                    ],
                );
                git(dir, &["config", "branch.main.remote", "origin"]);
                git(dir, &["config", "branch.main.merge", "refs/heads/main"]);
            });
            let c0 = head(env.dir());
            env.commit("a.txt", "two\n").await;
            // What a background fetch does: the remote-tracking ref moves and
            // the ahead/behind counts change.
            let tree = git(env.dir(), &["rev-parse", "HEAD~1^{tree}"]);
            let remote = git(
                env.dir(),
                &["commit-tree", &tree, "-p", &c0, "-m", "remote"],
            );
            git(
                env.dir(),
                &["update-ref", "refs/remotes/origin/main", &remote],
            );

            env.undo().await.expect("undo after fetch");
            assert_eq!(head(env.dir()), c0);
        });
    }

    fn diverged(dir: &Path) {
        base(dir);
        git(dir, &["switch", "-q", "-c", "feature"]);
        std::fs::write(dir.join("c.txt"), "feature\n").expect("write");
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "feature"]);
        git(dir, &["switch", "-q", "main"]);
        std::fs::write(dir.join("a.txt"), "main side\n").expect("write");
        git(dir, &["commit", "-qam", "main"]);
    }

    async fn record_merge(env: &Env) {
        env.record(
            Vec::new(),
            |dir| {
                let runner = GitRunner::detect().expect("git");
                let outcome =
                    beebranch_git::history::merge(&runner, dir, "feature", Default::default())
                        .expect("merge");
                assert!(outcome.state.operation.is_none(), "merge completed");
            },
            |before, after| {
                (
                    undo::restore_to(before, RestoreMode::Hard),
                    Some(undo::restore_to(after, RestoreMode::Hard)),
                )
            },
        )
        .await;
    }

    #[test]
    fn a_merge_undo_refuses_to_discard_uncommitted_tracked_work() {
        run(async {
            let env = Env::new(diverged);
            let before = head(env.dir());
            std::fs::write(env.dir().join("b.txt"), "MY UNCOMMITTED WORK\n").expect("write");
            record_merge(&env).await;
            let merged = head(env.dir());
            assert_ne!(merged, before);

            let status = status_now(&env.state, &env.id()).await.expect("status");
            let blocked = status
                .undo
                .and_then(|entry| entry.blocked)
                .expect("blocked");
            assert_eq!(blocked.code, "undo.worktree_dirty");

            let error = env.undo().await.expect_err("dirty worktree");
            assert_eq!(error.code, "undo.worktree_dirty");
            assert_eq!(read(env.dir(), "b.txt"), "MY UNCOMMITTED WORK\n");
            assert_eq!(head(env.dir()), merged, "nothing was applied");

            // The remediation works: stash, undo, then get the work back.
            git(env.dir(), &["stash", "-q"]);
            env.undo().await.expect("undo on a clean worktree");
            assert_eq!(head(env.dir()), before);
            assert!(!env.dir().join("c.txt").exists());
            git(env.dir(), &["stash", "pop", "-q"]);
            assert_eq!(read(env.dir(), "b.txt"), "MY UNCOMMITTED WORK\n");
        });
    }

    #[test]
    fn a_merge_undo_never_overwrites_an_untracked_file() {
        run(async {
            let env = Env::new(|dir| {
                diverged(dir);
                // The merge will delete `gone.txt` (removed on feature).
                std::fs::write(dir.join("gone.txt"), "tracked\n").expect("write");
                git(dir, &["add", "gone.txt"]);
                git(dir, &["commit", "-qm", "gone"]);
                git(dir, &["switch", "-q", "feature"]);
                git(dir, &["merge", "-q", "--no-edit", "main"]);
                git(dir, &["rm", "-q", "gone.txt"]);
                git(dir, &["commit", "-qm", "remove gone"]);
                git(dir, &["switch", "-q", "main"]);
            });
            record_merge(&env).await;
            let merged = head(env.dir());
            assert!(!env.dir().join("gone.txt").exists());
            // Untracked after the merge; the undo would write it back.
            std::fs::write(env.dir().join("gone.txt"), "MINE\n").expect("write");

            let error = env.undo().await.expect_err("untracked file in the way");
            assert_eq!(read(env.dir(), "gone.txt"), "MINE\n");
            assert_ne!(error.code, "undo.worktree_dirty", "{error:?}");
            assert_eq!(head(env.dir()), merged);
        });
    }

    #[test]
    fn an_annotated_tag_round_trip_keeps_the_tag_object() {
        run(async {
            let env = Env::new(|dir| {
                base(dir);
                git(dir, &["tag", "-a", "v1", "-m", "Release v1\n\nBody line"]);
            });
            let original = git(env.dir(), &["rev-parse", "refs/tags/v1"]);
            let reference = "refs/tags/v1".to_owned();
            let (sha, undo_ref) = (original.clone(), reference.clone());
            env.record(
                vec![reference],
                |dir| {
                    let runner = GitRunner::detect().expect("git");
                    beebranch_git::refs_admin::delete_tag(&runner, dir, "v1").expect("delete");
                },
                // Same inverse as `tag_delete`.
                move |_, _| {
                    let _ = undo_ref;
                    (
                        ReversibleAction::RestoreTag {
                            name: "v1".to_owned(),
                            object: sha.clone(),
                            target: None,
                            message: None,
                            tagger: None,
                            tagger_email: None,
                            tagger_time: None,
                        },
                        Some(ReversibleAction::DeleteTag {
                            name: "v1".to_owned(),
                            expected: sha,
                        }),
                    )
                },
            )
            .await;
            env.undo().await.expect("undo tag deletion");
            assert_eq!(git(env.dir(), &["rev-parse", "refs/tags/v1"]), original);
            assert_eq!(git(env.dir(), &["cat-file", "-t", "v1"]), "tag");
            assert!(git(env.dir(), &["cat-file", "-p", "v1"]).contains("Body line"));
            env.redo().await.expect("redo tag deletion");
            assert!(!git_ok(
                env.dir(),
                &["rev-parse", "--verify", "-q", "refs/tags/v1"]
            ));
            env.undo().await.expect("undo again");
            assert_eq!(git(env.dir(), &["rev-parse", "refs/tags/v1"]), original);
        });
    }

    #[test]
    fn the_first_commit_of_a_repository_can_be_undone_and_redone() {
        run(async {
            let env = Env::new(|dir| {
                std::fs::write(dir.join("a.txt"), "one\n").expect("write");
            });
            env.record(
                Vec::new(),
                |dir| {
                    git(dir, &["add", "-A"]);
                    git(dir, &["commit", "-q", "-m", "first"]);
                },
                commit_inverse,
            )
            .await;
            let first = head(env.dir());
            env.undo().await.expect("undo first commit");
            assert!(!git_ok(env.dir(), &["rev-parse", "--verify", "-q", "HEAD"]));
            assert_eq!(git(env.dir(), &["status", "--porcelain"]), "A  a.txt");
            env.redo().await.expect("redo first commit");
            assert_eq!(head(env.dir()), first);
            assert_eq!(git(env.dir(), &["symbolic-ref", "--short", "HEAD"]), "main");
            assert_eq!(git(env.dir(), &["status", "--porcelain"]), "");
        });
    }

    #[test]
    fn an_unrecorded_mutation_clears_the_redo_branch() {
        run(async {
            let env = Env::new(base);
            env.commit("a.txt", "two\n").await;
            env.undo().await.expect("undo");
            assert!(status_now(&env.state, &env.id())
                .await
                .expect("status")
                .redo
                .is_some());

            std::fs::write(env.dir().join("b.txt"), "staged\n").expect("write");
            run_mutation(
                env.store.clone(),
                env.session.clone(),
                |_runner, discovery| {
                    git(discovery.worktree()?, &["add", "b.txt"]);
                    Ok(((), vec![InvalidationArea::Index]))
                },
            )
            .await
            .expect("stage");

            let status = status_now(&env.state, &env.id()).await.expect("status");
            assert!(status.redo.is_none(), "redo invalidated");
            assert!(status.undo.is_none(), "the undone commit stays undone");
            assert_eq!(env.redo().await.expect_err("no redo").code, "redo.empty");
        });
    }

    #[test]
    fn concurrent_undos_take_successive_records() {
        let env = Env::new(base);
        let c0 = head(env.dir());
        run(env.commit("a.txt", "two\n"));
        run(env.commit("a.txt", "three\n"));
        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2).map(|_| scope.spawn(|| run(env.undo()))).collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("thread"))
                .collect()
        });
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        assert_eq!(head(env.dir()), c0);
    }

    #[test]
    fn a_targeted_undo_refuses_once_the_stack_top_changed() {
        run(async {
            let env = Env::new(base);
            let committed = env.commit("a.txt", "two\n").await;
            let top = head(env.dir());
            env.commit("a.txt", "three\n").await;
            let latest = head(env.dir());
            let error = undo_exact(&env.state, &env.id(), &committed)
                .await
                .expect_err("not the top any more");
            assert_eq!(error.code, "undo.stale");
            assert_eq!(head(env.dir()), latest);
            env.undo().await.expect("undo the top");
            undo_exact(&env.state, &env.id(), &committed)
                .await
                .expect("now it is the top");
            assert_ne!(head(env.dir()), top);
        });
    }

    fn stash_list(dir: &Path) -> String {
        git(dir, &["stash", "list", "--format=%H"])
    }

    /// Branch drop with automatic stash, recorded with the inverse that
    /// `branch_integration_start` builds for a popped stash.
    async fn record_auto_stash_merge(env: &Env) {
        let outcome: Arc<std::sync::Mutex<Option<beebranch_git::integration::AutoStashOutcome>>> =
            Arc::default();
        let writer = outcome.clone();
        env.record(
            vec!["refs/heads/main".to_owned()],
            move |dir| {
                let runner = GitRunner::detect().expect("git");
                let result = beebranch_git::integration::start(
                    &runner,
                    dir,
                    "feature",
                    "main",
                    beebranch_git::integration::IntegrationMode::Merge,
                    Default::default(),
                )
                .expect("integration");
                *writer.lock().expect("lock") = result.auto_stash;
            },
            move |before, _after| {
                let stash = outcome.lock().expect("lock").clone().expect("auto stash");
                assert!(stash.popped, "the stash was re-applied");
                let head = before.head_sha.clone().expect("head");
                (
                    ReversibleAction::Sequence {
                        actions: vec![
                            ReversibleAction::RestoreHead {
                                target: undo::head_target(before),
                                sha: Some(head.clone()),
                                mode: RestoreMode::HardBeforeStash,
                                index_tree: Some(head),
                            },
                            ReversibleAction::ApplyStash {
                                selector: stash.selector,
                                expected_sha: stash.sha,
                                drop: false,
                                expected_status_hash: None,
                            },
                        ],
                    },
                    None,
                )
            },
        )
        .await;
    }

    #[test]
    fn an_auto_stash_integration_undo_refuses_after_a_further_edit() {
        run(async {
            let env = Env::new(diverged);
            std::fs::write(env.dir().join("b.txt"), "local\n").expect("write");
            record_auto_stash_merge(&env).await;
            let merged = head(env.dir());
            assert_eq!(read(env.dir(), "b.txt"), "local\n");
            // Same status line, different content.
            std::fs::write(env.dir().join("b.txt"), "local\nmore work\n").expect("write");

            let error = env.undo().await.expect_err("content changed");
            assert_eq!(error.code, "undo.precondition", "{error:?}");
            assert_eq!(read(env.dir(), "b.txt"), "local\nmore work\n");
            assert_eq!(head(env.dir()), merged);
        });
    }

    #[test]
    fn an_auto_stash_integration_undo_restores_the_local_changes() {
        run(async {
            let env = Env::new(diverged);
            let before = head(env.dir());
            std::fs::write(env.dir().join("b.txt"), "local\n").expect("write");
            record_auto_stash_merge(&env).await;
            env.undo().await.expect("undo");
            assert_eq!(head(env.dir()), before);
            assert_eq!(read(env.dir(), "b.txt"), "local\n");
            assert!(!env.dir().join("c.txt").exists());
        });
    }

    #[test]
    fn an_abort_undo_refuses_after_a_partial_conflict_resolution() {
        run(async {
            let env = Env::new(|dir| {
                diverged(dir);
                git(dir, &["switch", "-q", "feature"]);
                std::fs::write(dir.join("a.txt"), "feature side\n").expect("write");
                git(dir, &["commit", "-qam", "conflict"]);
                git(dir, &["switch", "-q", "main"]);
            });
            env.record(
                Vec::new(),
                |dir| {
                    let runner = GitRunner::detect().expect("git");
                    let outcome =
                        beebranch_git::history::merge(&runner, dir, "feature", Default::default())
                            .expect("merge");
                    assert!(outcome.state.operation.is_some(), "conflicted merge");
                },
                |_, after| {
                    (
                        ReversibleAction::AbortOperation {
                            operation: after.operation.clone().expect("operation"),
                        },
                        None,
                    )
                },
            )
            .await;
            // A resolution in progress: still unmerged, same status line.
            std::fs::write(env.dir().join("a.txt"), "half resolved\n").expect("write");
            let error = env.undo().await.expect_err("resolution in progress");
            assert_eq!(error.code, "undo.precondition", "{error:?}");
            assert_eq!(read(env.dir(), "a.txt"), "half resolved\n");
            assert!(git_ok(
                env.dir(),
                &["rev-parse", "-q", "--verify", "MERGE_HEAD"]
            ));
        });
    }

    #[test]
    fn a_stash_undo_drops_its_own_entry_even_after_another_push() {
        run(async {
            let env = Env::new(base);
            std::fs::write(env.dir().join("a.txt"), "mine\n").expect("write");
            let selector_sha: Arc<std::sync::Mutex<String>> = Arc::default();
            let writer = selector_sha.clone();
            env.record(
                vec!["refs/stash".to_owned()],
                move |dir| {
                    git(dir, &["stash", "push", "-q", "-m", "mine"]);
                    *writer.lock().expect("lock") = git(dir, &["rev-parse", "stash@{0}"]);
                },
                move |before, _| {
                    (
                        ReversibleAction::ApplyStash {
                            selector: "stash@{0}".to_owned(),
                            expected_sha: selector_sha.lock().expect("lock").clone(),
                            drop: true,
                            expected_status_hash: Some(before.status_hash.clone()),
                        },
                        None,
                    )
                },
            )
            .await;
            let ours = git(env.dir(), &["rev-parse", "stash@{0}"]);
            // Another stash pushed meanwhile becomes stash@{0}.
            std::fs::write(env.dir().join("b.txt"), "other\n").expect("write");
            git(env.dir(), &["stash", "push", "-q", "-m", "other"]);
            let other = git(env.dir(), &["rev-parse", "stash@{0}"]);
            // The worktree is clean again but `refs/stash` moved: refused.
            let error = env.undo().await.expect_err("stash ref moved");
            assert_eq!(error.code, "undo.precondition", "{error:?}");
            assert_eq!(stash_list(env.dir()), format!("{other}\n{ours}"));
        });
    }

    #[test]
    fn the_stash_drop_resolves_the_entry_by_commit() {
        let env = Env::new(base);
        std::fs::write(env.dir().join("a.txt"), "mine\n").expect("write");
        git(env.dir(), &["stash", "push", "-q", "-m", "mine"]);
        let ours = git(env.dir(), &["rev-parse", "stash@{0}"]);
        std::fs::write(env.dir().join("b.txt"), "other\n").expect("write");
        git(env.dir(), &["stash", "push", "-q", "-m", "other"]);
        let other = git(env.dir(), &["rev-parse", "stash@{0}"]);
        let runner = GitRunner::detect().expect("git");
        let discovery = beebranch_git::discover::discover(&runner, env.dir()).expect("discover");
        // A stale positional selector must not drop the newer entry.
        undo::apply(
            &runner,
            &discovery,
            &ReversibleAction::ApplyStash {
                selector: "stash@{0}".to_owned(),
                expected_sha: ours.clone(),
                drop: true,
                expected_status_hash: None,
            },
            &mut |_| Ok(()),
        )
        .expect("apply");
        assert_eq!(read(env.dir(), "a.txt"), "mine\n");
        assert_eq!(stash_list(env.dir()), other);
    }

    fn worktree_fixture(dir: &Path) {
        base(dir);
        let path = dir.join("wt");
        git(
            dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "side",
                path.to_str().expect("utf8"),
            ],
        );
    }

    /// Worktree removal recorded with the inverse `worktree_remove` builds.
    async fn record_worktree_removal(env: &Env, delete_branch: bool) -> String {
        let path = env.dir().join("wt").to_str().expect("utf8").to_owned();
        let side = git(env.dir(), &["rev-parse", "side"]);
        let (job_path, undo_path, redo_path) = (path.clone(), path.clone(), path.clone());
        env.record(
            vec!["refs/heads/side".to_owned()],
            move |dir| {
                let runner = GitRunner::detect().expect("git");
                beebranch_git::worktree::remove(&runner, dir, &job_path, true, delete_branch)
                    .expect("remove");
            },
            move |before, _| {
                let mut redo = vec![ReversibleAction::RemoveWorktree {
                    path: redo_path,
                    force: false,
                }];
                if delete_branch {
                    redo.push(ReversibleAction::DeleteRef {
                        reference: "refs/heads/side".to_owned(),
                        expected: before.refs["refs/heads/side"].clone(),
                    });
                }
                (
                    ReversibleAction::AddWorktree {
                        path: undo_path,
                        reference: if delete_branch {
                            side
                        } else {
                            "side".to_owned()
                        },
                        new_branch: delete_branch.then(|| "side".to_owned()),
                        detach: false,
                    },
                    Some(ReversibleAction::Sequence { actions: redo }),
                )
            },
        )
        .await;
        path
    }

    #[test]
    fn a_worktree_removal_redo_never_discards_edits_made_after_the_undo() {
        run(async {
            let env = Env::new(worktree_fixture);
            let path = record_worktree_removal(&env, false).await;
            env.undo().await.expect("undo removal");
            let file = Path::new(&path).join("a.txt");
            std::fs::write(&file, "edited in the worktree\n").expect("write");

            env.redo().await.expect_err("dirty worktree");
            assert_eq!(
                std::fs::read_to_string(&file).expect("read"),
                "edited in the worktree\n"
            );
        });
    }

    #[test]
    fn a_worktree_removal_with_its_branch_is_redone_completely() {
        run(async {
            let env = Env::new(worktree_fixture);
            let side = git(env.dir(), &["rev-parse", "side"]);
            let path = record_worktree_removal(&env, true).await;
            assert!(!git_ok(
                env.dir(),
                &["rev-parse", "-q", "--verify", "refs/heads/side"]
            ));
            env.undo().await.expect("undo removal");
            assert_eq!(git(env.dir(), &["rev-parse", "side"]), side);
            assert!(Path::new(&path).join("a.txt").exists());
            let state = env.redo().await.expect("redo removal");
            assert_eq!(state, "available");
            assert!(!git_ok(
                env.dir(),
                &["rev-parse", "-q", "--verify", "refs/heads/side"]
            ));
            assert!(!Path::new(&path).exists());
        });
    }

    #[test]
    fn a_pruned_annotated_tag_is_rebuilt_on_its_commit() {
        run(async {
            let env = Env::new(|dir| {
                base(dir);
                git(dir, &["tag", "-a", "v1", "-m", "Release v1"]);
            });
            let runner = GitRunner::detect().expect("git");
            let tag = beebranch_git::refs_admin::list_tags(&runner, env.dir())
                .expect("tags")
                .into_iter()
                .find(|tag| tag.name == "v1")
                .expect("v1");
            let original = tag.oid.clone();
            let commit = head(env.dir());
            env.record(
                vec!["refs/tags/v1".to_owned()],
                |dir| {
                    let runner = GitRunner::detect().expect("git");
                    beebranch_git::refs_admin::delete_tag(&runner, dir, "v1").expect("delete");
                },
                // Same inverse as `tag_delete`.
                move |_, _| {
                    (
                        ReversibleAction::RestoreTag {
                            name: tag.name.clone(),
                            object: tag.oid.clone(),
                            target: tag.target_oid.clone(),
                            message: tag.message.clone(),
                            tagger: tag.tagger.clone(),
                            tagger_email: tag.tagger_email.clone(),
                            tagger_time: tag.tagger_time,
                        },
                        Some(ReversibleAction::DeleteTag {
                            name: tag.name.clone(),
                            expected: tag.oid.clone(),
                        }),
                    )
                },
            )
            .await;
            git(env.dir(), &["reflog", "expire", "--expire=now", "--all"]);
            git(env.dir(), &["gc", "-q", "--prune=now"]);
            assert!(
                !git_ok(env.dir(), &["cat-file", "-e", &original]),
                "tag object pruned"
            );

            let state = env.undo().await.expect("undo rebuilds the tag");
            assert_eq!(state, "consumed");
            assert_eq!(git(env.dir(), &["cat-file", "-t", "v1"]), "tag");
            assert_eq!(git(env.dir(), &["rev-parse", "v1^{commit}"]), commit);
            assert!(git(env.dir(), &["cat-file", "-p", "v1"]).contains("Release v1"));
        });
    }

    #[test]
    fn a_failed_unrecorded_mutation_still_clears_the_redo_branch() {
        run(async {
            let env = Env::new(base);
            env.commit("a.txt", "two\n").await;
            env.undo().await.expect("undo");
            let error = run_mutation(
                env.store.clone(),
                env.session.clone(),
                |_runner, discovery| {
                    // Wrote, then failed: like a pull that stops on conflicts.
                    std::fs::write(discovery.worktree()?.join("b.txt"), "written\n")
                        .expect("write");
                    Err::<((), Vec<InvalidationArea>), _>(AppError::internal(
                        "failed after writing",
                    ))
                },
            )
            .await
            .expect_err("job failed");
            assert_eq!(error.detail.as_deref(), Some("failed after writing"));
            let status = status_now(&env.state, &env.id()).await.expect("status");
            assert!(status.redo.is_none(), "redo invalidated");
        });
    }
}
