use std::time::Duration;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::{
    poll_access_token, refresh_access_token, request_device_code, PollOutcome, OAUTH_SCOPES,
};

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
        "/oauth/authorize_device",
        json!({
            "device_code": "device-secret-value",
            "user_code": "0A44L90H",
            "verification_uri": "https://gitlab.com/oauth/device",
            "verification_uri_complete": "https://gitlab.com/oauth/device?user_code=0A44L90H",
            "expires_in": 300,
            "interval": 5
        }),
    )
    .await;

    let code = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect("device code");
    assert_eq!(code.user_code, "0A44L90H");
    assert_eq!(
        code.verification_uri,
        "https://gitlab.com/oauth/device?user_code=0A44L90H"
    );
    assert_eq!(code.expires_in, 300);
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
        "/oauth/authorize_device",
        json!({
            "device_code": "device",
            "user_code": "CODE",
            "verification_uri": "https://gitlab.com/oauth/device",
            "expires_in": 300
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
        "/oauth/token",
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
        "/oauth/token",
        json!({ "error": "slow_down" }),
    )
    .await;
    let slow = poll_access_token(&slow_server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("slow down");
    assert!(matches!(slow, PollOutcome::SlowDown));
}

#[tokio::test]
async fn a_disabled_device_grant_is_explicit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/authorize_device"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "access_denied",
            "error_description": "The resource owner or authorization server denied the request."
        })))
        .mount(&server)
        .await;

    let failure = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect_err("disabled grant");
    assert_eq!(failure.code(), "gitlab.device_flow_disabled");
    assert!(failure.message().contains("Device authorization grant"));
}

#[tokio::test]
async fn a_400_authorization_pending_is_still_pending() {
    // RFC 8628 allows the token endpoint to answer 400 for a pending grant.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "authorization_pending"
        })))
        .mount(&server)
        .await;

    let outcome = poll_access_token(&server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("pending");
    assert!(matches!(outcome, PollOutcome::Pending));
}

#[tokio::test]
async fn an_authorized_token_is_returned_with_refresh_and_redacted() {
    let server = MockServer::start().await;
    mount(
        &server,
        "/oauth/token",
        json!({
            "access_token": "glpat-access-secret",
            "refresh_token": "refresh-secret",
            "token_type": "Bearer",
            "expires_in": 7200,
            "scope": "api read_user"
        }),
    )
    .await;

    let outcome = poll_access_token(&server.uri(), "client-id", "device", TIMEOUT)
        .await
        .expect("token");
    let PollOutcome::Authorized(tokens) = outcome else {
        panic!("unexpected outcome: {outcome:?}");
    };
    assert_eq!(tokens.access_token, "glpat-access-secret");
    assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-secret"));
    assert_eq!(tokens.expires_in, 7200);
    assert!(!format!("{tokens:?}").contains("secret"));
}

#[tokio::test]
async fn refresh_returns_the_rotated_pair() {
    let server = MockServer::start().await;
    mount(
        &server,
        "/oauth/token",
        json!({
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 7200
        }),
    )
    .await;

    let tokens = refresh_access_token(&server.uri(), "client-id", "old-refresh", TIMEOUT)
        .await
        .expect("refresh");
    assert_eq!(tokens.access_token, "new-access");
    assert_eq!(tokens.refresh_token.as_deref(), Some("new-refresh"));
}

#[tokio::test]
async fn terminal_errors_map_to_stable_codes() {
    for (error, code) in [
        ("expired_token", "gitlab.device_flow_expired"),
        ("access_denied", "gitlab.device_flow_denied"),
        ("invalid_client", "gitlab.oauth_configuration"),
    ] {
        let server = MockServer::start().await;
        mount(&server, "/oauth/token", json!({ "error": error })).await;

        let failure = poll_access_token(&server.uri(), "client-id", "device", TIMEOUT)
            .await
            .expect_err(error);
        assert_eq!(failure.code(), code, "{error}");
    }
}

#[tokio::test]
async fn a_failed_refresh_is_explicit() {
    let server = MockServer::start().await;
    mount(&server, "/oauth/token", json!({ "error": "invalid_grant" })).await;

    let failure = refresh_access_token(&server.uri(), "client-id", "stale", TIMEOUT)
        .await
        .expect_err("refresh");
    assert_eq!(failure.code(), "gitlab.oauth_refresh_failed");
}

#[tokio::test]
async fn a_non_success_status_is_reported() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth/authorize_device"))
        .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
        .mount(&server)
        .await;

    let failure = request_device_code(&server.uri(), "client-id", OAUTH_SCOPES, TIMEOUT)
        .await
        .expect_err("404");
    assert_eq!(failure.status(), Some(404));
}
