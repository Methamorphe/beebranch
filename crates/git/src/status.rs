//! Parser for `git status --porcelain=v2 -z`.

use std::path::Path;

use beebranch_core::{AppError, RepoState, WorktreeState};
use serde::{Deserialize, Serialize};

use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Default number of entries returned to the frontend.
pub const DEFAULT_STATUS_ENTRIES: usize = 20_000;
/// Byte ceiling for a full status capture (200k files).
pub const STATUS_STDOUT_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Ordinary,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStages {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub kind: EntryKind,
    pub path: String,
    pub orig_path: Option<String>,
    /// Index (staged) status character, `.` when unchanged.
    pub index: char,
    /// Worktree status character, `.` when unchanged.
    pub worktree: char,
    pub submodule: Option<String>,
    pub similarity: Option<u8>,
    pub stages: Option<ConflictStages>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub branch: BranchStatus,
    pub entries: Vec<StatusEntry>,
    pub ignored: Vec<String>,
    pub counts: WorktreeState,
    /// True when the entry list was capped; counts remain exact.
    pub truncated: bool,
}

impl StatusReport {
    pub fn worktree_state(&self) -> WorktreeState {
        self.counts
    }

    pub fn conflicts(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::Unmerged)
            .map(|entry| entry.path.clone())
            .collect()
    }
}

/// Read and parse the repository status.
pub fn read_status(
    runner: &GitRunner,
    worktree: &Path,
    max_entries: Option<usize>,
) -> Result<StatusReport, AppError> {
    read_status_opts(runner, worktree, max_entries, false)
}

/// Read the status, optionally listing ignored files.
pub fn read_status_opts(
    runner: &GitRunner,
    worktree: &Path,
    max_entries: Option<usize>,
    include_ignored: bool,
) -> Result<StatusReport, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Status, worktree).args([
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--find-renames",
    ]);
    if include_ignored {
        spec = spec.arg("--ignored=matching");
    }
    let spec = spec.capture_limits(CaptureLimits {
        stdout: STATUS_STDOUT_LIMIT,
        stderr: 16 * 1024,
    });

    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    parse_status(
        outcome.stdout.bytes(),
        max_entries.unwrap_or(DEFAULT_STATUS_ENTRIES),
    )
    .map_err(|message| AppError::internal(format!("status porcelain v2: {message}")))
}

/// Parse a `--porcelain=v2 -z` payload.
pub fn parse_status(input: &[u8], max_entries: usize) -> Result<StatusReport, String> {
    let fields: Vec<&[u8]> = input.split(|byte| *byte == 0).collect();
    let mut report = StatusReport::default();
    let mut total = 0usize;
    let mut index = 0usize;

    while index < fields.len() {
        let raw = fields[index];
        index += 1;
        if raw.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(raw);
        let line = line.as_ref();

        if let Some(value) = line.strip_prefix("# branch.oid ") {
            if value == "(initial)" {
                report.branch.unborn = true;
            } else {
                report.branch.oid = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("# branch.head ") {
            if value == "(detached)" {
                report.branch.detached = true;
            } else {
                report.branch.head = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("# branch.upstream ") {
            report.branch.upstream = Some(value.to_owned());
            continue;
        }
        if let Some(value) = line.strip_prefix("# branch.ab ") {
            for token in value.split_whitespace() {
                if let Some(ahead) = token.strip_prefix('+') {
                    report.branch.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = token.strip_prefix('-') {
                    report.branch.behind = behind.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        let (entry, consume_rename) = match line.as_bytes().first().copied() {
            Some(b'1') => (parse_ordinary(line)?, false),
            Some(b'2') => (parse_renamed(line)?, true),
            Some(b'u') => (parse_unmerged(line)?, false),
            Some(b'?') => (parse_untracked(line, EntryKind::Untracked)?, false),
            Some(b'!') => (parse_untracked(line, EntryKind::Ignored)?, false),
            _ => return Err(format!("enregistrement inconnu: {line:?}")),
        };

        let mut entry = entry;
        if consume_rename {
            let original = fields
                .get(index)
                .ok_or_else(|| "chemin d'origine manquant pour un renommage".to_owned())?;
            entry.orig_path = Some(String::from_utf8_lossy(original).into_owned());
            index += 1;
        }

        total += 1;
        match entry.kind {
            EntryKind::Untracked => report.counts.untracked += 1,
            EntryKind::Ignored => report.ignored.push(entry.path.clone()),
            EntryKind::Unmerged => report.counts.conflicted += 1,
            _ => {
                if entry.index != '.' {
                    report.counts.staged += 1;
                }
                if entry.worktree != '.' {
                    report.counts.unstaged += 1;
                }
            }
        }

        if report.entries.len() < max_entries {
            report.entries.push(entry);
        } else {
            report.truncated = true;
        }
        if report.ignored.len() >= max_entries {
            report.ignored.truncate(max_entries);
        }
    }

    let _ = total;
    Ok(report)
}

fn parse_ordinary(line: &str) -> Result<StatusEntry, String> {
    let mut parts = line.splitn(9, ' ');
    let _tag = parts.next();
    let xy = parts.next().ok_or("XY manquant")?;
    let submodule = parts.next().map(str::to_owned);
    let _mh = parts.next();
    let _mi = parts.next();
    let _mw = parts.next();
    let _hh = parts.next();
    let _hi = parts.next();
    let path = parts.next().ok_or("chemin manquant")?;
    Ok(StatusEntry {
        kind: EntryKind::Ordinary,
        path: path.to_owned(),
        orig_path: None,
        index: status_char(xy, 0)?,
        worktree: status_char(xy, 1)?,
        submodule,
        similarity: None,
        stages: None,
    })
}

fn parse_renamed(line: &str) -> Result<StatusEntry, String> {
    let mut parts = line.splitn(10, ' ');
    let _tag = parts.next();
    let xy = parts.next().ok_or("XY manquant")?;
    let submodule = parts.next().map(str::to_owned);
    let _mh = parts.next();
    let _mi = parts.next();
    let _mw = parts.next();
    let _hh = parts.next();
    let _hi = parts.next();
    let score = parts.next().ok_or("score manquant")?;
    let path = parts.next().ok_or("chemin manquant")?;
    let (kind, similarity) = parse_score(score)?;
    Ok(StatusEntry {
        kind,
        path: path.to_owned(),
        orig_path: None,
        index: status_char(xy, 0)?,
        worktree: status_char(xy, 1)?,
        submodule,
        similarity,
        stages: None,
    })
}

fn parse_unmerged(line: &str) -> Result<StatusEntry, String> {
    let mut parts = line.splitn(11, ' ');
    let _tag = parts.next();
    let xy = parts.next().ok_or("XY manquant")?;
    let submodule = parts.next().map(str::to_owned);
    let _m1 = parts.next();
    let _m2 = parts.next();
    let _m3 = parts.next();
    let _mw = parts.next();
    let base = parts.next().map(str::to_owned);
    let ours = parts.next().map(str::to_owned);
    let theirs = parts.next().map(str::to_owned);
    let path = parts.next().ok_or("chemin manquant")?;
    Ok(StatusEntry {
        kind: EntryKind::Unmerged,
        path: path.to_owned(),
        orig_path: None,
        index: status_char(xy, 0)?,
        worktree: status_char(xy, 1)?,
        submodule,
        similarity: None,
        stages: Some(ConflictStages { base, ours, theirs }),
    })
}

fn parse_untracked(line: &str, kind: EntryKind) -> Result<StatusEntry, String> {
    let mut parts = line.splitn(2, ' ');
    let _tag = parts.next();
    let path = parts.next().ok_or("chemin manquant")?;
    Ok(StatusEntry {
        kind,
        path: path.to_owned(),
        orig_path: None,
        index: '?',
        worktree: '?',
        submodule: None,
        similarity: None,
        stages: None,
    })
}

fn status_char(xy: &str, offset: usize) -> Result<char, String> {
    xy.chars()
        .nth(offset)
        .ok_or_else(|| format!("statut XY incomplet: {xy:?}"))
}

fn parse_score(score: &str) -> Result<(EntryKind, Option<u8>), String> {
    let mut chars = score.chars();
    let kind = match chars.next() {
        Some('R') => EntryKind::Renamed,
        Some('C') => EntryKind::Copied,
        Some(other) => return Err(format!("score inconnu: {other}")),
        None => return Err("score vide".to_owned()),
    };
    let value = chars.collect::<String>().parse().ok();
    Ok((kind, value))
}

/// Derive the structural state fields owned by `core` from a status report.
pub fn apply_to_state(state: &mut RepoState, report: &StatusReport) {
    state.worktree = report.worktree_state();
    state.conflicts.files = report.conflicts();
    if report.branch.unborn {
        state.head = Some(beebranch_core::HeadState::Unborn {
            branch: report.branch.head.clone(),
        });
    } else if report.branch.detached {
        if let Some(oid) = &report.branch.oid {
            state.head = Some(beebranch_core::HeadState::Detached { sha: oid.clone() });
        }
    } else if let Some(head) = &report.branch.head {
        state.head = Some(beebranch_core::HeadState::Branch {
            name: head.clone(),
            upstream: report.branch.upstream.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(input: &str) -> Vec<u8> {
        let mut bytes = input.as_bytes().to_vec();
        bytes.push(0);
        bytes
    }

    #[test]
    fn parses_branch_headers_and_counts() {
        let mut input = Vec::new();
        input.extend(record("# branch.oid abc123"));
        input.extend(record("# branch.head main"));
        input.extend(record("# branch.upstream origin/main"));
        input.extend(record("# branch.ab +2 -1"));
        input.extend(record("1 .M N... 100644 100644 100644 aaaa bbbb a.txt"));
        input.extend(record("? b.txt"));

        let report = parse_status(&input, 100).expect("parse");
        assert_eq!(report.branch.head.as_deref(), Some("main"));
        assert_eq!(report.branch.ahead, 2);
        assert_eq!(report.branch.behind, 1);
        assert_eq!(report.counts.unstaged, 1);
        assert_eq!(report.counts.untracked, 1);
        assert_eq!(report.entries[0].path, "a.txt");
    }

    #[test]
    fn parses_renames_with_original_path() {
        let mut input = Vec::new();
        input.extend(record("# branch.head main"));
        input.extend(record(
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 c.txt",
        ));
        input.extend(record("a.txt"));

        let report = parse_status(&input, 100).expect("parse");
        let entry = &report.entries[0];
        assert_eq!(entry.kind, EntryKind::Renamed);
        assert_eq!(entry.path, "c.txt");
        assert_eq!(entry.orig_path.as_deref(), Some("a.txt"));
        assert_eq!(entry.similarity, Some(100));
    }

    #[test]
    fn parses_conflicts_and_stages() {
        let mut input = Vec::new();
        input.extend(record(
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt",
        ));
        let report = parse_status(&input, 100).expect("parse");
        assert_eq!(report.counts.conflicted, 1);
        assert_eq!(report.conflicts(), vec!["conflict.txt"]);
        assert_eq!(
            report.entries[0]
                .stages
                .as_ref()
                .and_then(|s| s.theirs.as_deref()),
            Some("cccc")
        );
    }

    #[test]
    fn caps_entries_but_keeps_counts() {
        let mut input = Vec::new();
        input.extend(record("# branch.head main"));
        for index in 0..10 {
            input.extend(record(&format!("? file{index}.txt")));
        }
        let report = parse_status(&input, 3).expect("parse");
        assert_eq!(report.entries.len(), 3);
        assert!(report.truncated);
        assert_eq!(report.counts.untracked, 10);
    }

    #[test]
    fn keeps_unicode_paths() {
        let mut input = Vec::new();
        input.extend(record("? dossier/éàü.txt"));
        let report = parse_status(&input, 10).expect("parse");
        assert_eq!(report.entries[0].path, "dossier/éàü.txt");
    }

    #[test]
    fn derives_head_state() {
        let report = StatusReport {
            branch: BranchStatus {
                detached: true,
                oid: Some("abc".into()),
                ..BranchStatus::default()
            },
            ..StatusReport::default()
        };
        let mut state = RepoState::default();
        apply_to_state(&mut state, &report);
        assert!(matches!(
            state.head,
            Some(beebranch_core::HeadState::Detached { .. })
        ));
    }
}
