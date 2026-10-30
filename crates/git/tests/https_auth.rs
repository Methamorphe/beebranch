mod common;

use beebranch_git::{clone::HttpsAuth, CommandSpec, GitSubcommand, StdinMode};
use common::Fixture;

#[test]
fn connected_forge_credentials_are_scoped_and_survive_runner_drop() {
    let fixture = Fixture::new();
    // Isolate this test from helpers configured on the developer's machine.
    fixture.config(&["credential.helper", ""]);
    let runner = fixture
        .runner()
        .with_https_credentials(&[(
            "forge.example.test:8443".to_owned(),
            HttpsAuth {
                username: "oauth2".to_owned(),
                token: "test-forge-secret".to_owned(),
            },
        )])
        .expect("credentials");
    let spec = |protocol: &str, host: &str| {
        CommandSpec::new(GitSubcommand::Credential, fixture.path())
            .arg("fill")
            .env("GIT_ASKPASS", "")
            .stdin(StdinMode::Bytes(
                format!("protocol={protocol}\nhost={host}\n\n").into_bytes(),
            ))
    };
    let cleared = runner
        .with_https_credentials(&[])
        .expect("clear credentials");
    assert!(!cleared
        .run(&spec("https", "forge.example.test:8443"))
        .expect("git")
        .success());
    for (protocol, host) in [
        ("https", "other.example.test"),
        ("http", "forge.example.test:8443"),
        ("https", "forge.example.test"),
        ("https", "forge.example.test:8443.attacker.test"),
    ] {
        let output = runner.run(&spec(protocol, host)).expect("git");
        assert!(!output.success());
        assert!(!output.stdout.text_lossy().contains("test-forge-secret"));
    }
    let child = runner
        .spawn(&spec("https", "forge.example.test:8443"), |_| {})
        .expect("spawn");
    drop(runner);
    let output = child.wait().expect("wait");
    assert!(output.success(), "{}", output.stderr.text_lossy());
    assert!(output
        .stdout
        .text_lossy()
        .contains("password=test-forge-secret"));
}

#[test]
fn native_git_helper_keeps_precedence() {
    let fixture = Fixture::new();
    fixture.config(&["credential.helper", ""]);
    fixture.config(&[
        "--add",
        "credential.helper",
        "!f() { printf 'username=native\npassword=native-secret\n'; }; f",
    ]);
    let runner = fixture
        .runner()
        .with_https_credentials(&[(
            "forge.example.test".to_owned(),
            HttpsAuth {
                username: "oauth2".to_owned(),
                token: "fallback-secret".to_owned(),
            },
        )])
        .expect("credentials");
    let credential =
        beebranch_git::credentials::fill(&runner, fixture.path(), "forge.example.test")
            .expect("fill")
            .expect("native credential");
    assert_eq!(credential.username, "native");
    assert_eq!(credential.password, "native-secret");
}
