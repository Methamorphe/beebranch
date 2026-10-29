//! Multi-repository workspace actions: bounded concurrency, isolated failures
//! and session cleanup.

use std::path::Path;
use std::sync::Arc;

use beebranch_app::commands::workspaces::{run_sync_workers, WorkspaceAction};
use beebranch_app::state::{build_state, AppPaths};
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, SessionRegistry, StdinMode};
use beebranch_store::{MemorySecretStore, Store, WorkspaceRepoRow};

fn git(runner: &GitRunner, dir: &Path, subcommand: GitSubcommand, args: &[&str]) {
    let outcome = runner
        .run(&CommandSpec::new(subcommand, dir).args(args.iter().copied()))
        .expect("git");
    assert!(outcome.success(), "{subcommand} {args:?}");
}

fn git_stdin(
    runner: &GitRunner,
    dir: &Path,
    subcommand: GitSubcommand,
    args: &[&str],
    stdin: &[u8],
) {
    let outcome = runner
        .run(
            &CommandSpec::new(subcommand, dir)
                .args(args.iter().copied())
                .stdin(StdinMode::Bytes(stdin.to_vec())),
        )
        .expect("git");
    assert!(outcome.success(), "{subcommand} {args:?}");
}

fn current_branch(runner: &GitRunner, path: &Path) -> String {
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::RevParse, path)
                .arg("--abbrev-ref")
                .arg("HEAD"),
        )
        .expect("branch");
    outcome.stdout.text_lossy().trim().to_owned()
}

fn repo(root: &Path, name: &str, with_remote: bool) -> std::path::PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).expect("mkdir");
    let runner = GitRunner::detect().expect("git");
    git(&runner, &path, GitSubcommand::Init, &["--quiet"]);
    // Windows runners default to core.autocrlf=true, which would turn the
    // checked-out fixtures into CRLF and break byte-level assertions.
    git(
        &runner,
        &path,
        GitSubcommand::Config,
        &["core.autocrlf", "false"],
    );
    git(&runner, &path, GitSubcommand::Config, &["core.eol", "lf"]);
    git(
        &runner,
        &path,
        GitSubcommand::Config,
        &["user.email", "a@b.c"],
    );
    git(
        &runner,
        &path,
        GitSubcommand::Config,
        &["user.name", "Alice"],
    );
    std::fs::write(path.join("a.txt"), "one\n").expect("write");
    git(&runner, &path, GitSubcommand::Add, &["-A"]);
    git_stdin(
        &runner,
        &path,
        GitSubcommand::Commit,
        &["-F", "-"],
        b"first\n",
    );
    if with_remote {
        let remote = bare(root, &format!("{name}-remote.git"));
        git(
            &runner,
            &path,
            GitSubcommand::Remote,
            &["add", "origin", &remote.display().to_string()],
        );
        let branch = current_branch(&runner, &path);
        git(
            &runner,
            &path,
            GitSubcommand::Push,
            &["-u", "origin", &branch],
        );
    }
    path
}

fn bare(root: &Path, name: &str) -> std::path::PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).expect("mkdir");
    let runner = GitRunner::detect().expect("git");
    git(&runner, &path, GitSubcommand::Init, &["--bare"]);
    path
}

#[test]
fn ten_repositories_report_per_repository_results_and_cleanup_sessions() {
    let root = tempfile::tempdir().expect("root");
    let runner = GitRunner::detect().expect("git");
    let mut rows = Vec::new();
    for index in 0..9 {
        let path = repo(root.path(), &format!("repo-{index}"), true);
        rows.push(WorkspaceRepoRow {
            workspace_id: "ws".to_owned(),
            path: path.display().to_string(),
            name: Some(format!("repo-{index}")),
            added_at: index as i64,
        });
    }
    let no_remote = repo(root.path(), "repo-9", false);
    rows.push(WorkspaceRepoRow {
        workspace_id: "ws".to_owned(),
        path: no_remote.display().to_string(),
        name: Some("repo-9".to_owned()),
        added_at: 9,
    });

    let registry = Arc::new(SessionRegistry::new());
    let results = run_sync_workers(runner, registry.clone(), rows, WorkspaceAction::Fetch);
    assert_eq!(results.len(), 10);
    assert_eq!(results.iter().filter(|result| result.ok).count(), 9);
    let failed = results.iter().find(|result| !result.ok).expect("failure");
    assert_eq!(failed.name.as_deref(), Some("repo-9"));
    assert_eq!(failed.error_code.as_deref(), Some("workspace.no_remote"));
    assert_eq!(
        registry.len(),
        0,
        "sessions opened for the action are closed"
    );
}

#[test]
fn pull_is_isolated_and_requires_explicit_confirmation() {
    let root = tempfile::tempdir().expect("root");
    let runner = GitRunner::detect().expect("git");
    let clean = repo(root.path(), "clean", true);
    let dirty = repo(root.path(), "dirty", true);
    let clean_remote = root.path().join("clean-remote.git");
    let clean_branch = current_branch(&runner, &clean);

    // A second clone advances the clean repository's remote.
    let other = root.path().join("other");
    git(
        &runner,
        root.path(),
        GitSubcommand::Clone,
        &[
            &clean_remote.display().to_string(),
            &other.display().to_string(),
        ],
    );
    git(
        &runner,
        &other,
        GitSubcommand::Config,
        &["user.email", "a@b.c"],
    );
    git(
        &runner,
        &other,
        GitSubcommand::Config,
        &["user.name", "Alice"],
    );
    std::fs::write(other.join("a.txt"), "two\n").expect("write");
    git(&runner, &other, GitSubcommand::Add, &["-A"]);
    git_stdin(
        &runner,
        &other,
        GitSubcommand::Commit,
        &["-F", "-"],
        b"second\n",
    );
    git(
        &runner,
        &other,
        GitSubcommand::Push,
        &["origin", &clean_branch],
    );

    std::fs::write(dirty.join("a.txt"), "dirty\n").expect("write");
    let rows = vec![
        WorkspaceRepoRow {
            workspace_id: "ws".to_owned(),
            path: clean.display().to_string(),
            name: Some("clean".to_owned()),
            added_at: 0,
        },
        WorkspaceRepoRow {
            workspace_id: "ws".to_owned(),
            path: dirty.display().to_string(),
            name: Some("dirty".to_owned()),
            added_at: 1,
        },
    ];
    let registry = Arc::new(SessionRegistry::new());
    let results = run_sync_workers(runner, registry.clone(), rows, WorkspaceAction::Pull);
    assert_eq!(results.len(), 2);
    let clean_result = results
        .iter()
        .find(|result| result.name.as_deref() == Some("clean"))
        .expect("clean");
    assert!(clean_result.ok, "{}", clean_result.message);
    let dirty_result = results
        .iter()
        .find(|result| result.name.as_deref() == Some("dirty"))
        .expect("dirty");
    assert!(!dirty_result.ok);
    assert!(dirty_result
        .error_code
        .as_deref()
        .unwrap_or_default()
        .contains("git.dirty"));
    assert_eq!(
        std::fs::read_to_string(clean.join("a.txt")).expect("read"),
        "two\n"
    );
    assert_eq!(
        std::fs::read_to_string(dirty.join("a.txt")).expect("read"),
        "dirty\n"
    );
    assert_eq!(registry.len(), 0);
}

#[test]
fn workspace_store_roundtrip_does_not_execute_git() {
    let data = tempfile::tempdir().expect("data");
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let _state = build_state(
        AppPaths {
            data_dir: data.path().to_path_buf(),
        },
        store.clone(),
        Arc::new(MemorySecretStore::new()),
    );
    let workspace = store.create_workspace("Produit").expect("create");
    assert_eq!(workspace.name, "Produit");
    store
        .add_workspace_repo(&workspace.id, "/tmp/example", Some("example"))
        .expect("add");
    assert_eq!(store.workspace_repos(&workspace.id).expect("list").len(), 1);
    let renamed = store
        .rename_workspace(&workspace.id, "Client")
        .expect("rename");
    assert_eq!(renamed.name, "Client");
    assert!(store.delete_workspace(&workspace.id).expect("delete"));
}
