use std::time::Duration;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::{poll_access_token, request_device_code, PollOutcome, OAUTH_SCOPES};

const TIMEOUT: Duration = Duration::from_secs(5);

async fn mount(server: &MockServer, route: &str, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

#[tokio::test]
async fn requests_and_parses_a_device_code() {
    let server = MockServer::start().await;
    mount(
        &server,
        "/login/device/code",
        json!({
            "device_code": "device-secret-value",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }),
    )
    .await;

    let code = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect("device code");
    assert_eq!(code.user_code, "ABCD-1234");
    assert_eq!(code.verification_uri, "https://github.com/login/device");
    assert_eq!(code.expires_in, 900);
    assert_eq!(code.interval, 5);
    assert!(
        !format!("{code:?}").contains("device-secret-value"),
        "the device code must never be debug-printed"
    );
}

#[tokio::test]
async fn a_missing_interval_falls_back_to_five_seconds() {
    let server = MockServer::start().await;
    mount(
        &server,
        "/login/device/code",
        json!({
            "device_code": "device",
            "user_code": "CODE",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900
        }),
    )
    .await;

    let code = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect("device code");
    assert_eq!(code.interval, 5);
}

#[tokio::test]
async fn pending_and_slow_down_are_not_errors() {
    let pending_server = MockServer::start().await;
    mount(
        &pending_server,
        "/login/oauth/access_token",
        json!({ "error": "authorization_pending" }),
    )
    .await;
    let pending = poll_access_token(&pending_server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("pending");
    assert!(matches!(pending, PollOutcome::Pending));

    let slow_server = MockServer::start().await;
    mount(
        &slow_server,
        "/login/oauth/access_token",
        json!({ "error": "slow_down" }),
    )
    .await;
    let slow = poll_access_token(&slow_server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("slow down");
    assert!(matches!(slow, PollOutcome::SlowDown));
}

#[tokio::test]
async fn an_authorized_token_is_returned_and_redacted() {
    let server = MockServer::start().await;
    mount(
        &server,
        "/login/oauth/access_token",
        json!({
            "access_token": "gho_secret_token",
            "token_type": "bearer",
            "scope": "repo,read:user"
        }),
    )
    .await;

    let outcome = poll_access_token(&server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("token");
    match outcome {
        PollOutcome::Authorized { token, scope } => {
            assert_eq!(token, "gho_secret_token");
            assert_eq!(scope.as_deref(), Some("repo,read:user"));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn terminal_errors_map_to_stable_codes() {
    for (error, code) in [
        ("expired_token", "github.device_flow_expired"),
        ("access_denied", "github.device_flow_denied"),
        ("device_flow_disabled", "github.device_flow_disabled"),
        ("incorrect_client_credentials", "github.oauth_configuration"),
    ] {
        let server = MockServer::start().await;
        mount(
            &server,
            "/login/oauth/access_token",
            json!({ "error": error }),
        )
        .await;

        let failure = poll_access_token(&server.uri(), "client-id", "device", TIMEOUT)
            .await
            .expect_err(error);
        assert_eq!(failure.code(), code, "{error}");
    }
}

#[tokio::test]
async fn a_non_success_status_is_reported() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login/device/code"))
        .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
        .mount(&server)
        .await;

    let failure = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect_err("404");
    assert_eq!(failure.status(), Some(404));
}
