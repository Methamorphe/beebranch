use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use beebranch_git::{
    CaptureLimits, CommandSpec, GitCapability, GitErrorCode, GitRunner, GitSubcommand,
    ProcessEvent, StdinMode,
};

struct TempRepo {
    path: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        let path = std::env::temp_dir().join(format!(
            "beebranch-git-it-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("create temp repo directory");
        let status = Command::new("git")
            .arg("init")
            .arg("--initial-branch=main")
            .arg(&path)
            .status()
            .expect("git init");
        assert!(status.success(), "git init failed");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn runner() -> GitRunner {
    GitRunner::detect().expect("git must be installed for integration tests")
}

fn status_spec(repo: &Path) -> CommandSpec {
    CommandSpec::new(GitSubcommand::Status, repo)
        .arg("--porcelain=v2")
        .arg("-z")
        .arg("--branch")
        .arg("--untracked-files=all")
}

#[test]
fn detects_version_and_features() {
    let runner = runner();
    let cwd = std::env::current_dir().expect("current dir");
    let capability = GitCapability::detect(&runner, &cwd).expect("detect capability");

    assert!(capability.version.is_supported());
    assert!(capability.features.status_porcelain_v2);
    assert!(capability.features.switch_restore);
    assert!(capability.features.worktree_porcelain);
}

#[test]
fn runs_status_on_a_real_repository() {
    let repo = TempRepo::new();
    std::fs::write(repo.path().join("hello.txt"), "hello").expect("write file");

    let outcome = runner().run(&status_spec(repo.path())).expect("status");

    assert!(outcome.success(), "stderr: {}", outcome.stderr.redacted());
    let text = outcome.stdout.text_lossy();
    assert!(text.contains("# branch.oid"));
    assert!(text.contains("hello.txt"));
    assert!(!outcome.stdout.truncated());
}

#[test]
fn reports_a_stable_failure_code() {
    let repo = TempRepo::new();
    let spec = CommandSpec::new(GitSubcommand::RevParse, repo.path())
        .arg("--verify")
        .arg("refs/heads/missing");

    let outcome = runner().run(&spec).expect("rev-parse");
    assert!(!outcome.success());

    let error = outcome.ensure_success().expect_err("must fail");
    assert_eq!(error.code(), GitErrorCode::ExitFailure);
    assert!(error.detail().is_some());
}

#[test]
fn arguments_are_not_interpreted_by_a_shell() {
    let repo = TempRepo::new();
    let filename = "a b; touch pwned";
    std::fs::write(repo.path().join(filename), "x").expect("write file");

    let outcome = runner()
        .run(&CommandSpec::new(GitSubcommand::Add, repo.path()).path(filename))
        .expect("git add");
    assert!(outcome.success(), "stderr: {}", outcome.stderr.redacted());

    assert!(
        !repo.path().join("pwned").exists(),
        "a shell must never interpret an argument"
    );

    let status = runner().run(&status_spec(repo.path())).expect("status");
    assert!(status.stdout.text_lossy().contains(filename));
}

#[cfg(unix)]
#[test]
fn preserves_quotes_and_expansions_as_literal_arguments() {
    let repo = TempRepo::new();
    let filename = "quote\" ' $HOME `id`";
    std::fs::write(repo.path().join(filename), "x").expect("write file");

    let outcome = runner()
        .run(&CommandSpec::new(GitSubcommand::Add, repo.path()).path(filename))
        .expect("git add");
    assert!(outcome.success(), "stderr: {}", outcome.stderr.redacted());

    let status = runner().run(&status_spec(repo.path())).expect("status");
    assert!(status.stdout.text_lossy().contains(filename));
}

#[test]
fn streams_redacted_events() {
    let repo = TempRepo::new();
    let spec = CommandSpec::new(GitSubcommand::Version, repo.path()).streaming();

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let running = runner()
        .spawn(&spec, move |event| {
            sink.lock().expect("events").push(event);
        })
        .expect("spawn");
    let outcome = running.wait().expect("wait");
    assert!(outcome.success());

    let events = events.lock().expect("events");
    assert!(events
        .iter()
        .any(|event| matches!(event, ProcessEvent::Started { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, ProcessEvent::Stdout(line) if line.contains("git version"))));
    assert!(events
        .iter()
        .any(|event| matches!(event, ProcessEvent::Finished { .. })));
}

#[test]
fn bounds_captured_output_end_to_end() {
    let repo = TempRepo::new();
    let spec =
        CommandSpec::new(GitSubcommand::Version, repo.path()).capture_limits(CaptureLimits {
            stdout: 4,
            stderr: 16,
        });

    let outcome = runner().run(&spec).expect("version");
    assert!(outcome.success());
    assert_eq!(outcome.stdout.bytes().len(), 4);
    assert!(outcome.stdout.truncated());
}

#[test]
fn supports_file_stdin() {
    let repo = TempRepo::new();
    let input = repo.path().join("stdin.txt");
    std::fs::write(&input, b"").expect("write stdin");

    let spec = CommandSpec::new(GitSubcommand::CatFile, repo.path())
        .arg("--batch")
        .stdin(StdinMode::File(input));

    let outcome = runner().run(&spec).expect("cat-file");
    assert!(outcome.success(), "stderr: {}", outcome.stderr.redacted());
}

#[test]
fn rejects_non_allowlisted_arguments_before_spawn() {
    let repo = TempRepo::new();
    let spec = status_spec(repo.path()).arg("--exec-path=/tmp");

    let error = runner().run(&spec).expect_err("must reject");
    assert_eq!(error.code(), GitErrorCode::InvalidArgument);
}

#[test]
fn rejects_traversal_paths() {
    let repo = TempRepo::new();
    let spec = status_spec(repo.path()).path("../outside");

    let error = runner().run(&spec).expect_err("must reject");
    assert_eq!(error.code(), GitErrorCode::InvalidArgument);
}

#[test]
fn rejects_missing_working_directory() {
    let missing =
        std::env::temp_dir().join(format!("beebranch-git-missing-{}", std::process::id()));
    let spec = CommandSpec::new(GitSubcommand::Status, missing);

    let error = runner().run(&spec).expect_err("must reject");
    assert_eq!(error.code(), GitErrorCode::InvalidArgument);
}
