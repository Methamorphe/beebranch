//! Safe, observable and cancellable Git process execution.
//!
//! Every Git invocation goes through [`GitRunner`]. Commands are built as an
//! argv vector (never through a shell), validated against the subcommand and
//! option allowlist, executed in the repository working directory with a
//! controlled environment, and captured with a byte ceiling.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::Duration;

use crate::allowlist;
use crate::environment;
use crate::error::GitError;
use crate::exec::{self, ExecOptions};
use crate::program::GitProgram;
use crate::redaction;

pub use crate::allowlist::GitSubcommand;
pub use crate::exec::{ProcessEvent, RunningCommand};

/// Default timeout for local reads and writes.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Default stdout ceiling for buffered commands.
pub const DEFAULT_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
/// Default stderr ceiling (Git errors are capped at 16 KiB).
pub const DEFAULT_STDERR_LIMIT: usize = 16 * 1024;

/// Byte ceilings for captured output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureLimits {
    pub stdout: usize,
    pub stderr: usize,
}

impl Default for CaptureLimits {
    fn default() -> Self {
        Self {
            stdout: DEFAULT_STDOUT_LIMIT,
            stderr: DEFAULT_STDERR_LIMIT,
        }
    }
}

/// Capture strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureMode {
    /// Keep the first bytes of each stream up to the limits.
    #[default]
    Buffered,
    /// Emit redacted lines as events and keep the last bytes as a diagnostic
    /// tail. The consumer must drain events; the command is never blocked by
    /// an unconsumed channel.
    Streaming,
}

/// Capture configuration for a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CapturePolicy {
    pub mode: CaptureMode,
    pub limits: CaptureLimits,
}

/// Where the child process reads its standard input.
#[derive(Debug, Clone, Default)]
pub enum StdinMode {
    /// Closed input (default).
    #[default]
    Null,
    /// In-memory payload, written then closed. Never logged, never in argv.
    Bytes(Vec<u8>),
    /// Read-only file.
    File(PathBuf),
}

/// Correlation context attached to logs and (later) IPC events.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OperationContext {
    pub id: Option<String>,
    pub label: Option<String>,
}

impl OperationContext {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: Some(id.into()),
            label: Some(label.into()),
        }
    }
}

/// Requested Git command.
///
/// Arguments are passed verbatim to Git after validation. Use [`Self::path`]
/// for pathspecs so they are always placed after `--`.
#[derive(Debug, Clone)]
pub struct CommandSpec {
    subcommand: GitSubcommand,
    cwd: PathBuf,
    args: Vec<OsString>,
    paths_started: bool,
    env: Vec<(OsString, OsString)>,
    stdin: StdinMode,
    timeout: Option<Duration>,
    capture: CapturePolicy,
    operation: OperationContext,
}

impl CommandSpec {
    pub fn new(subcommand: GitSubcommand, cwd: impl Into<PathBuf>) -> Self {
        Self {
            subcommand,
            cwd: cwd.into(),
            args: Vec::new(),
            paths_started: false,
            env: Vec::new(),
            stdin: StdinMode::Null,
            timeout: Some(DEFAULT_TIMEOUT),
            capture: CapturePolicy::default(),
            operation: OperationContext::default(),
        }
    }

    pub fn arg(mut self, argument: impl Into<OsString>) -> Self {
        let argument = argument.into();
        if argument.to_str() == Some("--") {
            self.paths_started = true;
        }
        self.args.push(argument);
        self
    }

    pub fn args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        for argument in arguments {
            let argument = argument.into();
            if argument.to_str() == Some("--") {
                self.paths_started = true;
            }
            self.args.push(argument);
        }
        self
    }

    /// Append a pathspec argument, inserting `--` on first use.
    pub fn path(mut self, path: impl AsRef<Path>) -> Self {
        if !self.paths_started {
            self.args.push(OsString::from("--"));
            self.paths_started = true;
        }
        self.args.push(path.as_ref().as_os_str().to_owned());
        self
    }

    pub fn env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }

    pub fn stdin(mut self, stdin: StdinMode) -> Self {
        self.stdin = stdin;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Disable the timeout. Intended for network operations that report
    /// progress instead of failing after a fixed delay.
    pub fn no_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }

    pub fn streaming(mut self) -> Self {
        self.capture.mode = CaptureMode::Streaming;
        self
    }

    pub fn capture_limits(mut self, limits: CaptureLimits) -> Self {
        self.capture.limits = limits;
        self
    }

    pub fn operation(mut self, operation: OperationContext) -> Self {
        self.operation = operation;
        self
    }

    pub fn subcommand(&self) -> GitSubcommand {
        self.subcommand
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn capture(&self) -> CapturePolicy {
        self.capture
    }

    pub fn timeout_duration(&self) -> Option<Duration> {
        self.timeout
    }

    /// Validate the working directory, argv and environment.
    pub(crate) fn validate(&self) -> Result<(), GitError> {
        if !self.cwd.is_absolute() {
            return Err(GitError::invalid_argument(
                "le répertoire de travail doit être absolu",
            ));
        }
        if !self.cwd.is_dir() {
            return Err(GitError::invalid_argument(format!(
                "le répertoire de travail n'existe pas : {}",
                self.cwd.display()
            )));
        }
        allowlist::validate(self.subcommand, &self.args)?;
        environment::validate_extra(&self.env)?;
        Ok(())
    }
}

/// Captured bytes and truncation state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Captured {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn text_lossy(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }

    /// Redacted, display-ready text.
    pub fn redacted(&self) -> String {
        redaction::redact_bytes(&self.bytes)
    }

    /// Redacted diagnostic text, explicitly marking truncation.
    pub(crate) fn diagnostic(&self) -> String {
        let mut text = self.redacted();
        if self.truncated {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str("[sortie tronquée]");
        }
        text
    }

    pub(crate) fn from_parts(bytes: Vec<u8>, truncated: bool) -> Self {
        Self { bytes, truncated }
    }
}

/// Result of a completed Git process.
#[derive(Debug)]
pub struct CommandOutcome {
    pub status: ExitStatus,
    pub stdout: Captured,
    pub stderr: Captured,
    pub duration: Duration,
}

impl CommandOutcome {
    pub fn success(&self) -> bool {
        self.status.success()
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.status.code()
    }

    /// Turn a non-zero exit into a stable `git.exit_failure` error.
    ///
    /// `stderr` is redacted and bounded; the raw output remains available in
    /// `self.stderr` for callers that need to parse it.
    pub fn ensure_success(self) -> Result<Self, GitError> {
        if self.status.success() {
            Ok(self)
        } else {
            Err(GitError::exit_failure(
                self.exit_code(),
                self.stderr.diagnostic(),
            ))
        }
    }
}

/// Single owner of the `git` process.
#[derive(Debug, Clone)]
pub struct GitRunner {
    program: GitProgram,
    https_credentials: Option<std::sync::Arc<crate::https_auth::CredentialHelper>>,
}

impl GitRunner {
    /// Build a runner from an explicit program.
    pub fn new(program: GitProgram) -> Result<Self, GitError> {
        let path = program.resolve_path()?;
        Ok(Self {
            program: GitProgram::from_path(path),
            https_credentials: None,
        })
    }

    /// Resolve `git` from `PATH`.
    pub fn detect() -> Result<Self, GitError> {
        Self::new(GitProgram::resolve()?)
    }

    pub fn program(&self) -> &GitProgram {
        &self.program
    }

    /// Add in-memory forge credentials as a fallback to native Git helpers.
    /// Secrets stay in private temporary files until every child has finished.
    pub fn with_https_credentials(
        &self,
        credentials: &[(String, crate::clone::HttpsAuth)],
    ) -> Result<Self, beebranch_core::AppError> {
        let mut runner = self.clone();
        runner.https_credentials = if credentials.is_empty() {
            None
        } else {
            Some(std::sync::Arc::new(
                crate::https_auth::CredentialHelper::new(credentials)?,
            ))
        };
        Ok(runner)
    }

    /// Run a command to completion.
    pub fn run(&self, spec: &CommandSpec) -> Result<CommandOutcome, GitError> {
        self.spawn(spec, |_| {})?.wait()
    }

    /// Start a command and stream redacted output lines to `on_event`.
    ///
    /// The callback runs on the reader threads. It must not block for long.
    /// Call [`RunningCommand::cancel`] from any thread to stop the process.
    pub fn spawn<F>(&self, spec: &CommandSpec, on_event: F) -> Result<RunningCommand, GitError>
    where
        F: FnMut(ProcessEvent) + Send + 'static,
    {
        spec.validate()?;
        let command = self.build_command(spec)?;

        let span = tracing::info_span!(
            "git.command",
            subcommand = spec.subcommand.as_str(),
            operation = spec.operation.label.as_deref().unwrap_or(""),
            operation_id = spec.operation.id.as_deref().unwrap_or(""),
        );

        let mut running = exec::spawn(
            command,
            ExecOptions {
                timeout: spec.timeout,
                capture: spec.capture,
                stdin: spec.stdin.clone(),
                span,
            },
            on_event,
        )?;
        running.https_credentials = self.https_credentials.clone();
        Ok(running)
    }

    fn build_command(&self, spec: &CommandSpec) -> Result<std::process::Command, GitError> {
        let mut command = std::process::Command::new(self.program.path());
        command.current_dir(&spec.cwd);

        command.arg("-C").arg(&spec.cwd);
        command.arg("--no-pager");
        command.arg("-c").arg("color.ui=false");
        command.arg("-c").arg("core.quotepath=false");
        if spec.subcommand.is_read_only() {
            command.arg("--no-optional-locks");
        }
        if let Some(helper) = &self.https_credentials {
            command.arg("-c").arg(helper.config());
        }
        command.arg(spec.subcommand.as_str());
        command.args(&spec.args);

        command.env_clear();
        command.envs(environment::prepare(&spec.env)?);

        Ok(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_dir() -> PathBuf {
        std::env::current_dir().expect("current dir")
    }

    #[test]
    fn path_inserts_a_single_separator() {
        let spec = CommandSpec::new(GitSubcommand::Add, repo_dir())
            .path("one.txt")
            .path("two.txt");

        let arguments: Vec<&str> = spec
            .args
            .iter()
            .map(|argument| argument.to_str().expect("utf-8"))
            .collect();

        assert_eq!(arguments, ["--", "one.txt", "two.txt"]);
    }

    #[test]
    fn rejects_relative_working_directory() {
        let spec = CommandSpec::new(GitSubcommand::Status, "relative");
        let error = spec.validate().expect_err("must reject");
        assert_eq!(error.code(), crate::GitErrorCode::InvalidArgument);
    }

    #[test]
    fn rejects_unknown_environment_override() {
        let spec = CommandSpec::new(GitSubcommand::Status, repo_dir()).env("GIT_DIR", "/evil");
        let error = spec.validate().expect_err("must reject");
        assert_eq!(error.code(), crate::GitErrorCode::InvalidEnvironment);
    }

    #[test]
    fn captured_redacts_on_demand() {
        let captured = Captured::from_parts(b"https://user:pass@example.test/x".to_vec(), false);
        let redacted = captured.redacted();
        assert!(!redacted.contains("pass"));
        assert!(redacted.contains("https://***@example.test/x"));
        assert_eq!(captured.bytes(), b"https://user:pass@example.test/x");
    }
}
