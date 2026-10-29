//! Unified diff reader and parser with explicit ceilings.

use std::path::{Component, Path, PathBuf};

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};

use crate::process::{CaptureLimits, CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Default ceilings for a single diff request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffLimits {
    pub max_files: usize,
    pub max_lines_per_file: usize,
    /// Global line ceiling across every file, keeping the IPC payload under
    /// the 1 MiB contract even for multi-file diffs.
    pub max_total_lines: usize,
    pub context_lines: u32,
    pub max_bytes: usize,
}

impl Default for DiffLimits {
    fn default() -> Self {
        Self {
            max_files: 100,
            max_lines_per_file: 4_000,
            max_total_lines: 6_000,
            context_lines: 3,
            max_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
    /// The previous line of this side had no trailing newline.
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_path: String,
    pub new_path: String,
    pub kind: FileChangeKind,
    pub binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<DiffHunk>,
    /// True when the per-file line ceiling cut the hunks.
    pub truncated: bool,
    /// SHA-256 of the worktree file when the diff targets the worktree.
    /// The discard command requires this exact fingerprint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReport {
    pub files: Vec<FileDiff>,
    /// True when the file, byte or line ceiling was reached.
    pub truncated: bool,
}

/// Diff target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffTarget {
    WorkingTree,
    Index,
    Range {
        base: String,
        target: Option<String>,
    },
}

/// Read a diff from Git and parse it.
pub fn read_diff(
    runner: &GitRunner,
    worktree: &Path,
    target: &DiffTarget,
    paths: &[String],
    limits: DiffLimits,
) -> Result<DiffReport, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Diff, worktree)
        .arg("--no-color")
        .arg("--no-ext-diff")
        .arg("--no-textconv")
        .arg(format!("--unified={}", limits.context_lines))
        .capture_limits(CaptureLimits {
            stdout: limits.max_bytes.saturating_add(1024 * 1024),
            stderr: 16 * 1024,
        });

    match target {
        DiffTarget::WorkingTree => {}
        DiffTarget::Index => spec = spec.arg("--cached"),
        DiffTarget::Range { base, target } => {
            crate::log::validate_revision(base)?;
            spec = spec.arg(base);
            if let Some(target) = target {
                crate::log::validate_revision(target)?;
                spec = spec.arg(target);
            }
        }
    }

    if !paths.is_empty() {
        for path in paths {
            validate_relative_path(path)?;
            spec = spec.path(path);
        }
    }

    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    let mut report = parse_diff(&outcome.stdout.text_lossy(), limits)
        .map_err(|message| AppError::internal(format!("diff: {message}")))?;
    if outcome.stdout.truncated() {
        report.truncated = true;
    }
    if matches!(target, DiffTarget::WorkingTree) {
        for file in &mut report.files {
            if file.new_path != "/dev/null" {
                file.fingerprint = worktree_fingerprint(worktree, &file.new_path);
            }
        }
    }
    Ok(report)
}

/// Read the patch of a root commit (no parent to diff against).
pub fn read_root_patch(
    runner: &GitRunner,
    worktree: &Path,
    sha: &str,
    paths: &[String],
    limits: DiffLimits,
) -> Result<DiffReport, AppError> {
    crate::log::validate_revision(sha)?;
    let mut spec = CommandSpec::new(GitSubcommand::DiffTree, worktree)
        .args(["--no-commit-id", "-p", "--root", sha])
        .capture_limits(CaptureLimits {
            stdout: limits.max_bytes.saturating_add(1024 * 1024),
            stderr: 16 * 1024,
        });
    for path in paths {
        validate_relative_path(path)?;
        spec = spec.path(path);
    }
    let outcome = runner.run(&spec)?;
    let outcome = outcome.ensure_success()?;
    let mut report = parse_diff(&outcome.stdout.text_lossy(), limits)
        .map_err(|message| AppError::internal(format!("diff-tree: {message}")))?;
    if outcome.stdout.truncated() {
        report.truncated = true;
    }
    Ok(report)
}

/// Build a synthetic diff for an untracked file (never via a fake Git patch).
pub fn read_untracked_file(
    worktree: &Path,
    path: &str,
    limits: DiffLimits,
) -> Result<FileDiff, AppError> {
    validate_relative_path(path)?;
    let root = std::fs::canonicalize(worktree)
        .map_err(|error| AppError::internal(format!("worktree: {error}")))?;
    let candidate = root.join(path);
    let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
        AppError::invalid_input(format!(
            "fichier introuvable: {}: {error}",
            candidate.display()
        ))
    })?;
    if !canonical.starts_with(&root) {
        return Err(AppError::invalid_input(
            "le fichier sort du worktree".to_owned(),
        ));
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| AppError::internal(format!("métadonnées: {error}")))?;
    if metadata.is_dir() {
        return Err(AppError::invalid_input(
            "le chemin est un dossier".to_owned(),
        ));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|error| AppError::internal(format!("lecture du fichier: {error}")))?;
    let truncated = bytes.len() > limits.max_bytes;
    let bytes = &bytes[..bytes.len().min(limits.max_bytes)];

    if bytes.iter().take(8000).any(|byte| *byte == 0) {
        return Ok(FileDiff {
            old_path: path.to_owned(),
            new_path: path.to_owned(),
            kind: FileChangeKind::Added,
            binary: true,
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
            truncated,
            fingerprint: worktree_fingerprint(worktree, path),
        });
    }

    let text = String::from_utf8_lossy(bytes);
    let mut lines = Vec::new();
    let mut new_lineno = 1u32;
    let mut line_truncated = false;
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let last_index = raw_lines.len().saturating_sub(1);

    for (index, raw) in raw_lines.into_iter().enumerate() {
        if index >= limits.max_lines_per_file {
            line_truncated = true;
            break;
        }
        // A trailing newline produces a final empty element that is not a line.
        if index == last_index && raw.is_empty() {
            break;
        }
        lines.push(DiffLine {
            kind: DiffLineKind::Added,
            old_lineno: None,
            new_lineno: Some(new_lineno),
            content: raw.to_owned(),
            no_newline: index == last_index && !text.ends_with('\n'),
        });
        new_lineno += 1;
    }

    Ok(FileDiff {
        old_path: path.to_owned(),
        new_path: path.to_owned(),
        kind: FileChangeKind::Added,
        binary: false,
        additions: (new_lineno - 1).min(limits.max_lines_per_file as u32),
        deletions: 0,
        hunks: vec![DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: (new_lineno - 1).min(limits.max_lines_per_file as u32),
            section: String::new(),
            lines,
        }],
        truncated: truncated || line_truncated,
        fingerprint: worktree_fingerprint(worktree, path),
    })
}

fn worktree_fingerprint(worktree: &Path, path: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(worktree.join(path)).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// Parse a unified diff.
pub fn parse_diff(input: &str, limits: DiffLimits) -> Result<DiffReport, String> {
    let mut report = DiffReport::default();
    let mut current: Option<FileDiff> = None;
    let mut current_lines = 0usize;
    let mut hunk: Option<DiffHunk> = None;
    let mut old_lineno = 0u32;
    let mut new_lineno = 0u32;
    let mut total_lines = 0usize;

    for raw_line in input.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        if line.starts_with("diff --git ") {
            if let Some(mut file) = current.take() {
                finish_file(&mut file, &mut hunk);
                push_file(&mut report, file, limits.max_files);
            }
            current_lines = 0;
            hunk = None;
            let (old_path, new_path) = parse_git_header(line);
            current = Some(FileDiff {
                old_path,
                new_path,
                kind: FileChangeKind::Modified,
                binary: false,
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
                truncated: false,
                fingerprint: None,
            });
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };

        if line.starts_with("new file mode ") {
            file.kind = FileChangeKind::Added;
            file.old_path = "/dev/null".to_owned();
            continue;
        }
        if line.starts_with("deleted file mode ") {
            file.kind = FileChangeKind::Deleted;
            file.new_path = "/dev/null".to_owned();
            continue;
        }
        if let Some(path) = line.strip_prefix("rename from ") {
            file.kind = FileChangeKind::Renamed;
            file.old_path = unquote_path(path);
            continue;
        }
        if let Some(path) = line.strip_prefix("rename to ") {
            file.kind = FileChangeKind::Renamed;
            file.new_path = unquote_path(path);
            continue;
        }
        if let Some(path) = line.strip_prefix("copy from ") {
            file.kind = FileChangeKind::Copied;
            file.old_path = unquote_path(path);
            continue;
        }
        if let Some(path) = line.strip_prefix("copy to ") {
            file.kind = FileChangeKind::Copied;
            file.new_path = unquote_path(path);
            continue;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
            file.truncated = true;
            continue;
        }
        if let Some(path) = line.strip_prefix("--- ") {
            let path = path.split('\t').next().unwrap_or(path);
            let path = unquote_path(path);
            if path != "/dev/null" {
                file.old_path = strip_prefix(path);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            let path = path.split('\t').next().unwrap_or(path);
            let path = unquote_path(path);
            if path != "/dev/null" {
                file.new_path = strip_prefix(path);
            }
            continue;
        }
        if line.starts_with("@@ ") {
            finish_hunk(file, hunk.take());
            let (parsed, section) = parse_hunk_header(line)?;
            old_lineno = parsed.old_start;
            new_lineno = parsed.new_start;
            hunk = Some(DiffHunk {
                old_start: parsed.old_start,
                old_lines: parsed.old_lines,
                new_start: parsed.new_start,
                new_lines: parsed.new_lines,
                section,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(active) = hunk.as_mut() else {
            continue;
        };
        if line.starts_with('\\') {
            if let Some(previous) = active.lines.last_mut() {
                previous.no_newline = true;
            }
            continue;
        }

        current_lines += 1;
        total_lines += 1;
        if current_lines > limits.max_lines_per_file {
            file.truncated = true;
            report.truncated = true;
            continue;
        }
        if total_lines > limits.max_total_lines {
            file.truncated = true;
            report.truncated = true;
            break;
        }

        let (kind, content) = match line.as_bytes().first() {
            Some(b'+') => (DiffLineKind::Added, &line[1..]),
            Some(b'-') => (DiffLineKind::Removed, &line[1..]),
            Some(b' ') | Some(b'\t') => (DiffLineKind::Context, &line[1..]),
            None => continue,
            _ => continue,
        };

        match kind {
            DiffLineKind::Added => {
                file.additions += 1;
                active.lines.push(DiffLine {
                    kind,
                    old_lineno: None,
                    new_lineno: Some(new_lineno),
                    content: content.to_owned(),
                    no_newline: false,
                });
                new_lineno += 1;
            }
            DiffLineKind::Removed => {
                file.deletions += 1;
                active.lines.push(DiffLine {
                    kind,
                    old_lineno: Some(old_lineno),
                    new_lineno: None,
                    content: content.to_owned(),
                    no_newline: false,
                });
                old_lineno += 1;
            }
            DiffLineKind::Context => {
                active.lines.push(DiffLine {
                    kind,
                    old_lineno: Some(old_lineno),
                    new_lineno: Some(new_lineno),
                    content: content.to_owned(),
                    no_newline: false,
                });
                old_lineno += 1;
                new_lineno += 1;
            }
        }

        if active.lines.len() >= limits.max_lines_per_file {
            file.truncated = true;
            report.truncated = true;
        }
    }

    if let Some(mut file) = current.take() {
        finish_file(&mut file, &mut hunk);
        push_file(&mut report, file, limits.max_files);
    }

    Ok(report)
}

fn finish_hunk(file: &mut FileDiff, hunk: Option<DiffHunk>) {
    if let Some(hunk) = hunk {
        file.hunks.push(hunk);
    }
}

fn finish_file(file: &mut FileDiff, hunk: &mut Option<DiffHunk>) {
    if let Some(hunk) = hunk.take() {
        file.hunks.push(hunk);
    }
}

fn push_file(report: &mut DiffReport, file: FileDiff, max_files: usize) {
    if report.files.len() < max_files {
        report.files.push(file);
    } else {
        report.truncated = true;
    }
}

#[derive(Debug)]
struct HunkHeader {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
}

fn parse_hunk_header(line: &str) -> Result<(HunkHeader, String), String> {
    let end = line
        .find(" @@")
        .ok_or_else(|| format!("en-tête de hunk invalide: {line:?}"))?;
    let header = &line[3..end];
    let section = line[end + 3..].trim().to_owned();
    let mut parts = header.split(' ');
    let old = parts.next().ok_or("champ old manquant")?;
    let new = parts.next().ok_or("champ new manquant")?;
    let (old_start, old_lines) = parse_range(old.trim_start_matches('-'))?;
    let (new_start, new_lines) = parse_range(new.trim_start_matches('+'))?;
    Ok((
        HunkHeader {
            old_start,
            old_lines,
            new_start,
            new_lines,
        },
        section,
    ))
}

fn parse_range(value: &str) -> Result<(u32, u32), String> {
    match value.split_once(',') {
        Some((start, count)) => Ok((
            start.parse().map_err(|_| "début de hunk invalide")?,
            count.parse().map_err(|_| "taille de hunk invalide")?,
        )),
        None => Ok((value.parse().map_err(|_| "début de hunk invalide")?, 1)),
    }
}

fn parse_git_header(line: &str) -> (String, String) {
    let rest = line.trim_start_matches("diff --git ");
    if rest.starts_with('"') {
        let (old, consumed) = parse_quoted(rest);
        let remaining = rest[consumed..].trim_start();
        let (new, _) = parse_quoted(remaining);
        return (strip_prefix(old), strip_prefix(new));
    }
    if let Some(index) = rest.rfind(" b/") {
        let old = &rest[..index];
        let new = &rest[index + 1..];
        return (strip_prefix(old.to_owned()), strip_prefix(new.to_owned()));
    }
    (rest.to_owned(), rest.to_owned())
}

fn strip_prefix(path: String) -> String {
    if let Some(stripped) = path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
        stripped.to_owned()
    } else {
        path
    }
}

fn unquote_path(value: &str) -> String {
    if value.starts_with('"') {
        parse_quoted(value).0
    } else {
        value.to_owned()
    }
}

fn parse_quoted(input: &str) -> (String, usize) {
    let bytes = input.as_bytes();
    if bytes.first() != Some(&b'"') {
        return (input.to_owned(), input.len());
    }

    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return (String::from_utf8_lossy(&output).into_owned(), index + 1),
            b'\\' => {
                index += 1;
                let Some(&escaped) = bytes.get(index) else {
                    break;
                };
                match escaped {
                    b'n' => output.push(b'\n'),
                    b't' => output.push(b'\t'),
                    b'r' => output.push(b'\r'),
                    b'b' => output.push(0x08),
                    b'f' => output.push(0x0c),
                    b'a' => output.push(0x07),
                    b'v' => output.push(0x0b),
                    b'\\' => output.push(b'\\'),
                    b'"' => output.push(b'"'),
                    b'0'..=b'7' => {
                        let mut value: u32 = 0;
                        let mut count = 0;
                        while count < 3 {
                            let Some(&digit) = bytes.get(index) else {
                                break;
                            };
                            if !(b'0'..=b'7').contains(&digit) {
                                break;
                            }
                            value = value * 8 + u32::from(digit - b'0');
                            index += 1;
                            count += 1;
                        }
                        output.push(value as u8);
                        continue;
                    }
                    other => output.push(other),
                }
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    (String::from_utf8_lossy(&output).into_owned(), input.len())
}

/// Reject absolute paths, parent traversal and `.git` internals.
pub fn validate_relative_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::invalid_input(
            "chemin vide ou invalide".to_owned(),
        ));
    }
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return Err(AppError::invalid_input(
            "un chemin relatif est attendu".to_owned(),
        ));
    }
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                return Err(AppError::invalid_input(
                    "le chemin ne peut pas sortir du dépôt".to_owned(),
                ));
            }
            Component::Normal(name) if name == ".git" => {
                return Err(AppError::invalid_input(
                    "le dossier .git n'est pas un fichier de travail".to_owned(),
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 111..222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@ fn main
 line one
-old line
+new line
+added line
 last line
";

    #[test]
    fn parses_a_modified_file() {
        let report = parse_diff(SAMPLE, DiffLimits::default()).expect("parse");
        assert_eq!(report.files.len(), 1);
        let file = &report.files[0];
        assert_eq!(file.old_path, "src/main.rs");
        assert_eq!(file.new_path, "src/main.rs");
        assert_eq!(file.kind, FileChangeKind::Modified);
        assert_eq!(file.additions, 2);
        assert_eq!(file.deletions, 1);
        let hunk = &file.hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.section, "fn main");
        assert_eq!(hunk.lines.len(), 5);
        assert_eq!(hunk.lines[1].old_lineno, Some(2));
        assert_eq!(hunk.lines[1].kind, DiffLineKind::Removed);
        assert_eq!(hunk.lines[2].new_lineno, Some(2));
        assert_eq!(hunk.lines[2].kind, DiffLineKind::Added);
    }

    #[test]
    fn handles_new_deleted_and_renamed_files() {
        let input = "\
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/from.txt b/to.txt
similarity index 100%
rename from from.txt
rename to to.txt
";
        let report = parse_diff(input, DiffLimits::default()).expect("parse");
        assert_eq!(report.files.len(), 3);
        assert_eq!(report.files[0].kind, FileChangeKind::Added);
        assert_eq!(report.files[1].kind, FileChangeKind::Deleted);
        assert_eq!(report.files[2].kind, FileChangeKind::Renamed);
        assert_eq!(report.files[2].old_path, "from.txt");
        assert_eq!(report.files[2].new_path, "to.txt");
    }

    #[test]
    fn handles_binary_and_missing_newline() {
        let input = "\
diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/text.txt b/text.txt
--- a/text.txt
+++ b/text.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
";
        let report = parse_diff(input, DiffLimits::default()).expect("parse");
        assert!(report.files[0].binary);
        assert!(report.files[1].hunks[0].lines[0].no_newline);
    }

    #[test]
    fn handles_quoted_unicode_paths() {
        let input = "\
diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"
--- \"a/caf\\303\\251.txt\"
+++ \"b/caf\\303\\251.txt\"
@@ -1 +1 @@
-a
+b
";
        let report = parse_diff(input, DiffLimits::default()).expect("parse");
        assert_eq!(report.files[0].new_path, "café.txt");
    }

    #[test]
    fn handles_crlf_content_without_breaking_line_counts() {
        let input = "diff --git a/a.txt b/a.txt\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n";
        let report = parse_diff(input, DiffLimits::default()).expect("parse");
        assert_eq!(report.files[0].additions, 1);
        assert_eq!(report.files[0].deletions, 1);
    }

    #[test]
    fn applies_line_ceiling() {
        let mut input = String::from("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,100 @@\n");
        for _ in 0..100 {
            input.push_str("+line\n");
        }
        let limits = DiffLimits {
            max_lines_per_file: 10,
            ..DiffLimits::default()
        };
        let report = parse_diff(&input, limits).expect("parse");
        assert!(report.truncated);
        assert!(report.files[0].truncated);
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_relative_path("../etc/passwd").is_err());
        let absolute = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };
        assert!(validate_relative_path(absolute).is_err());
        assert!(validate_relative_path(".git/config").is_err());
        assert!(validate_relative_path("src/main.rs").is_ok());
    }
}
