use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::error::GitError;

/// Location of the `git` executable.
///
/// The program is resolved once (PATH lookup or explicit override) and reused
/// for every command. A relative program path is never resolved against the
/// repository working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProgram {
    path: PathBuf,
}

impl GitProgram {
    /// Locate `git` on `PATH`.
    pub fn resolve() -> Result<Self, GitError> {
        let path = find_on_path(OsStr::new("git")).ok_or_else(|| {
            GitError::program_not_found("`git` est introuvable dans PATH".to_owned())
        })?;
        let path = absolute(path)?;
        Ok(Self { path })
    }

    /// Use an explicit program path (application setting or test helper).
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Resolve the configured path to an absolute executable path.
    pub(crate) fn resolve_path(&self) -> Result<PathBuf, GitError> {
        let path = if self.path.is_absolute() {
            self.path.clone()
        } else if self.path.components().count() <= 1 {
            let name = self.path.as_os_str();
            if name.is_empty() {
                return Err(GitError::program_not_found(
                    "chemin du programme vide".to_owned(),
                ));
            }
            find_on_path(name).ok_or_else(|| {
                GitError::program_not_found(format!(
                    "{} est introuvable dans PATH",
                    self.path.display()
                ))
            })?
        } else {
            std::env::current_dir()
                .map_err(|error| GitError::io("répertoire courant", error))?
                .join(&self.path)
        };

        let path = absolute(path)?;
        if !is_executable(&path) {
            return Err(GitError::program_not_found(format!(
                "{} n'est pas un exécutable",
                path.display()
            )));
        }
        Ok(path)
    }
}

fn absolute(path: PathBuf) -> Result<PathBuf, GitError> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()
        .map_err(|error| GitError::io("répertoire courant", error))?
        .join(path))
}

fn find_on_path(name: &OsStr) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }

        #[cfg(windows)]
        {
            if Path::new(name).extension().is_none() {
                let mut with_extension = candidate.into_os_string();
                with_extension.push(".exe");
                let with_extension = PathBuf::from(with_extension);
                if is_executable(&with_extension) {
                    return Some(with_extension);
                }
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_git_from_path() {
        let program = GitProgram::resolve().expect("git must be installed for tests");
        let resolved = program.resolve_path().expect("resolved path");
        assert!(resolved.is_absolute());
        assert!(is_executable(&resolved));
    }

    #[test]
    fn rejects_missing_program() {
        let program = GitProgram::from_path("/definitely/missing/git");
        let error = program.resolve_path().expect_err("must reject");
        assert_eq!(error.code(), crate::GitErrorCode::ProgramNotFound);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_executable_file() {
        let path =
            std::env::temp_dir().join(format!("beebranch-not-executable-{}", std::process::id()));
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write");
        let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o644);
        std::fs::set_permissions(&path, permissions).expect("chmod");

        let program = GitProgram::from_path(&path);
        let error = program.resolve_path().expect_err("must reject");
        assert_eq!(error.code(), crate::GitErrorCode::ProgramNotFound);
        let _ = std::fs::remove_file(path);
    }
}
