//! Bounded commit search by message, author or SHA.
//!
//! The search never scans the whole history implicitly: `depth` is an explicit
//! ceiling on returned matches, announced in the result and shown by the UI.

use std::path::Path;

use beebranch_core::{AppError, ErrorCategory, Page, PageRequest};
use serde::{Deserialize, Serialize};

use crate::log::{parse_log, CommitSummary};
use crate::process::{
    CaptureLimits, CommandSpec, GitRunner, OperationContext, ProcessEvent, RunningCommand,
};
use crate::GitSubcommand;

pub const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s";
pub const DEFAULT_DEPTH: u32 = 5_000;
pub const MAX_DEPTH: u32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    Message,
    Author,
    Sha,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    pub text: String,
    pub mode: SearchMode,
    /// Revision scope; `None` means HEAD.
    pub revision: Option<String>,
    /// Search every ref, including stash (`refs/stash`).
    pub all_refs: bool,
    pub depth: u32,
    pub request: PageRequest,
    /// Restrict history to one path (relative).
    pub path: Option<String>,
    /// Inclusive lower bound, Git date syntax (`2026-01-01`, `2.weeks.ago`).
    pub since: Option<String>,
    /// Inclusive upper bound.
    pub until: Option<String>,
    /// Author filter applied in addition to the search text.
    pub author: Option<String>,
}

impl SearchQuery {
    pub fn new(text: impl Into<String>, mode: SearchMode) -> Self {
        Self {
            text: text.into(),
            mode,
            revision: None,
            all_refs: false,
            depth: DEFAULT_DEPTH,
            request: PageRequest::first(100),
            path: None,
            since: None,
            until: None,
            author: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub commits: Vec<CommitSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub generation: u64,
    /// Ceiling applied to this search.
    pub depth: u32,
    /// True when the depth ceiling was reached; more matches may exist.
    pub truncated: bool,
    pub mode: SearchMode,
}

/// Build the bounded Git command for a query.
pub fn command(
    worktree: &Path,
    query: &SearchQuery,
    operation: &OperationContext,
) -> Result<CommandSpec, AppError> {
    let text = query.text.trim();
    if text.is_empty() {
        return Err(AppError::invalid_input("la recherche est vide".to_owned()));
    }
    if text.chars().any(|character| character.is_control()) {
        return Err(AppError::invalid_input(
            "la recherche contient un caractère de contrôle".to_owned(),
        ));
    }
    let depth = query.depth.clamp(1, MAX_DEPTH);
    let limit = query.request.limit().min(depth);
    let skip = match query.request.after.as_deref() {
        None => 0u32,
        Some(cursor) => cursor
            .parse::<u32>()
            .map_err(|_| AppError::invalid_input(format!("curseur invalide: {cursor:?}")))?,
    };

    if let Some(revision) = query.revision.as_deref() {
        crate::log::validate_revision(revision)?;
    }

    let mut spec = CommandSpec::new(GitSubcommand::Log, worktree)
        .no_timeout()
        .arg("--parents")
        .arg(format!("--format={LOG_FORMAT}"))
        .operation(operation.clone())
        .capture_limits(CaptureLimits {
            stdout: 32 * 1024 * 1024,
            stderr: 16 * 1024,
        });

    match query.mode {
        SearchMode::Sha => {
            let sha = text.trim();
            if sha.chars().any(char::is_whitespace) || sha.starts_with('-') {
                return Err(AppError::invalid_input(format!("SHA invalide: {sha:?}")));
            }
            spec = spec.arg("--no-walk").arg(sha);
            return Ok(spec);
        }
        SearchMode::Message => {
            spec = spec
                .arg(format!("--max-count={}", limit.saturating_add(1)))
                .arg(format!("--skip={skip}"))
                .arg("--fixed-strings")
                .arg("-i")
                .arg(format!("--grep={text}"));
        }
        SearchMode::Author => {
            spec = spec
                .arg(format!("--max-count={}", limit.saturating_add(1)))
                .arg(format!("--skip={skip}"))
                .arg("-i")
                .arg(format!("--author={text}"));
        }
    }

    if let Some(since) = query.since.as_deref() {
        validate_bound(since)?;
        spec = spec.arg(format!("--since={since}"));
    }
    if let Some(until) = query.until.as_deref() {
        validate_bound(until)?;
        spec = spec.arg(format!("--until={until}"));
    }
    if let Some(author) = query.author.as_deref() {
        validate_bound(author)?;
        spec = spec.arg(format!("--author={author}"));
    }
    if query.all_refs {
        spec = spec.arg("--all");
    } else if let Some(revision) = query.revision.as_deref() {
        spec = spec.arg(revision);
    }
    if let Some(path) = query.path.as_deref() {
        crate::blame::validate_path(path)?;
        spec = spec.arg("--").arg(path);
    }
    Ok(spec)
}

fn validate_bound(value: &str) -> Result<(), AppError> {
    if value
        .chars()
        .any(|character| character.is_control() || character == '\0')
    {
        return Err(AppError::invalid_input(
            "la borne de date contient un caractère de contrôle".to_owned(),
        ));
    }
    if value.starts_with('-') || value.trim().is_empty() {
        return Err(AppError::invalid_input(format!(
            "borne invalide: {value:?}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMatch {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSearch {
    pub items: Vec<PathMatch>,
    pub truncated: bool,
    pub limit: u32,
    /// Offset of the next page when more matches exist.
    pub next: Option<u32>,
}

/// Search tracked file paths by substring. Bounded by `limit`.
pub fn search_paths(
    runner: &GitRunner,
    worktree: &Path,
    needle: &str,
    limit: u32,
    offset: u32,
) -> Result<PathSearch, AppError> {
    let text = needle.trim();
    if text.is_empty() {
        return Err(AppError::invalid_input("la recherche est vide".to_owned()));
    }
    let bounded = limit.clamp(1, 2_000);
    let outcome = runner.run(
        &CommandSpec::new(GitSubcommand::LsFiles, worktree)
            .arg("-z")
            .arg("--cached")
            .capture_limits(CaptureLimits {
                stdout: 8 * 1024 * 1024,
                stderr: 16 * 1024,
            }),
    )?;
    let outcome = outcome.ensure_success()?;
    let lowered = text.to_lowercase();
    let mut items = Vec::new();
    let mut matched = 0u32;
    let mut more = false;
    'outer: for path in outcome.stdout.text_lossy().split('\0') {
        if path.is_empty() || !path.to_lowercase().contains(&lowered) {
            continue;
        }
        if matched < offset {
            matched += 1;
            continue;
        }
        if items.len() >= bounded as usize {
            more = true;
            break 'outer;
        }
        items.push(PathMatch {
            path: path.to_owned(),
        });
        matched += 1;
    }
    Ok(PathSearch {
        items,
        truncated: more || outcome.stdout.truncated(),
        limit: bounded,
        next: more.then(|| offset.saturating_add(bounded)),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearch {
    pub items: Vec<ContentMatch>,
    pub truncated: bool,
    pub limit: u32,
    /// Pathspec applied to the search, when any.
    pub path: Option<String>,
    /// Offset of the next page when more matches exist.
    pub next: Option<u32>,
}

/// Build the bounded `git grep` command used by content search.
pub fn content_command(
    worktree: &Path,
    needle: &str,
    path: Option<&str>,
    limit: u32,
    operation: &OperationContext,
) -> Result<CommandSpec, AppError> {
    let text = needle.trim();
    if text.is_empty() {
        return Err(AppError::invalid_input("la recherche est vide".to_owned()));
    }
    if text.chars().any(|character| character.is_control()) {
        return Err(AppError::invalid_input(
            "la recherche contient un caractère de contrôle".to_owned(),
        ));
    }
    let bounded = limit.clamp(1, 500);
    let mut spec = CommandSpec::new(GitSubcommand::Grep, worktree)
        .arg("-n")
        .arg("-I")
        .arg("--no-color")
        .arg("--fixed-strings")
        .arg(format!("--max-count={}", bounded.min(50)))
        .arg("-e")
        .arg(text)
        .timeout(std::time::Duration::from_secs(20))
        .operation(operation.clone())
        .capture_limits(CaptureLimits {
            stdout: 4 * 1024 * 1024,
            stderr: 16 * 1024,
        });
    if let Some(path) = path {
        crate::blame::validate_path(path)?;
        spec = spec.arg("--").arg(path);
    }
    Ok(spec)
}

/// Parse a completed content search.
pub fn finish_content(
    outcome: crate::process::CommandOutcome,
    path: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<ContentSearch, AppError> {
    if !outcome.success() && outcome.exit_code() != Some(1) {
        return Err(AppError::new(
            "search.content_failed",
            ErrorCategory::GitExit,
            "La recherche de contenu a échoué.",
        )
        .with_detail(outcome.stderr.redacted()));
    }
    let bounded = limit.clamp(1, 500);
    let mut all = Vec::new();
    for line in outcome.stdout.text_lossy().lines() {
        let Some((path, rest)) = line.split_once(':') else {
            continue;
        };
        let Some((line_number, text)) = rest.split_once(':') else {
            continue;
        };
        let Ok(line_number) = line_number.parse::<u32>() else {
            continue;
        };
        all.push(ContentMatch {
            path: path.to_owned(),
            line: line_number,
            text: text.chars().take(400).collect(),
        });
        if all.len() >= 5_000 {
            break;
        }
    }
    let start = (offset as usize).min(all.len());
    let end = start.saturating_add(bounded as usize).min(all.len());
    let items = all[start..end].to_vec();
    let more = end < all.len() || outcome.stdout.truncated();
    Ok(ContentSearch {
        items,
        truncated: more,
        limit: bounded,
        path: path.map(str::to_owned),
        next: more.then(|| offset.saturating_add(bounded)),
    })
}

/// Search file contents with `git grep`, bounded and cancellable.
pub fn search_content(
    runner: &GitRunner,
    worktree: &Path,
    needle: &str,
    path: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<ContentSearch, AppError> {
    let spec = content_command(worktree, needle, path, limit, &OperationContext::default())?;
    let outcome = runner.run(&spec)?;
    finish_content(outcome, path, limit, offset)
}

/// Run a search to completion.
pub fn run(
    runner: &GitRunner,
    worktree: &Path,
    query: &SearchQuery,
    generation: u64,
) -> Result<SearchResult, AppError> {
    let spec = command(worktree, query, &OperationContext::default())?;
    let outcome = runner.run(&spec)?.ensure_success()?;
    finish(outcome, query, generation)
}

/// Start a cancellable search.
pub fn spawn<F>(
    runner: &GitRunner,
    worktree: &Path,
    query: &SearchQuery,
    operation: &OperationContext,
    on_event: F,
) -> Result<RunningCommand, AppError>
where
    F: FnMut(ProcessEvent) + Send + 'static,
{
    let spec = command(worktree, query, operation)?;
    runner.spawn(&spec, on_event).map_err(AppError::from)
}

/// Parse a completed search.
pub fn finish(
    outcome: crate::process::CommandOutcome,
    query: &SearchQuery,
    generation: u64,
) -> Result<SearchResult, AppError> {
    let outcome = outcome.ensure_success()?;
    let mut commits = parse_log(&outcome.stdout.text_lossy())
        .map_err(|message| AppError::internal(format!("recherche de commits: {message}")))?;
    let depth = query.depth.clamp(1, MAX_DEPTH);
    let limit = query.request.limit().min(depth);
    let skip = query
        .request
        .after
        .as_deref()
        .and_then(|cursor| cursor.parse::<u32>().ok())
        .unwrap_or(0);
    let truncated =
        commits.len() > limit as usize || skip.saturating_add(commits.len() as u32) >= depth;
    commits.truncate(limit as usize);
    let next = (commits.len() == limit as usize && !matches!(query.mode, SearchMode::Sha))
        .then(|| (skip + limit).to_string());
    Ok(SearchResult {
        commits,
        next,
        generation,
        depth,
        truncated,
        mode: query.mode,
    })
}

/// Convert a search result into the shared page type.
pub fn as_page(result: SearchResult) -> Page<CommitSummary> {
    Page {
        items: result.commits,
        next: result.next,
        generation: result.generation,
        truncated: result.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_search() {
        let query = SearchQuery::new("  ", SearchMode::Message);
        assert!(command(Path::new("/tmp"), &query, &OperationContext::default()).is_err());
    }

    #[test]
    fn sha_mode_has_no_pagination() {
        let mut query = SearchQuery::new("abc123", SearchMode::Sha);
        query.request = PageRequest::first(10);
        let spec = command(Path::new("/tmp"), &query, &OperationContext::default()).expect("spec");
        assert_eq!(spec.subcommand(), GitSubcommand::Log);
    }
}
