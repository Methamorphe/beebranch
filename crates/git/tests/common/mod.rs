#![allow(dead_code)]

use std::path::{Path, PathBuf};

use beebranch_core::RepoState;
use beebranch_git::discover::discover;
use beebranch_git::state::detect;
use beebranch_git::{CommandSpec, GitRunner, GitSubcommand, StdinMode};

pub struct Fixture {
    dir: tempfile::TempDir,
    runner: GitRunner,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let runner = GitRunner::detect().expect("git");
        let fixture = Self { dir, runner };
        fixture.init();
        fixture.config(&["user.email", "alice@example.test"]);
        fixture.config(&["user.name", "Alice"]);
        fixture
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    pub fn config(&self, args: &[&str]) {
        self.run(GitSubcommand::Config, args, &[]);
    }

    pub fn init(&self) {
        // `--initial-branch` pins the branch name: without it the fixture
        // follows the runner's `init.defaultBranch`, and CI defaults to
        // `master` while the tests address `main`.
        self.run(
            GitSubcommand::Init,
            &["--quiet", "--initial-branch=main"],
            &[],
        );
    }

    pub fn run(&self, subcommand: GitSubcommand, args: &[&str], stdin: &[u8]) {
        let spec = CommandSpec::new(subcommand, self.path())
            .args(args.iter().copied())
            .stdin(StdinMode::Bytes(stdin.to_vec()));
        let outcome = self.runner.run(&spec).expect("run git");
        assert!(
            outcome.success(),
            "{subcommand} {args:?}: {}",
            outcome.stderr.text_lossy()
        );
    }

    pub fn run_failure(&self, subcommand: GitSubcommand, args: &[&str]) -> String {
        let spec = CommandSpec::new(subcommand, self.path()).args(args.iter().copied());
        let outcome = self.runner.run(&spec).expect("run git");
        assert!(!outcome.success(), "{subcommand} {args:?} should fail");
        outcome.stderr.text_lossy()
    }

    pub fn write(&self, path: &str, content: &str) {
        self.write_bytes(path, content.as_bytes());
    }

    pub fn write_bytes(&self, path: &str, content: &[u8]) {
        let target = self.path().join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(target, content).expect("write");
    }

    pub fn add_all(&self) {
        self.run(GitSubcommand::Add, &["-A"], &[]);
    }

    pub fn commit(&self, path: &str, content: &str, message: &str) -> String {
        self.write(path, content);
        self.add_all();
        self.commit_staged(message)
    }

    pub fn commit_staged(&self, message: &str) -> String {
        self.run(
            GitSubcommand::Commit,
            &["-F", "-"],
            format!("{message}\n").as_bytes(),
        );
        self.rev_parse(&["--verify", "HEAD"])
    }

    pub fn rev_parse(&self, args: &[&str]) -> String {
        let spec =
            CommandSpec::new(GitSubcommand::RevParse, self.path()).args(args.iter().copied());
        let outcome = self.runner.run(&spec).expect("rev-parse");
        assert!(outcome.success(), "rev-parse {args:?}");
        outcome.stdout.text_lossy().trim().to_owned()
    }

    pub fn branch(&self, name: &str) {
        self.run(GitSubcommand::Branch, &[name], &[]);
    }

    pub fn switch(&self, name: &str) {
        self.run(GitSubcommand::Switch, &[name], &[]);
    }

    pub fn switch_new(&self, name: &str) {
        self.run(GitSubcommand::Switch, &["-c", name], &[]);
    }

    pub fn discover(&self) -> beebranch_git::discover::RepoDiscovery {
        discover(&self.runner, self.path()).expect("discover")
    }

    pub fn detect(&self) -> RepoState {
        detect(&self.runner, &self.discover(), Some(1000))
            .expect("detect")
            .state
    }

    pub fn lock_path(&self) -> PathBuf {
        self.path().join(".git").join("index.lock")
    }
}

pub fn dirty_fixture() -> Fixture {
    let fixture = Fixture::new();
    fixture.commit("a.txt", "base\n", "base");
    fixture
}
