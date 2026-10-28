use std::path::Path;
use std::sync::Arc;

use beebranch_app::commands::recovery::{collect, diagnostics};
use beebranch_app::state::{build_state, AppPaths};
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};
use beebranch_store::{
    IdentityRow, InstanceRow, MemorySecretStore, OperationState, SecretStore, Store,
};

fn git(runner: &GitRunner, dir: &Path, subcommand: GitSubcommand, args: &[&str], stdin: &[u8]) {
    let spec = CommandSpec::new(subcommand, dir)
        .args(args.iter().copied())
        .stdin(StdinMode::Bytes(stdin.to_vec()));
    let outcome = runner.run(&spec).expect("git");
    assert!(
        outcome.success(),
        "{subcommand}: {}",
        outcome.stderr.text_lossy()
    );
}

fn repository(dir: &Path, runner: &GitRunner) {
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
}

fn state(
    data_dir: &Path,
    store: Arc<Store>,
    secrets: Arc<dyn beebranch_store::SecretStore>,
) -> beebranch_app::state::AppState {
    build_state(
        AppPaths {
            data_dir: data_dir.to_path_buf(),
        },
        store,
        secrets,
    )
}

#[test]
fn recovery_reports_interrupted_operation_and_keeps_locks() {
    let data = tempfile::tempdir().expect("data");
    let repo = tempfile::tempdir().expect("repo");
    let runner = GitRunner::detect().expect("git");
    repository(repo.path(), &runner);

    let store = Arc::new(Store::open_in_memory().expect("store"));
    store
        .begin_operation(
            "op_fetch",
            "fetch",
            Some("repo_1"),
            Some(repo.path().to_str().unwrap()),
        )
        .expect("begin");
    let interrupted = store.interrupt_running_operations().expect("interrupt");
    assert_eq!(interrupted.len(), 1);

    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, b"lock").expect("lock");

    let state = state(data.path(), store, Arc::new(MemorySecretStore::new()));
    let items = collect(&state).expect("collect");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].operation.state, OperationState::Interrupted);
    assert!(items[0].repo_available);
    assert!(items[0]
        .locks
        .iter()
        .any(|path| path.ends_with("index.lock")));
    assert!(items[0].remediation.contains("Vérifiez"));
    assert!(lock.exists(), "locks must never be deleted automatically");
}

#[test]
fn diagnostics_export_carries_no_token() {
    let data = tempfile::tempdir().expect("data");
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(MemorySecretStore::new());

    let instance = InstanceRow {
        id: "gl_test".into(),
        base_url: "https://gitlab.example.test".into(),
        api_url: "https://gitlab.example.test/api/v4".into(),
        display_name: Some("Interne".into()),
        ca_bundle_id: None,
        created_at: 1,
    };
    store.upsert_instance(&instance).expect("instance");
    store
        .set_identity(&IdentityRow {
            instance_id: "gl_test".into(),
            user_id: 1,
            username: "alice".into(),
            name: Some("Alice".into()),
            avatar_url: None,
            validated_at: 2,
        })
        .expect("identity");
    secrets
        .set("gitlab.example.test#gl_test", "glpat-super-secret")
        .expect("secret");
    store
        .begin_operation("op_1", "fetch", None, None)
        .expect("begin");
    store
        .set_operation_detail("op_1", "Authorization: Bearer glpat-super-secret")
        .expect("detail");

    let state = state(data.path(), store, secrets);
    *state.gitlab_instance.lock().unwrap() = Some(instance);

    let export = diagnostics(&state).expect("export");
    assert!(export.contains("gitlab.example.test"));
    assert!(!export.contains("glpat-"));
    assert!(!export.contains("super-secret"));
    assert!(!export.contains("PRIVATE-TOKEN"));
}

#[test]
fn recovery_without_operations_is_empty() {
    let data = tempfile::tempdir().expect("data");
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let state = state(data.path(), store, Arc::new(MemorySecretStore::new()));
    assert!(collect(&state).expect("collect").is_empty());
}
