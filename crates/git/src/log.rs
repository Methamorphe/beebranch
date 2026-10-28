//! Paginated commit log parsing.

use std::path::Path;

use beebranch_core::{AppError, Page, PageRequest};
use serde::{Deserialize, Serialize};

use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Field separator used in the log format (unit separator).
pub const LOG_SEPARATOR: char = '\u{1f}';

const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: CommitIdentity,
    pub committer: CommitIdentity,
    /// Decorations as reported by `%D` (`HEAD -> main`, `tag: v1`, ...).
    pub refs: Vec<String>,
    pub subject: String,
}

/// Parse the log output produced by [`LOG_FORMAT`].
pub fn parse_log(input: &str) -> Result<Vec<CommitSummary>, String> {
    let mut commits = Vec::new();
    for line in input.lines() {
        if line.is_empty() {
            continue;
        }
        commits.push(parse_summary_fields(line)?);
    }
    Ok(commits)
}

pub(crate) fn parse_summary_fields(line: &str) -> Result<CommitSummary, String> {
    let mut fields = line.splitn(10, LOG_SEPARATOR);
    let sha = fields.next().ok_or("sha manquant")?.to_owned();
    let parents = fields
        .next()
        .ok_or("parents manquants")?
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let author_name = fields.next().ok_or("auteur manquant")?.to_owned();
    let author_email = fields.next().ok_or("email auteur manquant")?.to_owned();
    let author_time = fields
        .next()
        .ok_or("date auteur manquante")?
        .parse()
        .map_err(|_| "date auteur invalide".to_owned())?;
    let committer_name = fields.next().ok_or("committer manquant")?.to_owned();
    let committer_email = fields.next().ok_or("email committer manquant")?.to_owned();
    let committer_time = fields
        .next()
        .ok_or("date committer manquante")?
        .parse()
        .map_err(|_| "date committer invalide".to_owned())?;
    let decorations = fields.next().ok_or("décorations manquantes")?;
    let subject = fields.next().ok_or("sujet manquant")?.to_owned();

    let refs = decorations
        .split(", ")
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();

    Ok(CommitSummary {
        sha,
        parents,
        author: CommitIdentity {
            name: author_name,
            email: author_email,
            timestamp: author_time,
        },
        committer: CommitIdentity {
            name: committer_name,
            email: committer_email,
            timestamp: committer_time,
        },
        refs,
        subject,
    })
}

/// Read one page of commits.
///
/// The cursor is `"<number of commits already emitted>:<last sha>"`. Direct
/// reads use `--skip`, but the application session feeds the graph from
/// [`LogStream`] so sequential pages are O(1) instead of walking the prefix.
pub fn read_log(
    runner: &GitRunner,
    worktree: &Path,
    request: &PageRequest,
    revision: Option<&str>,
    generation: u64,
) -> Result<Page<CommitSummary>, AppError> {
    read_log_scoped(runner, worktree, request, revision, false, generation)
}

/// Read one page of commits, optionally including every ref (stashes, tags,
/// remote branches).
pub fn read_log_scoped(
    runner: &GitRunner,
    worktree: &Path,
    request: &PageRequest,
    revision: Option<&str>,
    all_refs: bool,
    generation: u64,
) -> Result<Page<CommitSummary>, AppError> {
    let limit = request.limit();
    if let Some(revision) = revision {
        validate_revision(revision)?;
    }
    let cursor = request.after.as_deref().map(parse_cursor).transpose()?;
    let mut spec = CommandSpec::new(GitSubcommand::Log, worktree).args([
        "--date-order",
        "--parents",
        &format!("--format={LOG_FORMAT}"),
        &format!("--max-count={}", u64::from(limit).saturating_add(1)),
    ]);
    if let Some(cursor) = &cursor {
        spec = spec.arg(format!("--skip={}", cursor.index));
    }
    if all_refs {
        spec = spec.arg("--all");
    } else {
        spec = spec.arg(revision.unwrap_or("HEAD"));
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    let mut commits = parse_log(&outcome.stdout.text_lossy())
        .map_err(|message| AppError::internal(format!("log: {message}")))?;
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    let next = next_cursor(&commits, cursor.as_ref());
    Ok(Page::new(
        commits,
        has_more.then_some(next).flatten(),
        generation,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LogCursor {
    /// Number of commits already emitted for this revision/filter.
    index: u64,
    sha: String,
}

fn parse_cursor(value: &str) -> Result<LogCursor, AppError> {
    let (index, sha) = value
        .split_once(':')
        .ok_or_else(|| AppError::invalid_input(format!("curseur de log invalide: {value:?}")))?;
    let index = index
        .parse::<u64>()
        .ok()
        .filter(|value| *value >= 1)
        .ok_or_else(|| AppError::invalid_input(format!("curseur de log invalide: {value:?}")))?;
    let valid =
        (4..=64).contains(&sha.len()) && sha.chars().all(|character| character.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::invalid_input(format!(
            "curseur de log invalide: {value:?}"
        )));
    }
    Ok(LogCursor {
        index,
        sha: sha.to_owned(),
    })
}

fn next_cursor(commits: &[CommitSummary], previous: Option<&LogCursor>) -> Option<String> {
    let last = commits.last()?;
    let index = previous.map_or(0, |cursor| cursor.index) + commits.len() as u64;
    Some(format!("{index}:{}", last.sha))
}

/// Long-lived, incremental `git log` process used by the graph.
///
/// Pages are read sequentially from the child's stdout: the cost per page is
/// bounded by `--max-count` and no longer depends on the page depth. The
/// process is restarted when the revision, filters or generation change, and
/// cancelled when the session closes.
enum StreamEvent {
    Line(String),
    Done(Result<(), String>),
}

pub struct LogStream {
    revision: Option<String>,
    all_refs: bool,
    generation: u64,
    receiver: Option<std::sync::mpsc::Receiver<StreamEvent>>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    waiter: Option<std::thread::JoinHandle<()>>,
    pending: std::collections::VecDeque<CommitSummary>,
    last_sha: Option<String>,
    last_cursor: Option<LogCursor>,
    finished: bool,
}

impl std::fmt::Debug for LogStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogStream")
            .field("revision", &self.revision)
            .field("all_refs", &self.all_refs)
            .field("generation", &self.generation)
            .field("finished", &self.finished)
            .finish()
    }
}

impl LogStream {
    pub fn start(
        runner: &GitRunner,
        worktree: &Path,
        revision: Option<&str>,
        all_refs: bool,
        generation: u64,
    ) -> Result<Self, AppError> {
        if let Some(revision) = revision {
            validate_revision(revision)?;
        }
        let mut spec = CommandSpec::new(GitSubcommand::Log, worktree)
            .args([
                "--date-order",
                "--parents",
                &format!("--format={LOG_FORMAT}"),
            ])
            .streaming()
            .capture_limits(crate::process::CaptureLimits {
                stdout: 1024 * 1024,
                stderr: 64 * 1024,
            });
        if all_refs {
            spec = spec.arg("--all");
        } else {
            spec = spec.arg(revision.unwrap_or("HEAD"));
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel::<StreamEvent>(256);
        let lines = sender.clone();
        let command = runner
            .spawn(&spec, move |event| {
                if let crate::process::ProcessEvent::Stdout(line) = event {
                    let _ = lines.send(StreamEvent::Line(line));
                }
            })
            .map_err(AppError::from)?;
        let cancel = command.cancel_flag();
        let waiter = std::thread::Builder::new()
            .name(format!(
                "beebranch-log-stream-{}",
                revision.unwrap_or("HEAD")
            ))
            .spawn(move || {
                let result = command.wait().map(|outcome| {
                    if outcome.success() {
                        Ok(())
                    } else {
                        Err(outcome.stderr.redacted())
                    }
                });
                let event = match result {
                    Ok(Ok(())) => StreamEvent::Done(Ok(())),
                    Ok(Err(detail)) => StreamEvent::Done(Err(detail)),
                    Err(error) => StreamEvent::Done(Err(error.to_string())),
                };
                let _ = sender.send(event);
            })
            .map_err(|error| AppError::internal(format!("thread de log: {error}")))?;
        Ok(Self {
            revision: revision.map(str::to_owned),
            all_refs,
            generation,
            receiver: Some(receiver),
            cancel,
            waiter: Some(waiter),
            pending: std::collections::VecDeque::new(),
            last_sha: None,
            last_cursor: None,
            finished: false,
        })
    }

    fn matches(
        &self,
        revision: Option<&str>,
        all_refs: bool,
        generation: u64,
        after: Option<&str>,
    ) -> bool {
        if self.generation != generation
            || self.all_refs != all_refs
            || self.revision.as_deref() != revision
        {
            return false;
        }
        match after {
            None => self.last_sha.is_none(),
            Some(cursor) => parse_cursor(cursor)
                .ok()
                .map(|cursor| Some(cursor.sha) == self.last_sha)
                .unwrap_or(false),
        }
    }

    /// Read one page from the live stream. Returns `None` when the stream must
    /// be restarted (different cursor, revision or generation).
    pub fn page(
        &mut self,
        request: &PageRequest,
        revision: Option<&str>,
        all_refs: bool,
        generation: u64,
    ) -> Result<Option<Page<CommitSummary>>, AppError> {
        if !self.matches(revision, all_refs, generation, request.after.as_deref()) {
            return Ok(None);
        }
        let limit = request.limit() as usize;
        let mut commits: Vec<CommitSummary> = self.pending.drain(..).collect();
        while commits.len() < limit + 1 && !self.finished {
            match self.next_line()? {
                Some(line) => commits.push(
                    parse_summary_fields(&line)
                        .map_err(|message| AppError::internal(format!("log stream: {message}")))?,
                ),
                None => break,
            }
        }

        let has_more = commits.len() > limit;
        if has_more {
            let look_ahead = commits.remove(limit);
            self.pending.push_back(look_ahead);
        }
        let previous = self.last_cursor.clone();
        let next = next_cursor(&commits, previous.as_ref());
        if let Some(last) = commits.last() {
            self.last_sha = Some(last.sha.clone());
        }
        self.last_cursor = next.as_deref().and_then(|value| parse_cursor(value).ok());
        Ok(Some(Page::new(
            commits,
            has_more.then_some(next).flatten(),
            generation,
        )))
    }

    fn next_line(&mut self) -> Result<Option<String>, AppError> {
        let received = match self.receiver.as_ref() {
            Some(receiver) => receiver.recv(),
            None => return Ok(None),
        };
        match received {
            Ok(StreamEvent::Line(line)) if !line.is_empty() => Ok(Some(line)),
            Ok(StreamEvent::Line(_)) => self.next_line(),
            Ok(StreamEvent::Done(Ok(()))) => {
                self.finished = true;
                Ok(None)
            }
            Ok(StreamEvent::Done(Err(detail))) => {
                self.finished = true;
                Err(AppError::internal(format!("git log a échoué: {detail}")))
            }
            Err(_) => {
                self.finished = true;
                Ok(None)
            }
        }
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        self.receiver.take();
        if let Some(waiter) = self.waiter.take() {
            let _ = waiter.join();
        }
    }
}

/// Reject option-looking and control-character revisions.
pub fn validate_revision(revision: &str) -> Result<(), AppError> {
    if revision.is_empty()
        || revision.starts_with('-')
        || revision.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '\0'
        })
    {
        return Err(AppError::invalid_input(format!(
            "révision Git invalide: {revision:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> String {
        [
            "abc123",
            "def456 012abc",
            "Alice",
            "alice@example.test",
            "1700000000",
            "Bob",
            "bob@example.test",
            "1700000100",
            "HEAD -> main, origin/main, tag: v1",
            "Fix: le sujet contient des espaces",
        ]
        .join("\u{1f}")
    }

    #[test]
    fn parses_commit_fields() {
        let commits = parse_log(&line()).expect("parse");
        let commit = &commits[0];
        assert_eq!(commit.sha, "abc123");
        assert_eq!(commit.parents, vec!["def456", "012abc"]);
        assert_eq!(commit.author.name, "Alice");
        assert_eq!(commit.author.timestamp, 1_700_000_000);
        assert_eq!(commit.refs.len(), 3);
        assert_eq!(commit.subject, "Fix: le sujet contient des espaces");
    }

    #[test]
    fn parses_multiple_records() {
        let input = format!("{}\n{}\n", line(), line());
        assert_eq!(parse_log(&input).expect("parse").len(), 2);
    }

    #[test]
    fn rejects_incomplete_records() {
        assert!(parse_log("abc\u{1f}def").is_err());
    }

    #[test]
    fn rejects_option_injection_in_revision() {
        assert!(validate_revision("--all").is_err());
        assert!(validate_revision("main\n--evil").is_err());
        assert!(validate_revision("main").is_ok());
        assert!(validate_revision("v1.0~3").is_ok());
    }
}
