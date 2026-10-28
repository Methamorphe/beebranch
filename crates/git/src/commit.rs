//! Commit detail: message, changed files and line statistics.

use std::path::Path;

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};

use crate::log::{parse_summary_fields, CommitSummary, LOG_SEPARATOR};
use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::GitSubcommand;

const SHOW_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B";
const MAX_MESSAGE_CHARS: usize = 64 * 1024;
const MAX_FILES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// New path (`path` for additions and modifications).
    pub path: String,
    pub old_path: Option<String>,
    /// Raw status token (`M`, `A`, `D`, `R089`, ...).
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub summary: CommitSummary,
    pub message: String,
    pub files: Vec<CommitFile>,
    pub files_truncated: bool,
    pub message_truncated: bool,
}

/// Read a commit detail. Merge commits diff against their first parent.
pub fn read_commit(
    runner: &GitRunner,
    worktree: &Path,
    sha: &str,
) -> Result<CommitDetail, AppError> {
    crate::log::validate_revision(sha)?;

    let show = CommandSpec::new(GitSubcommand::Show, worktree)
        .args(["-s", &format!("--format={SHOW_FORMAT}"), sha])
        .capture_limits(CaptureLimits {
            stdout: 1024 * 1024,
            stderr: 16 * 1024,
        });
    let outcome = runner.run(&show)?;
    let outcome = outcome.ensure_success()?;
    let (summary, mut message, mut message_truncated) = parse_show(&outcome.stdout.text_lossy())?;

    let parent = summary.parents.first().cloned();
    let names = read_name_status(runner, worktree, parent.as_deref(), sha)?;
    let stats = read_numstat(runner, worktree, parent.as_deref(), sha)?;

    let mut files_truncated = false;
    let mut files = Vec::with_capacity(names.len().min(MAX_FILES));
    for entry in names {
        if files.len() >= MAX_FILES {
            files_truncated = true;
            break;
        }
        let key = entry.new_path.clone();
        let stat = stats.iter().find(|stat| stat.path == key);
        files.push(CommitFile {
            path: entry.new_path,
            old_path: entry.old_path,
            status: entry.status,
            additions: stat.and_then(|stat| stat.additions),
            deletions: stat.and_then(|stat| stat.deletions),
            binary: stat.is_some_and(|stat| stat.binary),
        });
    }

    if message.chars().count() > MAX_MESSAGE_CHARS {
        message = message.chars().take(MAX_MESSAGE_CHARS).collect();
        message_truncated = true;
    }

    Ok(CommitDetail {
        summary,
        message,
        files,
        files_truncated,
        message_truncated,
    })
}

fn parse_show(output: &str) -> Result<(CommitSummary, String, bool), AppError> {
    let mut fields = output.splitn(10, LOG_SEPARATOR);
    let sha = fields.next().ok_or_else(invalid_show)?.to_owned();
    let parents = fields.next().ok_or_else(invalid_show)?;
    let author_name = fields.next().ok_or_else(invalid_show)?.to_owned();
    let author_email = fields.next().ok_or_else(invalid_show)?.to_owned();
    let author_time = fields.next().ok_or_else(invalid_show)?;
    let committer_name = fields.next().ok_or_else(invalid_show)?.to_owned();
    let committer_email = fields.next().ok_or_else(invalid_show)?.to_owned();
    let committer_time = fields.next().ok_or_else(invalid_show)?;
    let decorations = fields.next().ok_or_else(invalid_show)?;
    let message = fields.next().ok_or_else(invalid_show)?.to_owned();

    let subject = message.lines().next().unwrap_or_default().to_owned();
    let synthetic = [
        sha,
        parents.to_owned(),
        author_name,
        author_email,
        author_time.to_owned(),
        committer_name,
        committer_email,
        committer_time.to_owned(),
        decorations.to_owned(),
        subject,
    ]
    .join(&LOG_SEPARATOR.to_string());

    let summary = parse_summary_fields(&synthetic)
        .map_err(|reason| AppError::internal(format!("show: {reason}")))?;
    Ok((summary, message, false))
}

fn invalid_show() -> AppError {
    AppError::internal("sortie `git show` incomplète")
}

struct NameEntry {
    new_path: String,
    old_path: Option<String>,
    status: String,
}

fn read_name_status(
    runner: &GitRunner,
    worktree: &Path,
    parent: Option<&str>,
    sha: &str,
) -> Result<Vec<NameEntry>, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::DiffTree, worktree).args([
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "-M",
    ]);
    match parent {
        Some(parent) => {
            crate::log::validate_revision(parent)?;
            spec = spec.args([parent, sha]);
        }
        None => spec = spec.args(["--root", sha]),
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    parse_name_status(outcome.stdout.bytes())
        .map_err(|reason| AppError::internal(format!("diff-tree name-status: {reason}")))
}

fn parse_name_status(input: &[u8]) -> Result<Vec<NameEntry>, String> {
    let fields: Vec<&[u8]> = input.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let raw = fields[index];
        index += 1;
        if raw.is_empty() {
            continue;
        }
        let status = String::from_utf8_lossy(raw).into_owned();
        let first = status.chars().next().unwrap_or('?');
        let path = |index: usize| -> Result<String, String> {
            fields
                .get(index)
                .map(|field| String::from_utf8_lossy(field).into_owned())
                .ok_or_else(|| format!("chemin manquant après le statut {status}"))
        };

        if matches!(first, 'R' | 'C') {
            let old_path = path(index)?;
            let new_path = path(index + 1)?;
            index += 2;
            entries.push(NameEntry {
                new_path,
                old_path: Some(old_path),
                status,
            });
        } else {
            let new_path = path(index)?;
            index += 1;
            entries.push(NameEntry {
                new_path,
                old_path: None,
                status,
            });
        }
    }
    Ok(entries)
}

#[derive(Debug)]
struct NumStat {
    path: String,
    additions: Option<u32>,
    deletions: Option<u32>,
    binary: bool,
}

fn read_numstat(
    runner: &GitRunner,
    worktree: &Path,
    parent: Option<&str>,
    sha: &str,
) -> Result<Vec<NumStat>, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::DiffTree, worktree).args([
        "--no-commit-id",
        "--numstat",
        "-z",
        "-r",
        "-M",
    ]);
    match parent {
        Some(parent) => spec = spec.args([parent, sha]),
        None => spec = spec.args(["--root", sha]),
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    parse_numstat(outcome.stdout.bytes())
        .map_err(|reason| AppError::internal(format!("diff-tree numstat: {reason}")))
}

fn parse_numstat(input: &[u8]) -> Result<Vec<NumStat>, String> {
    let fields: Vec<&[u8]> = input.split(|byte| *byte == 0).collect();
    let mut stats = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let raw = fields[index];
        index += 1;
        if raw.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(raw);
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().ok_or("ajouts manquants")?;
        let deletions = parts.next().ok_or("suppressions manquantes")?;
        let path = parts.next().unwrap_or_default();
        let binary = additions == "-" || deletions == "-";

        let path = if path.is_empty() {
            // Rename/copy: the next two NUL fields are old and new paths.
            let _old = fields.get(index).ok_or("ancien chemin manquant")?;
            let new = fields.get(index + 1).ok_or("nouveau chemin manquant")?;
            index += 2;
            String::from_utf8_lossy(new).into_owned()
        } else {
            path.to_owned()
        };

        stats.push(NumStat {
            path,
            additions: additions.parse().ok(),
            deletions: deletions.parse().ok(),
            binary,
        });
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_with_renames() {
        let input = b"M\0a.txt\0R089\0old.txt\0new.txt\0A\0added.txt\0";
        let entries = parse_name_status(input).expect("parse");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].new_path, "a.txt");
        assert_eq!(entries[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(entries[1].new_path, "new.txt");
        assert_eq!(entries[2].status, "A");
    }

    #[test]
    fn parses_numstat_with_renames_and_binary() {
        let input = b"1\t2\ta.txt\0-\t-\tlogo.png\0";
        let stats = parse_numstat(input).expect("parse");
        assert_eq!(stats[0].additions, Some(1));
        assert_eq!(stats[0].deletions, Some(2));
        assert!(stats[1].binary);
    }

    #[test]
    fn parses_rename_numstat() {
        let input = b"1\t0\t\0old.txt\0new.txt\0";
        let stats = parse_numstat(input).expect("parse");
        assert_eq!(stats[0].path, "new.txt");
        assert_eq!(stats[0].additions, Some(1));
    }

    #[test]
    fn parses_show_with_multiline_message() {
        let output = [
            "abc",
            "def",
            "Alice",
            "a@b.c",
            "1700000000",
            "Alice",
            "a@b.c",
            "1700000001",
            "HEAD -> main",
            "Subject line\n\nBody line 1\nBody line 2\n",
        ]
        .join(&LOG_SEPARATOR.to_string());
        let (summary, message, truncated) = parse_show(&output).expect("parse");
        assert_eq!(summary.sha, "abc");
        assert_eq!(summary.subject, "Subject line");
        assert!(message.contains("Body line 2"));
        assert!(!truncated);
    }
}

/// Identity and signing configuration resolved for a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitConfigView {
    pub name: String,
    pub email: String,
    pub signing: bool,
    pub signing_key: Option<String>,
    pub signing_format: Option<String>,
}

/// Commit request. The message is passed on stdin and never in argv.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitOptions {
    pub message: String,
    pub amend: bool,
    /// Amend without changing the message (`--no-edit`).
    pub keep_message: bool,
    pub allow_empty: bool,
}

/// Result of a successful commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub sha: String,
    /// Combined redacted stdout/stderr, including hook output.
    pub output: String,
    pub signed: bool,
    pub config: CommitConfigView,
}

/// Resolve identity and signing configuration.
///
/// Missing identity is reported before running `git commit`, with an explicit
/// remediation instead of Git's generic failure.
pub fn read_commit_config(
    runner: &GitRunner,
    worktree: &Path,
) -> Result<CommitConfigView, AppError> {
    let name = config_value(runner, worktree, "user.name")?.unwrap_or_default();
    let email = config_value(runner, worktree, "user.email")?.unwrap_or_default();
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err(AppError::new(
            "git.identity_missing",
            beebranch_core::ErrorCategory::Input,
            "L'identité Git est incomplète.",
        )
        .with_detail(format!("user.name={name:?}, user.email={email:?}"))
        .with_remediation("Configurez user.name et user.email avant de commit."));
    }
    let signing = config_value(runner, worktree, "commit.gpgsign")?.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "on" | "1"
        )
    });
    Ok(CommitConfigView {
        name,
        email,
        signing,
        signing_key: config_value(runner, worktree, "user.signingkey")?,
        signing_format: config_value(runner, worktree, "gpg.format")?,
    })
}

/// Create or amend a commit.
///
/// Hooks and signing are always delegated to Git: `--no-verify` is never
/// passed, and `commit.gpgsign`/`user.signingkey` are honoured by Git itself.
/// A failed hook returns an error carrying the full hook output; no commit is
/// created and the caller keeps the message.
pub fn create(
    runner: &GitRunner,
    worktree: &Path,
    options: &CommitOptions,
) -> Result<CommitOutcome, AppError> {
    let config = read_commit_config(runner, worktree)?;
    let message = options.message.trim_end_matches(['\n', '\r']).to_owned();

    let discovery = crate::discover::discover(runner, worktree)?;
    let detected = crate::state::detect(runner, &discovery, Some(1))?;
    if detected.state.operation.is_some() || !detected.state.conflicts.is_empty() {
        return Err(AppError::new(
            "operation.in_progress",
            beebranch_core::ErrorCategory::GitState,
            "Un commit direct est refusé pendant une opération Git.",
        )
        .with_remediation("Résolvez les conflits puis utilisez Continue dans Branches."));
    }

    if !options.amend && !options.allow_empty && detected.status.counts.staged == 0 {
        return Err(AppError::new(
            "commit.empty",
            beebranch_core::ErrorCategory::Input,
            "Aucune modification indexée à committer.",
        )
        .with_remediation("Indexez des fichiers ou autorisez explicitement un commit vide."));
    }
    if !(options.amend && options.keep_message) && message.trim().is_empty() {
        return Err(AppError::new(
            "commit.empty_message",
            beebranch_core::ErrorCategory::Input,
            "Le message de commit est vide.",
        )
        .with_remediation(
            "Saisissez un message ou utilisez --allow-empty-message explicitement.",
        ));
    }
    if message.contains('\0') {
        return Err(AppError::invalid_input(
            "le message contient un caractère NUL".to_owned(),
        ));
    }

    let mut spec = CommandSpec::new(GitSubcommand::Commit, worktree)
        .arg("--cleanup=strip")
        .capture_limits(CaptureLimits {
            stdout: 1024 * 1024,
            stderr: 1024 * 1024,
        });
    if options.amend {
        spec = spec.arg("--amend");
    }
    if options.allow_empty {
        spec = spec.arg("--allow-empty");
    }
    if options.amend && options.keep_message {
        spec = spec.arg("--no-edit");
    } else {
        spec = spec
            .arg("-F")
            .arg("-")
            .stdin(crate::process::StdinMode::Bytes(
                format!("{message}\n").into_bytes(),
            ));
    }

    let outcome = runner.run(&spec)?;
    let output = redacted_output(&outcome);
    if !outcome.success() {
        return Err(commit_failure(output));
    }

    let head = CommandSpec::new(GitSubcommand::RevParse, worktree).args(["--verify", "HEAD"]);
    let sha = runner
        .run(&head)?
        .ensure_success()?
        .stdout
        .text_lossy()
        .trim()
        .to_owned();
    Ok(CommitOutcome {
        sha,
        output,
        signed: config.signing,
        config,
    })
}

fn commit_failure(output: String) -> AppError {
    let mut error = beebranch_core::classify_git_failure(None, &output);
    if error.code == "git.exit_unknown" {
        error = AppError::new(
            "commit.failed",
            beebranch_core::ErrorCategory::GitExit,
            "Le commit a échoué.",
        );
    }
    error.with_detail(output).with_remediation(
        "Corrigez la cause affichée (hook, identité, signature) puis recommencez.",
    )
}

fn redacted_output(outcome: &crate::process::CommandOutcome) -> String {
    let stdout = outcome.stdout.redacted();
    let stderr = outcome.stderr.redacted();
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn config_value(
    runner: &GitRunner,
    worktree: &Path,
    key: &str,
) -> Result<Option<String>, AppError> {
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::Config, worktree)
            .arg("--get")
            .arg(key),
    )?;
    if !outcome.success() {
        return Ok(None);
    }
    let value = outcome.stdout.text_lossy().trim().to_owned();
    Ok((!value.is_empty()).then_some(value))
}
