//! Blame and file history.
//!
//! Both reads are bounded: blame returns at most [`MAX_BLAME_LINES`] source
//! lines and file history at most [`MAX_HISTORY_ENTRIES`] commits. Paths are
//! relative to the worktree and never escape it.

use std::path::{Component, Path};

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::GitSubcommand;

pub const MAX_BLAME_LINES: u32 = 2_000;
pub const MAX_HISTORY_ENTRIES: u32 = 500;
const BLAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub author: String,
    pub author_mail: String,
    pub author_time: i64,
    pub summary: String,
    pub content: String,
    pub previous: Option<String>,
    /// True for the first line of a contiguous block by the same commit.
    pub group_start: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameReport {
    pub path: String,
    pub lines: Vec<BlameLine>,
    pub truncated: bool,
    pub first_line: u32,
    pub last_line: u32,
    pub total_lines: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub sha: String,
    pub author: String,
    pub author_mail: String,
    pub author_time: i64,
    pub subject: String,
    /// Status of the path in this commit (`A`, `M`, `D`, `R100`…).
    pub status: String,
    /// Original path when Git reports a rename.
    pub previous_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub path: String,
    pub follow: bool,
    pub entries: Vec<FileHistoryEntry>,
    pub truncated: bool,
}

pub fn validate_path(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_input("le chemin est vide".to_owned()));
    }
    let value = Path::new(path);
    if value.is_absolute() {
        return Err(AppError::invalid_input(
            "le chemin doit être relatif au dépôt".to_owned(),
        ));
    }
    for component in value.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "le chemin ne peut pas remonter avec `..`".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "l'accès direct à `.git` est interdit".to_owned(),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Blame a bounded line range. `start` and `end` are 1-based and inclusive.
pub fn blame(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    start: Option<u32>,
    end: Option<u32>,
    max_lines: Option<u32>,
) -> Result<BlameReport, AppError> {
    validate_path(path)?;
    let max = max_lines
        .unwrap_or(MAX_BLAME_LINES)
        .clamp(1, MAX_BLAME_LINES);
    let first = start.unwrap_or(1).max(1);
    let last = end.unwrap_or_else(|| first.saturating_add(max - 1));
    if last < first {
        return Err(AppError::invalid_input(
            "la plage de lignes est inversée".to_owned(),
        ));
    }
    let requested = last - first + 1;
    let bounded_last = if requested > max {
        first + max - 1
    } else {
        last
    };

    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Blame, worktree)
            .arg("--line-porcelain")
            .arg("-L")
            .arg(format!("{first},{bounded_last}"))
            .arg("--")
            .arg(path)
            .capture_limits(CaptureLimits {
                stdout: BLAME_BYTES,
                stderr: 32 * 1024,
            }),
    )?;
    if !outcome.success() {
        if outcome.stdout.truncated() || outcome.stderr.truncated() {
            return Err(AppError::new(
                "blame.too_large",
                ErrorCategory::Input,
                "Le fichier est trop volumineux pour le blame.",
            )
            .with_detail(outcome.stderr.redacted()));
        }
        let stderr = outcome.stderr.text_lossy();
        if stderr.contains("binary file") || stderr.contains("Binary file") {
            return Err(AppError::new(
                "blame.binary",
                ErrorCategory::Input,
                "Le blame n'est pas disponible pour un fichier binaire.",
            )
            .with_detail(stderr));
        }
        if stderr.contains("no such path") || stderr.contains("does not exist") {
            return Err(AppError::not_found(format!(
                "Le fichier `{path}` n'existe pas à cette révision."
            ))
            .with_detail(stderr));
        }
        return Err(AppError::new(
            "blame.failed",
            ErrorCategory::GitState,
            "Le blame a échoué.",
        )
        .with_detail(stderr));
    }

    let lines = parse_blame(&outcome.stdout.text_lossy());
    let truncated = requested > max || outcome.stdout.truncated();
    Ok(BlameReport {
        path: path.to_owned(),
        last_line: lines.last().map(|line| line.line).unwrap_or(bounded_last),
        total_lines: None,
        truncated,
        first_line: first,
        lines,
    })
}

fn parse_blame(text: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let mut sha = String::new();
    let mut author = String::new();
    let mut mail = String::new();
    let mut time = 0i64;
    let mut summary = String::new();
    let mut previous = None;
    let mut final_line = 0u32;
    let mut last_group = String::new();

    for raw in text.lines() {
        if let Some(content) = raw.strip_prefix('\t') {
            let group_start = sha != last_group;
            last_group = sha.clone();
            lines.push(BlameLine {
                line: final_line,
                sha: sha.clone(),
                author: author.clone(),
                author_mail: mail.clone(),
                author_time: time,
                summary: summary.clone(),
                content: content.to_owned(),
                previous: previous.clone(),
                group_start,
            });
            continue;
        }
        if raw.is_empty() {
            continue;
        }
        if let Some(value) = raw.strip_prefix("author ") {
            author = value.to_owned();
        } else if let Some(value) = raw.strip_prefix("author-mail ") {
            mail = value.trim_matches(['<', '>']).to_owned();
        } else if let Some(value) = raw.strip_prefix("author-time ") {
            time = value.parse().unwrap_or(0);
        } else if let Some(value) = raw.strip_prefix("summary ") {
            summary = value.to_owned();
        } else if let Some(value) = raw.strip_prefix("previous ") {
            previous = Some(value.to_owned());
        } else if let Some(value) = raw.strip_prefix("filename ") {
            let _ = value;
        } else {
            let mut fields = raw.split(' ');
            if let Some(candidate) = fields.next() {
                if candidate.len() >= 7 && candidate.chars().all(|c| c.is_ascii_hexdigit()) {
                    if let Some(line) = fields.nth(1) {
                        if let Ok(value) = line.parse::<u32>() {
                            sha = candidate.to_owned();
                            final_line = value;
                            author.clear();
                            mail.clear();
                            time = 0;
                            summary.clear();
                            previous = None;
                        }
                    }
                }
            }
        }
    }
    lines
}

/// File history with rename following. `git log --follow` accepts one path.
pub fn history(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    follow: bool,
    max_entries: Option<u32>,
    revision: Option<&str>,
) -> Result<FileHistory, AppError> {
    validate_path(path)?;
    if let Some(revision) = revision {
        crate::log::validate_revision(revision)?;
    }
    let max = max_entries
        .unwrap_or(MAX_HISTORY_ENTRIES)
        .clamp(1, MAX_HISTORY_ENTRIES);
    let mut spec = CommandSpec::new(GitSubcommand::Log, worktree)
        .arg("--name-status")
        .arg(format!("--max-count={max}"))
        .arg("--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s");
    if follow {
        spec = spec.arg("--follow");
    }
    spec = spec.arg(revision.unwrap_or("HEAD")).arg("--").arg(path);
    let outcome = runner.run(&spec)?;
    if !outcome.success() {
        return Err(AppError::new(
            "history.failed",
            ErrorCategory::GitState,
            "L'historique du fichier n'a pas pu être lu.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    let entries = parse_history(&outcome.stdout.text_lossy(), path);
    Ok(FileHistory {
        path: path.to_owned(),
        follow,
        truncated: entries.len() as u32 >= max,
        entries,
    })
}

fn parse_history(text: &str, path: &str) -> Vec<FileHistoryEntry> {
    let mut entries = Vec::new();
    let mut current: Option<(String, String, String, i64, String)> = None;
    let mut statuses: Vec<String> = Vec::new();
    let flush = |current: &mut Option<(String, String, String, i64, String)>,
                 statuses: &mut Vec<String>,
                 entries: &mut Vec<FileHistoryEntry>| {
        let Some((sha, author, mail, time, subject)) = current.take() else {
            statuses.clear();
            return;
        };
        let entry = statuses
            .first()
            .and_then(|line| file_entry_from_statuses(line, path));
        let (status, previous) = entry.unwrap_or_else(|| ("M".to_owned(), None));
        entries.push(FileHistoryEntry {
            sha,
            author,
            author_mail: mail,
            author_time: time,
            subject,
            status,
            previous_path: previous,
        });
        statuses.clear();
    };

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let is_format_line = line
            .split('\u{1f}')
            .next()
            .is_some_and(|sha| sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()));
        if is_format_line {
            flush(&mut current, &mut statuses, &mut entries);
            let mut fields = line.splitn(5, '\u{1f}');
            let sha = fields.next().unwrap_or_default().to_owned();
            let author = fields.next().unwrap_or_default().to_owned();
            let mail = fields.next().unwrap_or_default().to_owned();
            let time = fields
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            let subject = fields.next().unwrap_or_default().to_owned();
            current = Some((sha, author, mail, time, subject));
        } else if current.is_some() {
            statuses.push(line.to_owned());
        }
    }
    flush(&mut current, &mut statuses, &mut entries);
    entries
}

fn file_entry_from_statuses(statuses: &str, path: &str) -> Option<(String, Option<String>)> {
    for line in statuses.lines() {
        let mut parts = line.split('\t');
        let status = parts.next()?.trim();
        if status.is_empty() {
            continue;
        }
        let first = parts.next().unwrap_or_default();
        let second = parts.next();
        let target = second.unwrap_or(first);
        if target == path {
            let previous = if status.starts_with('R') || status.starts_with('C') {
                Some(first.to_owned())
            } else {
                None
            };
            return Some((status.to_owned(), previous));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_line_porcelain() {
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2\nauthor Alice\nauthor-mail <alice@example.test>\nauthor-time 1700000000\nsummary First\nfilename a.txt\n\tline one\n\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2\nauthor Bob\nauthor-mail <bob@example.test>\nauthor-time 1700000100\nsummary Second\nfilename a.txt\n\tline two\n";
        let lines = parse_blame(text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line, 1);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].content, "line one");
        assert!(lines[0].group_start);
        assert!(!lines[1].group_start);
        assert_eq!(lines[1].author_mail, "bob@example.test");
    }

    #[test]
    fn parses_history_rename() {
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{1f}Alice\u{1f}a@x\u{1f}1700000000\u{1f}rename\nR100\told.txt\tnew.txt\n\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u{1f}Bob\u{1f}b@x\u{1f}1700000100\u{1f}edit\nM\tnew.txt\n";
        let entries = parse_history(text, "new.txt");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].status, "R100");
        assert_eq!(entries[0].previous_path.as_deref(), Some("old.txt"));
        assert_eq!(entries[1].status, "M");
    }
}
