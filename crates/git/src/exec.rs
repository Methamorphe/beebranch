use std::io::{self, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::error::GitError;
use crate::process::{CaptureMode, CapturePolicy, Captured, CommandOutcome, StdinMode};
use crate::redaction;

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const KILL_GRACE: Duration = Duration::from_secs(5);
const READ_BUFFER: usize = 8 * 1024;
const MAX_EVENT_LINE: usize = 64 * 1024;

/// Event emitted by a streaming command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessEvent {
    Started {
        pid: Option<u32>,
    },
    /// Complete (or size-bounded) redacted line from stdout.
    Stdout(String),
    /// Complete (or size-bounded) redacted line from stderr.
    Stderr(String),
    Finished {
        exit_code: Option<i32>,
        duration: Duration,
    },
}

pub(crate) struct ExecOptions {
    pub(crate) timeout: Option<Duration>,
    pub(crate) capture: CapturePolicy,
    pub(crate) stdin: StdinMode,
    pub(crate) span: tracing::Span,
}

type EventCallback = Box<dyn FnMut(ProcessEvent) + Send>;
type SharedCallback = Arc<Mutex<EventCallback>>;

struct Control {
    cancel: Arc<AtomicBool>,
}

/// Handle to a running Git process.
///
/// Dropping the handle force-stops the process and reaps it; call
/// [`Self::wait`] for a graceful outcome.
pub struct RunningCommand {
    child: Option<Child>,
    pid: Option<u32>,
    control: Arc<Control>,
    readers: Vec<JoinHandle<StreamResult>>,
    stdin_writer: Option<JoinHandle<()>>,
    started_at: Instant,
    timeout: Option<Duration>,
    callback: SharedCallback,
    span: tracing::Span,
}

impl RunningCommand {
    /// Request cancellation from any thread.
    pub fn cancel(&self) {
        self.control.cancel.store(true, Ordering::SeqCst);
    }

    /// Shared flag that can be stored by an operation registry and set later.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.control.cancel.clone()
    }

    /// Wait for the process, join the capture threads and return its outcome.
    ///
    /// Cancellation returns `op.cancelled`; a timeout returns `git.timeout`.
    /// Both carry the redacted stderr tail as detail.
    pub fn wait(mut self) -> Result<CommandOutcome, GitError> {
        let started_at = self.started_at;
        let configured_timeout = self.timeout;
        let mut child = self
            .child
            .take()
            .ok_or_else(|| GitError::internal("processus déjà attendu"))?;

        let supervised = self.span.in_scope(|| {
            supervise(
                &mut child,
                self.pid,
                &self.control,
                self.timeout,
                started_at,
            )
        });

        if supervised.is_err() {
            force_terminate(&mut child, self.pid);
            let _ = child.wait();
        }

        let mut stdout = Captured::default();
        let mut stderr = Captured::default();
        let mut read_error: Option<String> = None;

        for handle in self.readers.drain(..) {
            match handle.join() {
                Ok(result) => {
                    match result.stream {
                        Stream::Stdout => stdout = result.captured,
                        Stream::Stderr => stderr = result.captured,
                    }
                    if let Some(error) = result.read_error {
                        read_error = Some(error);
                    }
                }
                Err(_) => {
                    read_error = Some("un thread de lecture Git a paniqué".to_owned());
                }
            }
        }

        if let Some(writer) = self.stdin_writer.take() {
            let _ = writer.join();
        }

        let supervision = supervised?;
        emit_event(
            &self.callback,
            ProcessEvent::Finished {
                exit_code: supervision.status.code(),
                duration: supervision.duration,
            },
        );

        if supervision.cancelled {
            return Err(GitError::cancelled(Some(stderr.diagnostic())));
        }
        if supervision.timed_out {
            return Err(GitError::timeout(
                configured_timeout.unwrap_or(supervision.duration),
                Some(stderr.diagnostic()),
            ));
        }
        if let Some(error) = read_error {
            return Err(GitError::io("lecture de la sortie Git", error));
        }

        Ok(CommandOutcome {
            status: supervision.status,
            stdout,
            stderr,
            duration: supervision.duration,
        })
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };

        self.control.cancel.store(true, Ordering::SeqCst);
        force_terminate(&mut child, self.pid);
        let _ = child.wait();

        for handle in self.readers.drain(..) {
            let _ = handle.join();
        }
        if let Some(writer) = self.stdin_writer.take() {
            let _ = writer.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

struct StreamResult {
    stream: Stream,
    captured: Captured,
    read_error: Option<String>,
}

struct Supervision {
    status: ExitStatus,
    cancelled: bool,
    timed_out: bool,
    duration: Duration,
}

pub(crate) fn spawn<F>(
    mut command: Command,
    options: ExecOptions,
    on_event: F,
) -> Result<RunningCommand, GitError>
where
    F: FnMut(ProcessEvent) + Send + 'static,
{
    let ExecOptions {
        timeout,
        capture,
        stdin,
        span,
    } = options;

    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let stdin_payload = match stdin {
        StdinMode::Null => {
            command.stdin(Stdio::null());
            None
        }
        StdinMode::Bytes(payload) => {
            command.stdin(Stdio::piped());
            Some(payload)
        }
        StdinMode::File(path) => {
            let file = std::fs::File::open(path)
                .map_err(|error| GitError::io("ouverture du stdin", error))?;
            command.stdin(Stdio::from(file));
            None
        }
    };

    configure_process(&mut command);
    let started_at = Instant::now();
    let mut child = {
        let _entered = span.enter();
        command.spawn().map_err(GitError::spawn_failed)?
    };
    let pid = child.id();
    let callback: SharedCallback = Arc::new(Mutex::new(Box::new(on_event)));
    emit_event(&callback, ProcessEvent::Started { pid: Some(pid) });

    let stdin_writer = match (stdin_payload, child.stdin.take()) {
        (Some(payload), Some(mut stdin)) => {
            match thread::Builder::new()
                .name("git-stdin".to_owned())
                .spawn(move || {
                    let _ = stdin.write_all(&payload);
                    let _ = stdin.flush();
                }) {
                Ok(handle) => Some(handle),
                Err(error) => {
                    force_terminate(&mut child, Some(pid));
                    let _ = child.wait();
                    return Err(GitError::internal(format!(
                        "impossible de démarrer l'écriture stdin : {error}"
                    )));
                }
            }
        }
        (Some(_), None) => {
            force_terminate(&mut child, Some(pid));
            let _ = child.wait();
            return Err(GitError::internal("stdin Pipé absent"));
        }
        (None, Some(stdin)) => {
            drop(stdin);
            None
        }
        (None, None) => None,
    };

    let Some(stdout) = child.stdout.take() else {
        force_terminate(&mut child, Some(pid));
        let _ = child.wait();
        if let Some(writer) = stdin_writer {
            let _ = writer.join();
        }
        return Err(GitError::internal("stdout non capturé"));
    };
    let Some(stderr) = child.stderr.take() else {
        force_terminate(&mut child, Some(pid));
        let _ = child.wait();
        if let Some(writer) = stdin_writer {
            let _ = writer.join();
        }
        return Err(GitError::internal("stderr non capturé"));
    };

    let stdout_handle = match spawn_reader(stdout, Stream::Stdout, capture, Arc::clone(&callback)) {
        Ok(handle) => handle,
        Err(error) => {
            force_terminate(&mut child, Some(pid));
            let _ = child.wait();
            if let Some(writer) = stdin_writer {
                let _ = writer.join();
            }
            return Err(error);
        }
    };

    let stderr_handle = match spawn_reader(stderr, Stream::Stderr, capture, Arc::clone(&callback)) {
        Ok(handle) => handle,
        Err(error) => {
            force_terminate(&mut child, Some(pid));
            let _ = child.wait();
            let _ = stdout_handle.join();
            if let Some(writer) = stdin_writer {
                let _ = writer.join();
            }
            return Err(error);
        }
    };

    Ok(RunningCommand {
        child: Some(child),
        pid: Some(pid),
        control: Arc::new(Control {
            cancel: Arc::new(AtomicBool::new(false)),
        }),
        readers: vec![stdout_handle, stderr_handle],
        stdin_writer,
        started_at,
        timeout,
        callback,
        span,
    })
}

fn spawn_reader<R>(
    reader: R,
    stream: Stream,
    capture: CapturePolicy,
    callback: SharedCallback,
) -> Result<JoinHandle<StreamResult>, GitError>
where
    R: Read + Send + 'static,
{
    thread::Builder::new()
        .name(match stream {
            Stream::Stdout => "git-stdout".to_owned(),
            Stream::Stderr => "git-stderr".to_owned(),
        })
        .spawn(move || read_stream(reader, stream, capture, callback))
        .map_err(|error| GitError::internal(format!("impossible de démarrer la lecture : {error}")))
}

fn read_stream<R>(
    mut reader: R,
    stream: Stream,
    capture: CapturePolicy,
    callback: SharedCallback,
) -> StreamResult
where
    R: Read,
{
    let mut sink = CaptureSink::new(capture, stream);
    let mut lines = LineEmitter::default();
    let mut buffer = [0_u8; READ_BUFFER];
    let mut read_error = None;

    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let chunk = &buffer[..count];
                sink.push(chunk);

                if capture.mode == CaptureMode::Streaming {
                    let mut emit = |line: &str| {
                        emit_event(
                            &callback,
                            match stream {
                                Stream::Stdout => ProcessEvent::Stdout(line.to_owned()),
                                Stream::Stderr => ProcessEvent::Stderr(line.to_owned()),
                            },
                        );
                    };
                    lines.push(chunk, &mut emit);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        }
    }

    if capture.mode == CaptureMode::Streaming {
        let mut emit = |line: &str| {
            emit_event(
                &callback,
                match stream {
                    Stream::Stdout => ProcessEvent::Stdout(line.to_owned()),
                    Stream::Stderr => ProcessEvent::Stderr(line.to_owned()),
                },
            );
        };
        lines.finish(&mut emit);
    }

    StreamResult {
        stream,
        captured: sink.finish(),
        read_error,
    }
}

struct CaptureSink {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
    tail: bool,
}

impl CaptureSink {
    fn new(policy: CapturePolicy, stream: Stream) -> Self {
        let limit = match stream {
            Stream::Stdout => policy.limits.stdout,
            Stream::Stderr => policy.limits.stderr,
        };
        Self {
            bytes: Vec::new(),
            limit,
            truncated: false,
            tail: policy.mode == CaptureMode::Streaming,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if self.limit == 0 {
            self.truncated = true;
            return;
        }

        if self.tail {
            self.bytes.extend_from_slice(chunk);
            if self.bytes.len() > self.limit {
                let excess = self.bytes.len() - self.limit;
                self.bytes.drain(..excess);
                self.truncated = true;
            }
        } else {
            let remaining = self.limit.saturating_sub(self.bytes.len());
            let taken = remaining.min(chunk.len());
            self.bytes.extend_from_slice(&chunk[..taken]);
            if taken < chunk.len() {
                self.truncated = true;
            }
        }
    }

    fn finish(self) -> Captured {
        Captured::from_parts(self.bytes, self.truncated)
    }
}

#[derive(Default)]
struct LineEmitter {
    pending: Vec<u8>,
    skip_lf: bool,
}

impl LineEmitter {
    fn push(&mut self, chunk: &[u8], emit: &mut impl FnMut(&str)) {
        for &byte in chunk {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }

            self.pending.push(byte);
            if byte == b'\r' {
                self.flush(emit);
                self.skip_lf = true;
            } else if byte == b'\n' || self.pending.len() >= MAX_EVENT_LINE {
                self.flush(emit);
            }
        }
    }

    fn finish(&mut self, emit: &mut impl FnMut(&str)) {
        self.flush(emit);
    }

    fn flush(&mut self, emit: &mut impl FnMut(&str)) {
        if self.pending.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.pending);
        let redacted = redaction::redact(&text);
        emit(redacted.as_ref());
        self.pending.clear();
    }
}

fn supervise(
    child: &mut Child,
    pid: Option<u32>,
    control: &Control,
    timeout: Option<Duration>,
    started_at: Instant,
) -> Result<Supervision, GitError> {
    let deadline = timeout.and_then(|duration| started_at.checked_add(duration));
    let mut signalled_at: Option<Instant> = None;
    let mut force_sent = false;
    let mut cancelled = false;
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Supervision {
                    status,
                    cancelled,
                    timed_out,
                    duration: started_at.elapsed(),
                });
            }
            Ok(None) => {}
            Err(error) => return Err(GitError::io("attente du processus Git", error)),
        }

        let now = Instant::now();
        if signalled_at.is_none() {
            if control.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                terminate(child, pid, false);
                signalled_at = Some(now);
            } else if deadline.is_some_and(|deadline| now >= deadline) {
                timed_out = true;
                terminate(child, pid, false);
                signalled_at = Some(now);
            }
        } else if !force_sent
            && signalled_at.is_some_and(|sent| now.duration_since(sent) >= KILL_GRACE)
        {
            terminate(child, pid, true);
            force_sent = true;
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn emit_event(callback: &SharedCallback, event: ProcessEvent) {
    match callback.lock() {
        Ok(mut guard) => guard(event),
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard(event);
        }
    }
}

fn configure_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(unix)]
fn terminate(child: &mut Child, pid: Option<u32>, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    if pid == 0 {
        return;
    }

    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };

    // SAFETY: `pid` comes from `Child::id()` and the child was started in its
    // own process group (`process_group(0)`), so negating it targets only the
    // children created by this Git command.
    let result = unsafe { libc::kill(-(pid as i32), signal) };
    if result != 0 {
        let _ = child.kill();
    }
}

#[cfg(windows)]
fn terminate(child: &mut Child, _pid: Option<u32>, _force: bool) {
    // Windows has no portable process-group signal; terminating the child is
    // the documented behavior until a Job Object is introduced.
    let _ = child.kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate(child: &mut Child, _pid: Option<u32>, _force: bool) {
    let _ = child.kill();
}

fn force_terminate(child: &mut Child, pid: Option<u32>) {
    terminate(child, pid, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(timeout: Option<Duration>) -> ExecOptions {
        ExecOptions {
            timeout,
            capture: CapturePolicy::default(),
            stdin: StdinMode::Null,
            span: tracing::info_span!("test"),
        }
    }

    #[cfg(unix)]
    fn sleeping_command() -> Command {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        command
    }

    #[cfg(windows)]
    fn sleeping_command() -> Command {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut command = Command::new(
            std::path::PathBuf::from(root)
                .join("System32")
                .join("PING.EXE"),
        );
        command.args(["-n", "30", "127.0.0.1"]);
        command
    }

    #[test]
    fn cancels_a_long_running_process() {
        let running = spawn(sleeping_command(), options(None), |_| {}).expect("spawn");
        thread::sleep(Duration::from_millis(150));

        let started = Instant::now();
        running.cancel();
        let error = running.wait().expect_err("cancelled");

        assert_eq!(error.code(), crate::GitErrorCode::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn times_out_a_long_running_process() {
        let running = spawn(
            sleeping_command(),
            options(Some(Duration::from_millis(150))),
            |_| {},
        )
        .expect("spawn");

        let started = Instant::now();
        let error = running.wait().expect_err("timeout");
        assert_eq!(error.code(), crate::GitErrorCode::Timeout);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn dropping_the_handle_stops_the_process() {
        let running = spawn(sleeping_command(), options(None), |_| {}).expect("spawn");
        thread::sleep(Duration::from_millis(100));
        drop(running);
    }

    #[test]
    fn captures_head_and_marks_truncation() {
        let policy = CapturePolicy {
            mode: CaptureMode::Buffered,
            limits: crate::process::CaptureLimits {
                stdout: 4,
                stderr: 4,
            },
        };
        let mut sink = CaptureSink::new(policy, Stream::Stdout);
        sink.push(b"abcdef");
        let captured = sink.finish();

        assert_eq!(captured.bytes(), b"abcd");
        assert!(captured.truncated());
    }

    #[test]
    fn streaming_keeps_the_tail() {
        let policy = CapturePolicy {
            mode: CaptureMode::Streaming,
            limits: crate::process::CaptureLimits {
                stdout: 4,
                stderr: 4,
            },
        };
        let mut sink = CaptureSink::new(policy, Stream::Stdout);
        sink.push(b"abcdef");
        let captured = sink.finish();

        assert_eq!(captured.bytes(), b"cdef");
        assert!(captured.truncated());
    }

    #[test]
    fn line_emitter_redacts_and_splits() {
        let mut emitter = LineEmitter::default();
        let mut output = Vec::new();
        emitter.push(b"Authorization: Bearer secret\nhello\rnext", &mut |line| {
            output.push(line.to_owned())
        });
        emitter.finish(&mut |line| output.push(line.to_owned()));

        assert_eq!(
            output,
            vec![
                "Authorization: ***\n".to_owned(),
                "hello\r".to_owned(),
                "next".to_owned()
            ]
        );
    }

    #[test]
    fn line_emitter_collapses_crlf() {
        let mut emitter = LineEmitter::default();
        let mut output = Vec::new();
        emitter.push(b"line1\r\nline2\r\n", &mut |line| {
            output.push(line.to_owned())
        });
        emitter.finish(&mut |line| output.push(line.to_owned()));

        assert_eq!(output, vec!["line1\r".to_owned(), "line2\r".to_owned()]);
    }

    #[test]
    fn line_emitter_bounds_partial_lines() {
        let mut emitter = LineEmitter::default();
        let mut output = Vec::new();
        let chunk = vec![b'a'; MAX_EVENT_LINE + 1];
        emitter.push(&chunk, &mut |line| output.push(line.to_owned()));
        emitter.finish(&mut |line| output.push(line.to_owned()));

        assert_eq!(output.len(), 2);
        assert_eq!(output[0].len(), MAX_EVENT_LINE);
        assert_eq!(output[1].len(), 1);
    }
}
