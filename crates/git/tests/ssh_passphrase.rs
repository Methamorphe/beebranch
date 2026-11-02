//! Exercise OpenSSH with a real encrypted key, without a network connection
//! or access to the user's keys/agent.
#![cfg(unix)]

use beebranch_git::{CommandSpec, GitRunner, GitSubcommand};
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

#[test]
fn encrypted_key_can_be_unlocked_during_a_git_network_command() {
    let directory = tempfile::tempdir().unwrap();
    let key = directory.path().join("encrypted-key");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "test-only-passphrase", "-f"])
        .arg(&key)
        .output()
        .expect("ssh-keygen");
    assert!(generated.status.success());

    let helper = directory.path().join("askpass");
    std::fs::write(&helper, "#!/bin/sh\nprintf '%s\\n' test-only-passphrase\n").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();

    // Git invokes a local SSH stand-in that uses OpenSSH's actual key reader.
    // Its deliberate failure avoids having to implement the Git wire protocol.
    let transport = directory.path().join("transport");
    std::fs::write(
        &transport,
        "#!/bin/sh\nssh-keygen -y -f \"$TEST_SSH_KEY\" >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&transport, std::fs::Permissions::from_mode(0o700)).unwrap();
    let spec = CommandSpec::new(GitSubcommand::LsRemote, directory.path())
        .arg("git@example.invalid:repo.git")
        .env("GIT_SSH_COMMAND", format!("'{}'", transport.display()))
        .env("GIT_SSH_VARIANT", "ssh")
        .env("TEST_SSH_KEY", key.as_os_str())
        .env("SSH_ASKPASS", helper.as_os_str())
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", "");
    let runner = GitRunner::detect().unwrap();
    let outcome = runner.run(&spec).unwrap();
    assert!(
        outcome.stderr.text_lossy().contains("ssh-ed25519 "),
        "encrypted key was not unlocked: {}",
        outcome.stderr.redacted()
    );

    // Rejecting/cancelling the dialog must fail authentication, with no
    // passphrase or private key in diagnostics.
    std::fs::write(&helper, "#!/bin/sh\nexit 1\n").unwrap();
    let refused = runner.run(&spec).unwrap();
    let diagnostic = refused.stderr.text_lossy();
    assert!(!diagnostic.contains("ssh-ed25519 "));
    assert!(!diagnostic.contains("test-only-passphrase"));
    assert!(!diagnostic.contains("BEGIN OPENSSH PRIVATE KEY"));
}

#[cfg(target_os = "macos")]
#[test]
fn repository_ssh_command_keeps_precedence_over_the_keychain_transport() {
    let directory = tempfile::tempdir().unwrap();
    let runner = GitRunner::detect().unwrap();
    runner
        .run(&CommandSpec::new(GitSubcommand::Init, directory.path()))
        .unwrap()
        .ensure_success()
        .unwrap();
    runner
        .run(
            &CommandSpec::new(GitSubcommand::Config, directory.path()).args([
                "--local",
                "core.sshCommand",
                "echo custom-ssh-transport >&2; exit 1",
            ]),
        )
        .unwrap()
        .ensure_success()
        .unwrap();
    let outcome = runner
        .run(
            &CommandSpec::new(GitSubcommand::LsRemote, directory.path())
                .arg("git@example.invalid:repo.git"),
        )
        .unwrap();
    assert!(outcome.stderr.text_lossy().contains("custom-ssh-transport"));
}
