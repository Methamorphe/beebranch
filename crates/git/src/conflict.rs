//! Three-way conflict workspace: read stages plus the working file, write a
//! resolution atomically, then optionally mark the path resolved.
//!
//! Binary stages and files above [`MAX_CONFLICT_BYTES`] are reported
//! explicitly; they are never decoded lossily into the editor.

use std::path::{Component, Path, PathBuf};

use beebranch_core::{AppError, ErrorCategory};
use serde::{Deserialize, Serialize};

use crate::process::GitRunner;

pub const MAX_CONFLICT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Mixed,
    None,
}

impl LineEnding {
    pub fn detect(bytes: &[u8]) -> Self {
        if !bytes.contains(&b'\n') {
            return Self::None;
        }
        let mut crlf = 0usize;
        let mut lf = 0usize;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\n' {
                if index > 0 && bytes[index - 1] == b'\r' {
                    crlf += 1;
                } else {
                    lf += 1;
                }
            }
        }
        match (crlf, lf) {
            (0, _) => Self::Lf,
            (_, 0) => Self::Crlf,
            _ => Self::Mixed,
        }
    }

    pub fn normalize(self, content: &str) -> String {
        match self {
            Self::Crlf => content.replace("\r\n", "\n").replace('\n', "\r\n"),
            Self::Lf | Self::Mixed | Self::None => content.replace("\r\n", "\n"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub content: String,
    pub bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub path: String,
    pub base: Option<ConflictSide>,
    pub ours: Option<ConflictSide>,
    pub theirs: Option<ConflictSide>,
    /// Working file content when it is valid UTF-8 text.
    pub working: Option<ConflictSide>,
    pub binary: bool,
    pub too_large: bool,
    pub eol: LineEnding,
    /// True when the working file still contains conflict markers.
    pub has_markers: bool,
    pub marker_lines: Vec<u32>,
    pub resolved: bool,
}

fn validate(path: &str) -> Result<(), AppError> {
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

fn resolve_inside(worktree: &Path, path: &str) -> Result<PathBuf, AppError> {
    validate(path)?;
    let root = worktree
        .canonicalize()
        .map_err(|error| AppError::internal(format!("worktree introuvable : {error}")))?;
    let candidate = root.join(path);
    let parent = candidate
        .parent()
        .ok_or_else(|| AppError::invalid_input("chemin sans parent".to_owned()))?;
    let parent = parent
        .canonicalize()
        .map_err(|_| AppError::invalid_input("le dossier du fichier est introuvable".to_owned()))?;
    if !parent.starts_with(&root) {
        return Err(AppError::invalid_input(
            "le chemin sort du worktree".to_owned(),
        ));
    }
    Ok(parent.join(
        candidate
            .file_name()
            .ok_or_else(|| AppError::invalid_input("fichier manquant".to_owned()))?,
    ))
}

fn decode_side(bytes: &[u8]) -> Option<ConflictSide> {
    if bytes.len() > MAX_CONFLICT_BYTES || bytes.contains(&0) {
        return None;
    }
    let content = std::str::from_utf8(bytes).ok()?.to_owned();
    Some(ConflictSide {
        content,
        bytes: bytes.len(),
        truncated: false,
    })
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

/// Marker lines, counted for the UI. Only column-zero markers count.
pub fn marker_lines(content: &str) -> Vec<u32> {
    let mut markers = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if line.starts_with("<<<<<<< ")
            || line.starts_with("||||||| ")
            || line.starts_with(">>>>>>> ")
            || line == "======="
            || line.starts_with("=======\r")
        {
            markers.push((index + 1) as u32);
        }
    }
    markers
}

/// Read base/ours/theirs and the working file for one conflicted path.
pub fn read(runner: &GitRunner, worktree: &Path, path: &str) -> Result<ConflictView, AppError> {
    validate(path)?;
    let stages = crate::history::conflict_stages(runner, worktree, path)?;
    let mut too_large = false;
    let mut binary = false;
    for bytes in [&stages.base, &stages.ours, &stages.theirs]
        .into_iter()
        .flatten()
    {
        if bytes.len() > MAX_CONFLICT_BYTES {
            too_large = true;
        }
        if is_binary(bytes) {
            binary = true;
        }
    }
    let working_bytes = resolve_inside(worktree, path)
        .ok()
        .and_then(|target| std::fs::read(target).ok());
    let eol = working_bytes
        .as_deref()
        .map(LineEnding::detect)
        .unwrap_or(LineEnding::Lf);
    if let Some(bytes) = working_bytes.as_deref() {
        if bytes.len() > MAX_CONFLICT_BYTES {
            too_large = true;
        }
        if is_binary(bytes) {
            binary = true;
        }
    }
    let working = working_bytes.as_deref().and_then(decode_side);
    let markers = working
        .as_ref()
        .map(|side| marker_lines(&side.content))
        .unwrap_or_default();
    Ok(ConflictView {
        path: path.to_owned(),
        base: stages.base.as_deref().and_then(decode_side),
        ours: stages.ours.as_deref().and_then(decode_side),
        theirs: stages.theirs.as_deref().and_then(decode_side),
        working,
        binary,
        too_large,
        eol,
        has_markers: !markers.is_empty(),
        marker_lines: markers,
        resolved: false,
    })
}

/// Write a resolution atomically, preserving the observed line endings, then
/// optionally stage it to mark the conflict resolved.
///
/// Refuses content that still contains conflict markers unless the caller
/// explicitly opted into editing raw markers.
pub fn save(
    runner: &GitRunner,
    worktree: &Path,
    path: &str,
    content: &str,
    allow_markers: bool,
    mark_resolved: bool,
) -> Result<ConflictView, AppError> {
    if content.len() > MAX_CONFLICT_BYTES {
        return Err(AppError::new(
            "conflict.too_large",
            ErrorCategory::Input,
            "La résolution dépasse la limite de 8 Mio.",
        ));
    }
    if content.contains('\0') {
        return Err(AppError::invalid_input(
            "La résolution ne peut pas contenir d'octet NUL.".to_owned(),
        ));
    }
    let markers = marker_lines(content);
    if !markers.is_empty() && !allow_markers {
        return Err(AppError::new(
            "conflict.markers_remaining",
            ErrorCategory::Conflict,
            "La résolution contient encore des marqueurs de conflit.",
        )
        .with_detail(format!("lignes : {markers:?}")));
    }
    let target = resolve_inside(worktree, path)?;
    let existing = std::fs::read(&target).unwrap_or_default();
    let eol = LineEnding::detect(&existing);
    let normalized = eol.normalize(content);
    let parent = target
        .parent()
        .ok_or_else(|| AppError::internal("dossier de conflit introuvable"))?;
    let temporary = parent.join(format!(
        ".beebranch-resolve-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&temporary, normalized.as_bytes()).map_err(|error| {
        AppError::new(
            "conflict.write_failed",
            ErrorCategory::Permission,
            "La résolution n'a pas pu être écrite.",
        )
        .with_detail(error.to_string())
    })?;
    if let Err(error) = replace_file(&temporary, &target) {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::new(
            "conflict.write_failed",
            ErrorCategory::Permission,
            "La résolution n'a pas pu être écrite.",
        )
        .with_detail(error.to_string()));
    }
    if mark_resolved {
        crate::history::mark_resolved(runner, worktree, path)?;
    }
    read(runner, worktree, path)
}

/// Atomic replace on Unix. Windows cannot rename over an existing file, so
/// the fallback removes the target first; the temporary file is complete
/// before either step, and a failure is always reported.
fn replace_file(temporary: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(temporary, target) {
        Ok(()) => Ok(()),
        Err(_error) if cfg!(windows) && target.exists() => {
            std::fs::remove_file(target)?;
            std::fs::rename(temporary, target)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_line_endings_and_markers() {
        assert_eq!(LineEnding::detect(b"a\nb\n"), LineEnding::Lf);
        assert_eq!(LineEnding::detect(b"a\r\nb\r\n"), LineEnding::Crlf);
        assert_eq!(LineEnding::detect(b"a\r\nb\n"), LineEnding::Mixed);
        assert_eq!(LineEnding::detect(b"abc"), LineEnding::None);
        assert_eq!(
            marker_lines("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> other\n"),
            vec![2, 4, 6]
        );
        assert_eq!(LineEnding::Crlf.normalize("a\nb\r\n"), "a\r\nb\r\n");
        assert_eq!(LineEnding::Lf.normalize("a\r\nb"), "a\nb");
    }
}
