//! Index operations: file, hunk and line staging, unstaging and discard.
//!
//! Patches are produced from the exact `git diff` output (never synthesized by
//! hand), reduced to the selected hunks/lines, then applied with
//! `git apply --cached` (or `--reverse` for discard). A failed check aborts
//! before any write: Git never leaves a half-applied patch behind in one
//! invocation, and the two-phase check makes the failure explicit.

use std::io::Write;
use std::path::{Path, PathBuf};

use beebranch_core::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::diff::validate_relative_path;
use crate::process::{CaptureLimits, CommandSpec, GitRunner, StdinMode};
use crate::GitSubcommand;

const PATCH_LIMIT: usize = 64 * 1024 * 1024;

/// One hunk selection. `lines` indexes into the parsed hunk lines; `None`
/// selects the whole hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub hunk: usize,
    pub lines: Option<Vec<usize>>,
}

/// Selection of all hunks (or a subset) of one path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSelection {
    pub path: String,
    /// Empty means "whole file", handled by `git add`/`restore` directly.
    #[serde(default)]
    pub hunks: Vec<HunkSelection>,
}

/// Expected SHA-256 of a worktree file captured when the diff was displayed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub path: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub files: Vec<String>,
    pub hunks: usize,
    pub patch_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchSource {
    Worktree,
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchMode {
    /// Forward patch applied to the index: keep unselected removals in the
    /// index by turning them into context.
    Stage,
    /// Reverse patch applied to the index: only selected changes participate.
    Unstage,
    /// Reverse patch applied to the worktree: only selected changes.
    Discard,
}

/// Stage whole files or hunks/lines from the worktree to the index.
pub fn stage(
    runner: &GitRunner,
    worktree: &Path,
    selections: &[PathSelection],
) -> Result<IndexResult, AppError> {
    run_selection(
        runner,
        worktree,
        selections,
        PatchSource::Worktree,
        PatchMode::Stage,
    )
}

/// Unstage whole files or hunks/lines from the index.
pub fn unstage(
    runner: &GitRunner,
    worktree: &Path,
    selections: &[PathSelection],
) -> Result<IndexResult, AppError> {
    run_selection(
        runner,
        worktree,
        selections,
        PatchSource::Index,
        PatchMode::Unstage,
    )
}

/// Discard worktree changes for whole files or selected hunks/lines.
///
/// `expected` is mandatory for hunk/line discard and checked for file discard
/// too: a file modified since the displayed diff is never overwritten.
pub fn discard(
    runner: &GitRunner,
    worktree: &Path,
    selections: &[PathSelection],
    expected: &[Fingerprint],
) -> Result<IndexResult, AppError> {
    verify_fingerprints(worktree, selections, expected)?;
    for selection in selections {
        if is_untracked(runner, worktree, &selection.path)? {
            return Err(AppError::new(
                "discard.untracked",
                beebranch_core::ErrorCategory::Input,
                "Un fichier non suivi n'est jamais supprimé par l'application.",
            )
            .with_remediation(
                "Ajoutez-le au .gitignore ou supprimez-le explicitement dans votre gestionnaire de fichiers.",
            ));
        }
    }
    run_selection(
        runner,
        worktree,
        selections,
        PatchSource::Worktree,
        PatchMode::Discard,
    )
}

/// Add an ignore pattern to the repository `.gitignore`.
pub fn add_ignore_pattern(worktree: &Path, pattern: &str) -> Result<String, AppError> {
    let pattern = pattern.trim();
    if pattern.is_empty()
        || pattern.contains('\0')
        || pattern.contains('\n')
        || pattern.contains('\r')
    {
        return Err(AppError::invalid_input(
            "motif d'ignorance invalide".to_owned(),
        ));
    }
    if pattern.starts_with('/') || pattern.contains("..") {
        return Err(AppError::invalid_input(
            "le motif doit rester relatif au dépôt".to_owned(),
        ));
    }
    let path = worktree.join(".gitignore");
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err(AppError::new(
                "ignore.symlink",
                beebranch_core::ErrorCategory::Input,
                "Le .gitignore du dépôt est un lien symbolique.",
            )
            .with_remediation(
                "Modifiez le fichier cible explicitement ; l'application n'écrit pas à travers un lien.",
            ));
        }
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(pattern.to_owned());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| AppError::internal(format!(".gitignore: {error}")))?;
    let prefix = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    file.write_all(format!("{prefix}{pattern}\n").as_bytes())
        .map_err(|error| AppError::internal(format!(".gitignore: {error}")))?;
    file.sync_all()
        .map_err(|error| AppError::internal(format!(".gitignore: {error}")))?;
    Ok(pattern.to_owned())
}

/// SHA-256 of a worktree file, or `None` when it does not exist.
pub fn fingerprint(worktree: &Path, path: &str) -> Result<Option<String>, AppError> {
    validate_relative_path(path)?;
    let absolute = worktree.join(path);
    let bytes = match std::fs::read(&absolute) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::internal(format!(
                "empreinte de {}: {error}",
                absolute.display()
            )))
        }
    };
    Ok(Some(hex_digest(&bytes)))
}

/// SHA-256 fingerprints for a set of paths.
pub fn fingerprints(worktree: &Path, paths: &[String]) -> Result<Vec<Fingerprint>, AppError> {
    paths
        .iter()
        .map(|path| {
            Ok(Fingerprint {
                path: path.clone(),
                sha256: fingerprint(worktree, path)?,
            })
        })
        .collect()
}

fn run_selection(
    runner: &GitRunner,
    worktree: &Path,
    selections: &[PathSelection],
    source: PatchSource,
    mode: PatchMode,
) -> Result<IndexResult, AppError> {
    if selections.is_empty() {
        return Err(AppError::invalid_input(
            "aucune sélection fournie".to_owned(),
        ));
    }
    let mut result = IndexResult::default();

    let whole: Vec<&PathSelection> = selections
        .iter()
        .filter(|selection| selection.hunks.is_empty())
        .collect();
    let partial: Vec<&PathSelection> = selections
        .iter()
        .filter(|selection| !selection.hunks.is_empty())
        .collect();

    if !whole.is_empty() && !partial.is_empty() {
        return Err(AppError::new(
            "index.mixed_selection",
            beebranch_core::ErrorCategory::Input,
            "Une requête ne peut pas mélanger fichiers entiers et hunks.",
        )
        .with_remediation("Effectuez les deux actions séparément pour garder un index cohérent."));
    }

    if !whole.is_empty() {
        let paths: Vec<String> = whole
            .iter()
            .map(|selection| selection.path.clone())
            .collect();
        for path in &paths {
            validate_relative_path(path)?;
        }
        match mode {
            PatchMode::Stage => {
                let mut spec = CommandSpec::new(GitSubcommand::Add, worktree).arg("-A");
                for path in &paths {
                    spec = spec.path(path);
                }
                let outcome = runner.run(&spec)?.ensure_success()?;
                let detail = outcome.stderr.redacted();
                if !detail.trim().is_empty() {
                    tracing::debug!(detail, "git add");
                }
            }
            PatchMode::Unstage => unstage_paths(runner, worktree, &paths)?,
            PatchMode::Discard => {
                let mut spec = CommandSpec::new(GitSubcommand::Restore, worktree).arg("--worktree");
                for path in &paths {
                    spec = spec.path(path);
                }
                runner.run(&spec)?.ensure_success()?;
            }
        }
        result.files.extend(paths);
    }

    if !partial.is_empty() {
        let paths: Vec<String> = partial
            .iter()
            .map(|selection| selection.path.clone())
            .collect();
        let raw = read_patch(runner, worktree, source, &paths)?;
        let patch = build_patch(&raw, &partial, mode)?;
        if patch.files.is_empty() {
            return Err(AppError::invalid_input(
                "la sélection ne contient aucun changement".to_owned(),
            ));
        }
        apply_patch(
            runner,
            worktree,
            &patch.text,
            matches!(mode, PatchMode::Stage | PatchMode::Unstage),
            matches!(mode, PatchMode::Unstage | PatchMode::Discard),
        )?;
        result.files.extend(patch.files);
        result.hunks = patch.hunks;
        result.patch_bytes = patch.text.len();
    }

    result.files.sort();
    result.files.dedup();
    Ok(result)
}

fn unstage_paths(runner: &GitRunner, worktree: &Path, paths: &[String]) -> Result<(), AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Restore, worktree).arg("--staged");
    for path in paths {
        spec = spec.path(path);
    }
    match runner.run(&spec)?.ensure_success() {
        Ok(_) => Ok(()),
        Err(error) => {
            // An unborn HEAD has no index to restore from; removing the cache
            // entry is the equivalent operation and still leaves the file.
            if !has_head(runner, worktree)? {
                let mut remove = CommandSpec::new(GitSubcommand::Rm, worktree)
                    .arg("--cached")
                    .arg("-r");
                for path in paths {
                    remove = remove.path(path);
                }
                runner.run(&remove)?.ensure_success()?;
                Ok(())
            } else {
                Err(error.into())
            }
        }
    }
}

fn has_head(runner: &GitRunner, worktree: &Path) -> Result<bool, AppError> {
    let spec =
        CommandSpec::new(GitSubcommand::RevParse, worktree).args(["--verify", "--quiet", "HEAD"]);
    let outcome = runner.run(&spec)?;
    Ok(outcome.success())
}

fn is_untracked(runner: &GitRunner, worktree: &Path, path: &str) -> Result<bool, AppError> {
    validate_relative_path(path)?;
    let spec = CommandSpec::new(GitSubcommand::LsFiles, worktree)
        .arg("--error-unmatch")
        .arg("-z")
        .path(path);
    let outcome = runner.run(&spec)?;
    Ok(!outcome.success())
}

fn verify_fingerprints(
    worktree: &Path,
    selections: &[PathSelection],
    expected: &[Fingerprint],
) -> Result<(), AppError> {
    if expected.is_empty() {
        return Err(AppError::new(
            "discard.stale",
            beebranch_core::ErrorCategory::Input,
            "L'empreinte des fichiers est requise avant un discard.",
        )
        .with_remediation("Rechargez le diff puis confirmez à nouveau."));
    }
    let mut expected_paths: Vec<&str> = expected.iter().map(|entry| entry.path.as_str()).collect();
    expected_paths.sort_unstable();
    expected_paths.dedup();
    let mut selection_paths: Vec<&str> = selections
        .iter()
        .map(|selection| selection.path.as_str())
        .collect();
    selection_paths.sort_unstable();
    selection_paths.dedup();
    if expected_paths != selection_paths {
        return Err(AppError::new(
            "discard.stale",
            beebranch_core::ErrorCategory::Input,
            "Les empreintes ne couvrent pas exactement les fichiers sélectionnés.",
        )
        .with_remediation("Rechargez le diff puis confirmez à nouveau."));
    }
    for entry in expected {
        let current = fingerprint(worktree, &entry.path)?;
        if current != entry.sha256 {
            return Err(AppError::new(
                "discard.stale",
                beebranch_core::ErrorCategory::GitState,
                "Le fichier a changé depuis l'affichage du diff.",
            )
            .with_detail(format!(
                "{} : affiché {:?}, actuel {:?}",
                entry.path, entry.sha256, current
            ))
            .with_remediation("Rechargez le diff et recommencez le discard."));
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct RawPatch {
    files: Vec<RawFile>,
}

#[derive(Debug, Clone)]
struct RawFile {
    header: String,
    old_path: String,
    new_path: String,
    has_rename: bool,
    hunks: Vec<RawHunk>,
}

#[derive(Debug, Clone)]
struct RawHunk {
    header: String,
    lines: Vec<RawLine>,
}

#[derive(Debug, Clone)]
struct RawLine {
    kind: char,
    content: String,
    no_newline: bool,
}

fn read_patch(
    runner: &GitRunner,
    worktree: &Path,
    source: PatchSource,
    paths: &[String],
) -> Result<RawPatch, AppError> {
    let mut spec = CommandSpec::new(GitSubcommand::Diff, worktree)
        .args([
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=3",
        ])
        .capture_limits(CaptureLimits {
            stdout: PATCH_LIMIT,
            stderr: 16 * 1024,
        });
    if source == PatchSource::Index {
        spec = spec.arg("--cached");
    }
    for path in paths {
        validate_relative_path(path)?;
        spec = spec.path(path);
    }
    let outcome = runner.run(&spec)?.ensure_success()?;
    if outcome.stdout.truncated() {
        return Err(AppError::new(
            "index.patch_too_large",
            beebranch_core::ErrorCategory::Input,
            "Le patch dépasse le plafond de sécurité.",
        )
        .with_remediation("Stagez le fichier entier ou par hunks plus petits."));
    }
    parse_patch(&outcome.stdout.text_lossy())
        .map_err(|message| AppError::internal(format!("patch: {message}")))
}

fn parse_patch(input: &str) -> Result<RawPatch, String> {
    let mut files = Vec::new();
    let mut current: Option<RawFile> = None;
    let mut current_hunk: Option<RawHunk> = None;
    let mut pending_no_newline = false;

    for raw in input.split('\n') {
        if raw.is_empty() {
            continue;
        }
        if raw.starts_with("diff --git ") {
            flush_hunk(&mut current, &mut current_hunk);
            if let Some(file) = current.take() {
                files.push(file);
            }
            current = Some(RawFile {
                header: format!("{raw}\n"),
                old_path: String::new(),
                new_path: String::new(),
                has_rename: false,
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        if let Some(path) = raw.strip_prefix("--- ") {
            let path = path.split('\t').next().unwrap_or(path);
            file.old_path = normalize_patch_path(path);
            file.header.push_str(raw);
            file.header.push('\n');
            continue;
        }
        if let Some(path) = raw.strip_prefix("+++ ") {
            let path = path.split('\t').next().unwrap_or(path);
            file.new_path = normalize_patch_path(path);
            file.header.push_str(raw);
            file.header.push('\n');
            continue;
        }
        if raw.starts_with("rename from ") || raw.starts_with("rename to ") {
            file.has_rename = true;
        }
        if raw.starts_with("@@ ") {
            flush_hunk(&mut current, &mut current_hunk);
            current_hunk = Some(RawHunk {
                header: format!("{raw}\n"),
                lines: Vec::new(),
            });
            continue;
        }
        if raw.starts_with('\\') {
            if let Some(hunk) = current_hunk.as_mut() {
                if let Some(line) = hunk.lines.last_mut() {
                    line.no_newline = true;
                }
                pending_no_newline = false;
            }
            continue;
        }
        if let Some(hunk) = current_hunk.as_mut() {
            let mut chars = raw.chars();
            let Some(kind) = chars.next() else {
                continue;
            };
            if matches!(kind, ' ' | '+' | '-') {
                hunk.lines.push(RawLine {
                    kind,
                    content: chars.collect(),
                    no_newline: pending_no_newline,
                });
                pending_no_newline = false;
            }
            continue;
        }
        file.header.push_str(raw);
        file.header.push('\n');
    }

    flush_hunk(&mut current, &mut current_hunk);
    if let Some(file) = current.take() {
        files.push(file);
    }
    if files.is_empty() && !input.trim().is_empty() {
        return Err("aucun fichier parsé".to_owned());
    }
    Ok(RawPatch { files })
}

fn flush_hunk(current: &mut Option<RawFile>, hunk: &mut Option<RawHunk>) {
    if let (Some(file), Some(hunk)) = (current.as_mut(), hunk.take()) {
        if !hunk.lines.is_empty() {
            file.hunks.push(hunk);
        }
    }
}

fn normalize_patch_path(path: &str) -> String {
    let path = unquote_path(path);
    if path == "/dev/null" {
        return path;
    }
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(&path)
        .to_owned()
}

fn unquote_path(value: &str) -> String {
    if !value.starts_with('"') {
        return value.to_owned();
    }
    let bytes = value.as_bytes();
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => break,
            b'\\' => {
                index += 1;
                let Some(&escaped) = bytes.get(index) else {
                    break;
                };
                match escaped {
                    b'n' => output.push(b'\n'),
                    b't' => output.push(b'\t'),
                    b'r' => output.push(b'\r'),
                    b'a' => output.push(0x07),
                    b'b' => output.push(0x08),
                    b'f' => output.push(0x0c),
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
    String::from_utf8_lossy(&output).into_owned()
}

#[derive(Debug)]
struct BuiltPatch {
    text: String,
    files: Vec<String>,
    hunks: usize,
}

fn build_patch(
    raw: &RawPatch,
    selections: &[&PathSelection],
    mode: PatchMode,
) -> Result<BuiltPatch, AppError> {
    let mut text = String::new();
    let mut touched = Vec::new();
    let mut hunk_count = 0usize;

    for selection in selections {
        let file = raw
            .files
            .iter()
            .find(|file| {
                file.new_path == selection.path
                    || file.old_path == selection.path
                    || (selection.path == file.new_path && file.old_path == "/dev/null")
            })
            .ok_or_else(|| {
                AppError::new(
                    "index.path_not_changed",
                    beebranch_core::ErrorCategory::Input,
                    "Le chemin sélectionné n'apparaît pas dans le diff.",
                )
                .with_detail(selection.path.clone())
            })?;
        if file.has_rename {
            return Err(AppError::new(
                "index.rename_unsupported",
                beebranch_core::ErrorCategory::Input,
                "Le staging partiel d'un renommage n'est pas supporté.",
            )
            .with_remediation("Stagez le fichier entier pour préserver le renommage."));
        }

        let mut file_text = file.header.clone();
        let mut file_hunks = 0usize;
        for selected in &selection.hunks {
            let hunk = file.hunks.get(selected.hunk).ok_or_else(|| {
                AppError::invalid_input(format!(
                    "hunk {} inexistant pour {}",
                    selected.hunk, selection.path
                ))
            })?;
            let rendered = render_hunk(hunk, selected.lines.as_deref(), mode)?;
            if rendered.is_empty() {
                continue;
            }
            file_text.push_str(&rendered);
            file_hunks += 1;
        }
        if file_hunks == 0 {
            continue;
        }
        text.push_str(&file_text);
        touched.push(selection.path.clone());
        hunk_count += file_hunks;
    }

    Ok(BuiltPatch {
        text,
        files: touched,
        hunks: hunk_count,
    })
}

fn render_hunk(
    hunk: &RawHunk,
    selected_lines: Option<&[usize]>,
    mode: PatchMode,
) -> Result<String, AppError> {
    let mut rendered: Vec<(char, &RawLine)> = Vec::new();
    let mut selected = vec![false; hunk.lines.len()];
    if let Some(lines) = selected_lines {
        if lines.is_empty() {
            return Err(AppError::invalid_input(
                "aucune ligne sélectionnée dans un hunk".to_owned(),
            ));
        }
        for &index in lines {
            let line = hunk.lines.get(index).ok_or_else(|| {
                AppError::invalid_input(format!("ligne {index} inexistante dans le hunk"))
            })?;
            if line.kind == ' ' {
                return Err(AppError::invalid_input(format!(
                    "la ligne {index} est du contexte et ne peut pas être sélectionnée"
                )));
            }
            selected[index] = true;
        }
    } else {
        selected.fill(true);
    }

    let changed = hunk
        .lines
        .iter()
        .filter(|line| line.kind == '+' || line.kind == '-')
        .count();
    let selected_changes = hunk
        .lines
        .iter()
        .enumerate()
        .filter(|(index, line)| (line.kind == '+' || line.kind == '-') && selected[*index])
        .count();
    if selected_lines.is_some()
        && hunk.lines.iter().any(|line| line.no_newline)
        && selected_changes < changed
    {
        return Err(AppError::new(
            "index.newline_partial",
            beebranch_core::ErrorCategory::Input,
            "Un hunk sans newline final ne peut pas être stageé partiellement.",
        )
        .with_remediation("Sélectionnez le hunk entier ou le fichier entier."));
    }

    for (index, line) in hunk.lines.iter().enumerate() {
        let reverse = matches!(mode, PatchMode::Unstage | PatchMode::Discard);
        let include = selected[index]
            || line.kind == ' '
            || (mode == PatchMode::Stage && line.kind == '-')
            || (reverse && line.kind == '+');
        if include {
            // Unselected changes still present on the target side become
            // context: removals for a forward patch, additions for a reverse
            // patch. Dropping them would break hunk contiguity.
            let kind = if !selected[index]
                && ((mode == PatchMode::Stage && line.kind == '-') || (reverse && line.kind == '+'))
            {
                ' '
            } else {
                line.kind
            };
            rendered.push((kind, line));
        }
    }
    if !rendered
        .iter()
        .any(|(kind, _)| *kind == '+' || *kind == '-')
    {
        return Ok(String::new());
    }

    let (old_start, new_start, section) = parse_hunk_header(&hunk.header)?;
    let old_count = rendered
        .iter()
        .filter(|(kind, _)| *kind == ' ' || *kind == '-')
        .count();
    let new_count = rendered
        .iter()
        .filter(|(kind, _)| *kind == ' ' || *kind == '+')
        .count();

    let mut output = format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@");
    if !section.is_empty() {
        output.push(' ');
        output.push_str(&section);
    }
    output.push('\n');
    for (kind, line) in rendered {
        output.push(kind);
        output.push_str(&line.content);
        output.push('\n');
        if line.no_newline {
            output.push_str("\\ No newline at end of file\n");
        }
    }
    Ok(output)
}

fn parse_hunk_header(header: &str) -> Result<(u32, u32, String), AppError> {
    let line = header.trim_end();
    let end = line
        .find(" @@")
        .ok_or_else(|| AppError::internal(format!("en-tête de hunk invalide: {line:?}")))?;
    let ranges = &line[3..end];
    let section = line[end + 3..].trim().to_owned();
    let mut parts = ranges.split(' ');
    let old = parts
        .next()
        .ok_or_else(|| AppError::internal("ancienne plage manquante"))?;
    let new = parts
        .next()
        .ok_or_else(|| AppError::internal("nouvelle plage manquante"))?;
    let old_start = old
        .trim_start_matches('-')
        .split(',')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::internal("début old invalide"))?;
    let new_start = new
        .trim_start_matches('+')
        .split(',')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::internal("début new invalide"))?;
    Ok((old_start, new_start, section))
}

fn apply_patch(
    runner: &GitRunner,
    worktree: &Path,
    patch: &str,
    cached: bool,
    reverse: bool,
) -> Result<(), AppError> {
    let base = |check: bool| {
        let mut spec = CommandSpec::new(GitSubcommand::Apply, worktree)
            .arg("--recount")
            .arg("--whitespace=nowarn")
            .stdin(StdinMode::Bytes(patch.as_bytes().to_vec()));
        if cached {
            spec = spec.arg("--cached");
        }
        if reverse {
            spec = spec.arg("--reverse");
        }
        if check {
            spec = spec.arg("--check");
        }
        spec
    };

    if let Err(error) = runner.run(&base(true))?.ensure_success() {
        let detail = error.detail().unwrap_or_default().to_owned();
        return Err(AppError::new(
            "index.patch_conflict",
            beebranch_core::ErrorCategory::GitState,
            "Le patch ne s'applique plus au contenu actuel.",
        )
        .with_detail(detail)
        .with_remediation(
            "Rafraîchissez le status puis recommencez ; aucune modification n'a été appliquée.",
        ));
    }
    runner.run(&base(false))?.ensure_success()?;
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[allow(dead_code)]
fn absolute(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_patch() -> &'static str {
        "diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+extra\n three\n"
    }

    #[test]
    fn parses_a_unified_patch() {
        let raw = parse_patch(sample_patch()).expect("parse");
        assert_eq!(raw.files.len(), 1);
        let file = &raw.files[0];
        assert_eq!(file.old_path, "a.txt");
        assert_eq!(file.new_path, "a.txt");
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].lines.len(), 5);
    }

    #[test]
    fn stage_keeps_unselected_removals_as_context() {
        let raw = parse_patch(sample_patch()).expect("parse");
        let selection = PathSelection {
            path: "a.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![2]),
            }],
        };
        let built = build_patch(&raw, &[&selection], PatchMode::Stage).expect("build");
        assert!(built.text.contains("+TWO"));
        assert!(!built.text.contains("+extra"));
        assert!(built.text.contains(" two"));
        assert!(!built.text.contains("-two"));
        assert!(built.text.contains("@@ -1,3 +1,4 @@"));
    }

    #[test]
    fn unstage_only_emits_selected_changes() {
        let raw = parse_patch(sample_patch()).expect("parse");
        let selection = PathSelection {
            path: "a.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![2]),
            }],
        };
        let built = build_patch(&raw, &[&selection], PatchMode::Unstage).expect("build");
        assert!(built.text.contains("+TWO"));
        assert!(!built.text.contains("+extra"));
        assert!(!built.text.contains(" two"));
    }

    #[test]
    fn preserves_missing_newline_marker() {
        let input = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
        let raw = parse_patch(input).expect("parse");
        let selection = PathSelection {
            path: "a".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        };
        let built = build_patch(&raw, &[&selection], PatchMode::Stage).expect("build");
        assert_eq!(
            built.text.matches("\\ No newline at end of file").count(),
            2
        );
    }

    #[test]
    fn rejects_context_line_selection() {
        let raw = parse_patch(sample_patch()).expect("parse");
        let selection = PathSelection {
            path: "a.txt".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![0]),
            }],
        };
        assert!(build_patch(&raw, &[&selection], PatchMode::Stage).is_err());
    }

    #[test]
    fn rejects_rename_for_partial_staging() {
        let input = "diff --git a/from b/to\nsimilarity index 90%\nrename from from\nrename to to\n--- a/from\n+++ b/to\n@@ -1 +1 @@\n-a\n+b\n";
        let raw = parse_patch(input).expect("parse");
        let selection = PathSelection {
            path: "to".into(),
            hunks: vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        };
        let error = build_patch(&raw, &[&selection], PatchMode::Stage).expect_err("rename");
        assert_eq!(error.code, "index.rename_unsupported");
    }

    #[test]
    fn fingerprints_detect_missing_and_present_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("a"), b"one").expect("write");
        let value = fingerprint(dir.path(), "a")
            .expect("fingerprint")
            .expect("some");
        assert_eq!(value.len(), 64);
        assert_eq!(fingerprint(dir.path(), "missing").expect("missing"), None);
    }
}
