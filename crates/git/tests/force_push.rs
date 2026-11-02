mod common;

use beebranch_git::sync::{self, PushRequest, SyncKind};
use beebranch_git::{CommandSpec, GitSubcommand, OperationContext};
use common::dirty_fixture;

#[test]
fn force_push_rewrites_history_but_refuses_a_changed_remote_lease() {
    let local = dirty_fixture();
    let remote = tempfile::tempdir().unwrap();
    local
        .runner()
        .run(&CommandSpec::new(GitSubcommand::Init, remote.path()).args(["--bare", "--quiet"]))
        .unwrap()
        .ensure_success()
        .unwrap();
    local.run(
        GitSubcommand::Remote,
        &["add", "origin", remote.path().to_str().unwrap()],
        &[],
    );
    let base = local.rev_parse(&["HEAD"]);
    local.run(GitSubcommand::Push, &["origin", "main"], &[]);
    local.commit("a.txt", "remote version\n", "remote change");
    local.run(GitSubcommand::Push, &["origin", "main"], &[]);
    let expected = sync::try_remote_branch_sha(local.runner(), local.path(), "origin", "main")
        .unwrap()
        .unwrap();
    local.run(GitSubcommand::Reset, &["--hard", &base], &[]);
    let rewritten = local.commit("a.txt", "rewritten\n", "rewrite history");
    let push = |sha: String| {
        let command = sync::spawn_push(
            local.runner(),
            local.path(),
            &PushRequest {
                remote: "origin".into(),
                branch: "main".into(),
                set_upstream: false,
                force_with_lease: Some(sha),
            },
            &OperationContext::default(),
            |_| {},
        )
        .unwrap();
        sync::finish(command, SyncKind::Push, || None)
    };
    push(expected.clone()).expect("force push succeeds with the observed lease");
    assert_eq!(
        sync::try_remote_branch_sha(local.runner(), local.path(), "origin", "main").unwrap(),
        Some(rewritten.clone())
    );
    local.commit("a.txt", "another rewrite\n", "another change");
    let error = push(expected).expect_err("a stale lease cannot overwrite the new remote tip");
    assert_eq!(error.code, "git.push_lease_stale");
    assert_eq!(
        sync::try_remote_branch_sha(local.runner(), local.path(), "origin", "main").unwrap(),
        Some(rewritten)
    );
    assert_eq!(
        sync::try_remote_branch_sha(local.runner(), local.path(), "origin", "missing").unwrap(),
        None
    );
}

#[cfg(unix)]
#[test]
fn force_push_preflight_preserves_ssh_authentication_errors() {
    let local = dirty_fixture();
    local.config(&[
        "core.sshCommand",
        "echo 'Permission denied (publickey).' >&2; exit 255",
    ]);
    let error = sync::try_remote_branch_sha(
        local.runner(),
        local.path(),
        "git@example.invalid:repo.git",
        "main",
    )
    .expect_err("an SSH failure must not look like an absent branch");
    assert_eq!(error.code, "auth.ssh_key");
    assert!(error
        .detail
        .as_deref()
        .unwrap()
        .contains("Permission denied (publickey)"));
}
