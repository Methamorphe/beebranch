//! Diff of a pull or merge request, computed from the provider's per-file
//! patches.
//!
//! GitHub and GitLab both return hunk text without the `diff --git` header, and
//! omit the patch entirely for binary or oversized files. The synthesis below
//! rebuilds the headers so the repository parser produces the exact same
//! [`DiffReport`] shape the local diff viewer already consumes — one renderer,
//! one set of limits, no parallel implementation.

use beebranch_core::AppError;
use beebranch_git::diff::{parse_diff, DiffLimits, DiffReport};
use serde::{Deserialize, Serialize};

/// One file as a provider reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchInput {
    pub old_path: String,
    pub new_path: String,
    /// `added`, `removed`, `modified`, `renamed`, … as the provider spells it.
    pub status: String,
    /// Hunk text only; `None` when the provider withholds it.
    pub patch: Option<String>,
}

/// Ceiling of provider file patches turned into one report.
const MAX_PROVIDER_FILES: usize = 300;

/// Rebuild one unified diff document from provider patches.
///
/// A file without a patch keeps its header and gets a `Binary files` marker:
/// the renderer then shows the file as changed without inventing hunks.
pub fn unified_diff(files: &[PatchInput]) -> String {
    let mut text = String::new();
    for file in files {
        let old = file.old_path.replace('\n', " ");
        let new = file.new_path.replace('\n', " ");
        text.push_str(&format!("diff --git a/{old} b/{new}\n"));
        match file.status.as_str() {
            "added" | "new" => text.push_str("new file mode 100644\n"),
            "removed" | "deleted" => text.push_str("deleted file mode 100644\n"),
            _ => {}
        }
        text.push_str(&format!("--- a/{old}\n+++ b/{new}\n"));
        match file.patch.as_deref().map(str::trim_end) {
            Some(patch) if !patch.is_empty() => {
                text.push_str(patch);
                text.push('\n');
            }
            _ => text.push_str(&format!("Binary files a/{old} and b/{new} differ\n")),
        }
    }
    text
}

/// Parse provider patches into the report the diff viewer renders.
pub fn report_from_patches(files: Vec<PatchInput>) -> Result<DiffReport, AppError> {
    let truncated = files.len() > MAX_PROVIDER_FILES;
    let mut kept = files;
    if truncated {
        kept.truncate(MAX_PROVIDER_FILES);
    }
    let text = unified_diff(&kept);
    let limits = DiffLimits {
        max_files: MAX_PROVIDER_FILES,
        ..DiffLimits::default()
    };
    let mut report = parse_diff(&text, limits).map_err(|error| {
        AppError::internal(format!("diff du fournisseur illisible : {error}"))
    })?;
    report.truncated |= truncated;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(old: &str, new: &str, status: &str, patch: Option<&str>) -> PatchInput {
        PatchInput {
            old_path: old.to_owned(),
            new_path: new.to_owned(),
            status: status.to_owned(),
            patch: patch.map(str::to_owned),
        }
    }

    #[test]
    fn rebuilds_hunks_that_land_on_the_reported_lines() {
        let report = report_from_patches(vec![file(
            "src/a.rs",
            "src/a.rs",
            "modified",
            Some("@@ -1,2 +1,3 @@\n one\n+two\n three"),
        )])
        .expect("report");

        assert_eq!(report.files.len(), 1);
        let file = &report.files[0];
        assert_eq!(file.old_path, "src/a.rs");
        assert_eq!(file.new_path, "src/a.rs");
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].new_start, 1);
        let added = file.hunks[0]
            .lines
            .iter()
            .find(|line| line.kind == beebranch_git::diff::DiffLineKind::Added)
            .expect("added line");
        // The line number is what a comment will be anchored to.
        assert_eq!(added.new_lineno, Some(2));
    }

    #[test]
    fn keeps_files_without_a_patch_visible() {
        let report = report_from_patches(vec![file("logo.png", "logo.png", "modified", None)])
            .expect("report");
        assert_eq!(report.files.len(), 1);
        assert!(report.files[0].binary);
        assert!(report.files[0].hunks.is_empty());
    }

    #[test]
    fn marks_renames_and_additions() {
        let report = report_from_patches(vec![
            file("old.rs", "new.rs", "renamed", Some("@@ -1 +1 @@\n-a\n+b")),
            file("new_file.rs", "new_file.rs", "added", Some("@@ -0,0 +1 @@\n+hello")),
            file("gone.rs", "gone.rs", "removed", Some("@@ -1 +0,0 @@\n-bye")),
        ])
        .expect("report");

        assert_eq!(report.files[0].old_path, "old.rs");
        assert_eq!(report.files[0].new_path, "new.rs");
        assert_eq!(report.files[2].kind, beebranch_git::diff::FileChangeKind::Deleted);
    }

    #[test]
    fn reports_truncation_past_the_file_ceiling() {
        let files = (0..MAX_PROVIDER_FILES + 5)
            .map(|index| file(&format!("f{index}.txt"), &format!("f{index}.txt"), "modified", None))
            .collect::<Vec<_>>();
        let report = report_from_patches(files).expect("report");
        assert!(report.truncated);
        assert_eq!(report.files.len(), MAX_PROVIDER_FILES);
    }
}
