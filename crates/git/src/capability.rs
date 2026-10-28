use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::process::{CommandSpec, GitRunner};
use crate::GitSubcommand;

/// Minimum supported Git version (Ubuntu 22.04 LTS baseline).
pub const MINIMUM_GIT_VERSION: GitVersion = GitVersion::new(2, 34, 0);

/// Parsed Git version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Parse the output of `git version`.
    ///
    /// Accepts suffixes such as `2.34.1.windows.1` and parenthesized vendor
    /// information.
    pub fn parse(output: &str) -> Option<Self> {
        let first_line = output.lines().next()?;
        let token = first_line
            .strip_prefix("git version ")?
            .split_whitespace()
            .next()?;
        let mut parts = token.split('.');

        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);

        Some(Self {
            major,
            minor,
            patch,
        })
    }

    pub fn is_supported(self) -> bool {
        self >= MINIMUM_GIT_VERSION
    }
}

impl fmt::Display for GitVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Feature detection derived from the Git version.
///
/// Optional features are disabled by capability, never by a hard-coded
/// assumption that every supported Git has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitFeatures {
    pub status_porcelain_v2: bool,
    pub switch_restore: bool,
    pub worktree_porcelain: bool,
    pub rebase_update_refs: bool,
}

impl GitFeatures {
    pub fn from_version(version: GitVersion) -> Self {
        Self {
            status_porcelain_v2: version >= GitVersion::new(2, 11, 0),
            switch_restore: version >= GitVersion::new(2, 23, 0),
            worktree_porcelain: version >= GitVersion::new(2, 7, 0),
            rebase_update_refs: version >= GitVersion::new(2, 38, 0),
        }
    }
}

/// `git-lfs` availability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LfsCapability {
    pub version: String,
}

/// Detected capabilities of the Git binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCapability {
    pub version: GitVersion,
    pub features: GitFeatures,
    pub lfs: Option<LfsCapability>,
}

/// Options for capability detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectOptions {
    /// Run `git lfs version` in addition to `git version`.
    pub detect_lfs: bool,
}

impl Default for DetectOptions {
    fn default() -> Self {
        Self { detect_lfs: true }
    }
}

impl GitCapability {
    /// Detect the Git version and optional capabilities.
    pub fn detect(runner: &GitRunner, cwd: impl AsRef<Path>) -> Result<Self, GitError> {
        Self::detect_with(runner, cwd, DetectOptions::default())
    }

    /// Detect capabilities with explicit options.
    pub fn detect_with(
        runner: &GitRunner,
        cwd: impl AsRef<Path>,
        options: DetectOptions,
    ) -> Result<Self, GitError> {
        let cwd = absolute_path(cwd.as_ref())?;

        let outcome = runner.run(&CommandSpec::new(GitSubcommand::Version, &cwd))?;
        let outcome = outcome.ensure_success()?;
        let text = outcome.stdout.text_lossy();
        let version =
            GitVersion::parse(&text).ok_or_else(|| GitError::version_unparsable(text.clone()))?;

        if !version.is_supported() {
            return Err(GitError::unsupported_version(&version.to_string()));
        }

        let lfs = if options.detect_lfs {
            detect_lfs(runner, &cwd)
        } else {
            None
        };

        Ok(Self {
            version,
            features: GitFeatures::from_version(version),
            lfs,
        })
    }
}

fn detect_lfs(runner: &GitRunner, cwd: &Path) -> Option<LfsCapability> {
    let spec = CommandSpec::new(GitSubcommand::Lfs, cwd).arg("version");
    let outcome = runner.run(&spec).ok()?;
    if !outcome.success() {
        return None;
    }

    let text = outcome.stdout.text_lossy();
    let token = text
        .split_whitespace()
        .find(|token| token.starts_with("git-lfs/"))?;

    Some(LfsCapability {
        version: token.trim_start_matches("git-lfs/").to_owned(),
    })
}

fn absolute_path(path: &Path) -> Result<PathBuf, GitError> {
    std::path::absolute(path).map_err(|error| GitError::io("résolution du chemin", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_version() {
        assert_eq!(
            GitVersion::parse("git version 2.56.0\n"),
            Some(GitVersion::new(2, 56, 0))
        );
    }

    #[test]
    fn parses_vendor_suffixes() {
        assert_eq!(
            GitVersion::parse("git version 2.39.5 (Apple Git-154)\n"),
            Some(GitVersion::new(2, 39, 5))
        );
        assert_eq!(
            GitVersion::parse("git version 2.34.1.windows.1"),
            Some(GitVersion::new(2, 34, 1))
        );
        assert_eq!(
            GitVersion::parse("git version 2.34"),
            Some(GitVersion::new(2, 34, 0))
        );
    }

    #[test]
    fn rejects_unparsable_output() {
        assert_eq!(GitVersion::parse("not git"), None);
        assert_eq!(GitVersion::parse("git version "), None);
        assert_eq!(GitVersion::parse("git version abc"), None);
    }

    #[test]
    fn enforces_the_supported_floor() {
        assert!(!GitVersion::new(2, 33, 9).is_supported());
        assert!(GitVersion::new(2, 34, 0).is_supported());
        assert!(GitVersion::new(2, 56, 0).is_supported());
    }

    #[test]
    fn derives_features_from_version() {
        let features = GitFeatures::from_version(GitVersion::new(2, 34, 0));
        assert!(features.status_porcelain_v2);
        assert!(features.switch_restore);
        assert!(features.worktree_porcelain);
        assert!(!features.rebase_update_refs);

        let recent = GitFeatures::from_version(GitVersion::new(2, 38, 0));
        assert!(recent.rebase_update_refs);
    }
}
