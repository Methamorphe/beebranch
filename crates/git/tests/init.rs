//! Local repository creation through the Git CLI.

use beebranch_git::init::{init, InitOptions};
use beebranch_git::GitRunner;

#[test]
fn creates_a_new_directory_on_the_requested_branch() {
    let root = tempfile::tempdir().expect("tempdir");
    let destination = root.path().join("fresh");
    let runner = GitRunner::detect().expect("git");

    let created = init(
        &runner,
        destination.to_str().expect("utf-8 path"),
        &InitOptions {
            initial_branch: Some("main".to_owned()),
        },
    )
    .expect("init");

    assert_eq!(created, destination.canonicalize().expect("canonical"));
    let head = std::fs::read_to_string(created.join(".git").join("HEAD")).expect("HEAD");
    assert!(head.contains("refs/heads/main"), "{head}");

    let registry = beebranch_git::session::SessionRegistry::new();
    let (session, created_session) = registry
        .open(
            &runner,
            &created,
            beebranch_git::session::SessionOptions::default(),
        )
        .expect("open initialized repository");
    assert!(created_session);
    assert_eq!(session.worktree(), created);
}

#[test]
fn initialises_an_existing_directory_without_touching_its_files() {
    let root = tempfile::tempdir().expect("tempdir");
    let destination = root.path().join("project");
    std::fs::create_dir(&destination).expect("create dir");
    std::fs::write(destination.join("README.md"), b"# Projet\n").expect("write");
    let runner = GitRunner::detect().expect("git");

    let created = init(
        &runner,
        destination.to_str().expect("utf-8 path"),
        &InitOptions::default(),
    )
    .expect("init");

    assert_eq!(
        std::fs::read_to_string(created.join("README.md")).expect("README"),
        "# Projet\n"
    );
    assert!(created.join(".git").is_dir());
}

#[test]
fn rejects_a_bare_repository() {
    let root = tempfile::tempdir().expect("tempdir");
    let destination = root.path().join("bare.git");
    let runner = GitRunner::detect().expect("git");
    let spec = beebranch_git::CommandSpec::new(beebranch_git::GitSubcommand::Init, root.path())
        .arg("--bare")
        .arg(&destination);
    let outcome = runner.run(&spec).expect("bare init");
    assert!(outcome.success(), "{}", outcome.stderr.text_lossy());

    let error = init(
        &runner,
        destination.to_str().expect("utf-8 path"),
        &InitOptions::default(),
    )
    .expect_err("bare repository");

    assert_eq!(error.code, "init.already_repository");
}

#[test]
fn rejects_an_invalid_initial_branch_before_creating_anything() {
    let root = tempfile::tempdir().expect("tempdir");
    let destination = root.path().join("invalid-branch");
    let runner = GitRunner::detect().expect("git");

    let error = init(
        &runner,
        destination.to_str().expect("utf-8 path"),
        &InitOptions {
            initial_branch: Some("bad name".to_owned()),
        },
    )
    .expect_err("invalid branch");

    assert_eq!(error.code, "branch.invalid_name");
    assert!(!destination.exists());
}
