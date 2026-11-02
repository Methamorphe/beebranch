//! Native fallback for encrypted SSH keys when Git has no terminal.
//!
//! Only the helper code lives on disk. The answer goes directly from the
//! native dialog to SSH on stdout, never through application logs or files.
use std::path::PathBuf;

use crate::GitError;

const SCRIPT: &str = r#"#!/bin/sh
exec /usr/bin/osascript - "$@" <<'APPLESCRIPT' 2>/dev/null
on run argv
    set promptText to item 1 of argv
    activate
    if promptText contains "(yes/no" then
        set answer to display dialog promptText with title "BeeBranch — SSH" buttons {"No", "Yes"} default button "No" giving up after 120
        if gave up of answer then error number -128
        if button returned of answer is "Yes" then return "yes"
        return "no"
    end if
    set answer to display dialog promptText with title "BeeBranch — SSH" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel" giving up after 120
    if gave up of answer then error number -128
    return text returned of answer
end run
APPLESCRIPT
"#;

#[derive(Debug)]
pub(crate) struct SshAskpass {
    directory: tempfile::TempDir,
}

impl SshAskpass {
    pub(crate) fn new() -> Result<Self, GitError> {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            tempfile::tempdir().map_err(|error| GitError::io("création du helper SSH", error))?;
        let path = directory.path().join("ssh-askpass");
        std::fs::write(&path, SCRIPT)
            .and_then(|()| std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)))
            .map_err(|error| GitError::io("écriture du helper SSH", error))?;
        Ok(Self { directory })
    }

    pub(crate) fn path(&self) -> PathBuf {
        self.directory.path().join("ssh-askpass")
    }

    pub(crate) fn configure(&self, command: &mut std::process::Command) {
        // Inspect the final environment, including per-command overrides.
        // An explicitly configured helper or opt-out always wins.
        let has_helper = command.get_envs().any(|(name, value)| {
            name == "SSH_ASKPASS" && value.is_some_and(|value| !value.is_empty())
        });
        let has_policy = command.get_envs().any(|(name, value)| {
            name == "SSH_ASKPASS_REQUIRE" && value.is_some_and(|value| !value.is_empty())
        });
        if !has_helper {
            command.env("SSH_ASKPASS", self.path());
        }
        if !has_policy {
            // Desktop launches have neither a controlling TTY nor DISPLAY.
            command.env("SSH_ASKPASS_REQUIRE", "force");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::process::Command;

    #[test]
    fn configures_a_private_helper_without_replacing_user_settings() {
        use std::os::unix::fs::PermissionsExt;
        let helper = SshAskpass::new().expect("helper");
        let path = helper.path();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let mut command = Command::new("git");
        command.env_clear();
        helper.configure(&mut command);
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "SSH_ASKPASS" && value == Some(path.as_os_str())));
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "SSH_ASKPASS_REQUIRE"
                    && value == Some(OsStr::new("force")))
        );
        command.env("SSH_ASKPASS", "/custom/askpass");
        command.env("SSH_ASKPASS_REQUIRE", "never");
        helper.configure(&mut command);
        assert!(command.get_envs().any(
            |(key, value)| key == "SSH_ASKPASS" && value == Some(OsStr::new("/custom/askpass"))
        ));
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "SSH_ASKPASS_REQUIRE"
                    && value == Some(OsStr::new("never")))
        );
        drop(helper);
        assert!(!path.exists());
    }
}
