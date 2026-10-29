use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::cache::MemoryResponseCache;
use crate::models::GitlabPosition;
use wiremock::matchers::body_json;

const TOKEN: &str = "glpat-super-secret-token";

fn client(server: &MockServer) -> GitlabClient {
    GitlabClient::for_test(&server.uri(), TOKEN)
}

fn user_json() -> serde_json::Value {
    json!({
        "id": 7,
        "username": "octocat",
        "name": "Octo Cat",
        "avatar_url": "https://gitlab.example.com/uploads/avatar.png"
    })
}

fn project_json(id: u64, name: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "path_with_namespace": format!("team/{name}"),
        "web_url": format!("https://gitlab.example.com/team/{name}"),
        "ssh_url_to_repo": format!("git@gitlab.example.com:team/{name}.git"),
        "http_url_to_repo": format!("https://gitlab.example.com/team/{name}.git"),
        "default_branch": "main",
        "last_activity_at": "2026-01-02T03:04:05.000Z",
        "description": null
    })
}

async fn mount_user(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(user_json()))
        .mount(server)
        .await;
}

#[tokio::test]
async fn validate_returns_the_authenticated_user() {
    let server = MockServer::start().await;
    mount_user(&server).await;

    let user = client(&server).validate().await.expect("valid token");

    assert_eq!(user.id, 7);
    assert_eq!(user.username, "octocat");
    assert_eq!(
        user.avatar_url.as_deref(),
        Some("https://gitlab.example.com/uploads/avatar.png")
    );
}

#[tokio::test]
async fn maps_401_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({"message": "401 Unauthorized"})),
        )
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("401");

    assert_eq!(error.code(), "auth.failed");
    assert_eq!(error.status(), Some(401));
    assert!(!error.retryable());
    assert!(error.message().contains("jeton"));

    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn maps_403_forbidden() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"message": "403 Forbidden"})))
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("403");

    assert_eq!(error.code(), "gitlab.forbidden");
    assert_eq!(error.status(), Some(403));
    assert!(!error.retryable());
}

#[tokio::test]
async fn maps_404_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/99"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"message": "404 Not Found"})))
        .mount(&server)
        .await;

    let error = client(&server).project(99).await.expect_err("404");

    assert_eq!(error.code(), "gitlab.not_found");
    assert_eq!(error.status(), Some(404));
}

#[tokio::test]
async fn rate_limit_honours_retry_after_and_stops_after_three_attempts() {
    let server = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::clone(&calls);

    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(move |_request: &Request| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(429)
                .insert_header("Retry-After", "0")
                .set_body_json(json!({"message": "429 Too Many Requests"}))
        })
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("429");

    assert_eq!(error.code(), "gitlab.rate_limited");
    assert_eq!(error.status(), Some(429));
    assert!(error.retryable());
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn retries_a_server_error_then_succeeds() {
    let server = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::clone(&calls);

    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(move |_request: &Request| {
            if handler_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(500).set_body_string("boom")
            } else {
                ResponseTemplate::new(200).set_body_json(user_json())
            }
        })
        .mount(&server)
        .await;

    let user = client(&server).validate().await.expect("retry succeeds");

    assert_eq!(user.username, "octocat");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revalidates_with_etag_and_replays_the_cached_body() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v4/projects"))
        .respond_with(move |request: &Request| {
            if request.headers.contains_key("if-none-match") {
                ResponseTemplate::new(304).insert_header("ETag", "\"projects-v1\"")
            } else {
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"projects-v1\"")
                    .set_body_json(json!([project_json(1, "bee")]))
            }
        })
        .mount(&server)
        .await;

    let cache = Arc::new(MemoryResponseCache::new());
    let client = client(&server).with_cache(cache);

    let first = client
        .projects(ProjectsQuery::new())
        .await
        .expect("first page");
    assert_eq!(first.items.len(), 1);
    assert!(!first.not_modified);
    assert!(!first.from_cache);

    let second = client
        .projects(ProjectsQuery::new())
        .await
        .expect("revalidated");
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].id, 1);
    assert!(second.not_modified);
    assert!(second.from_cache);

    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].headers.contains_key("if-none-match"));
    assert_eq!(
        requests[1]
            .headers
            .get("if-none-match")
            .and_then(|value| value.to_str().ok()),
        Some("\"projects-v1\"")
    );
}

#[tokio::test]
async fn paginates_until_next_page_is_empty() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v4/projects"))
        .and(query_param("page", "1"))
        .and(query_param("membership", "true"))
        .and(query_param("simple", "true"))
        .and(query_param("order_by", "last_activity_at"))
        .and(query_param("sort", "desc"))
        .and(query_param("per_page", "100"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("X-Next-Page", "2")
                .insert_header("X-Total", "3")
                .set_body_json(json!([project_json(1, "bee"), project_json(2, "hive")])),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/v4/projects"))
        .and(query_param("page", "2"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("X-Next-Page", "")
                .set_body_json(json!([project_json(3, "comb")])),
        )
        .mount(&server)
        .await;

    let page = client(&server)
        .projects(ProjectsQuery::new().with_search("bee"))
        .await
        .expect("two pages");

    assert_eq!(page.items.len(), 3);
    assert_eq!(page.page, 1);
    assert_eq!(page.per_page, 100);
    assert_eq!(page.next_page, None);
    assert_eq!(page.total, Some(3));
    assert!(!page.not_modified);
    assert!(!page.from_cache);

    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 2);
    let query = requests[0].url.query().expect("query");
    assert!(query.contains("search=bee"));
    assert!(query.contains("membership=true"));
    assert!(query.contains("per_page=100"));
}

#[tokio::test]
async fn respects_the_configured_page_cap() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v4/projects"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("X-Next-Page", "2")
                .set_body_json(json!([project_json(1, "bee"), project_json(2, "hive")])),
        )
        .mount(&server)
        .await;

    let page = client(&server)
        .with_max_pages(1)
        .projects(ProjectsQuery::new().with_per_page(2))
        .await
        .expect("capped page");

    assert_eq!(page.items.len(), 2);
    assert_eq!(page.next_page, Some(2));

    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn fetches_a_single_project() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/42"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(project_json(42, "bee")))
        .mount(&server)
        .await;

    let project = client(&server).project(42).await.expect("project");

    assert_eq!(project.id, 42);
    assert_eq!(project.path_with_namespace, "team/bee");
}

#[tokio::test]
async fn invalid_json_maps_to_invalid_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/user"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("invalid json");

    assert_eq!(error.code(), "gitlab.invalid_response");
    assert!(!error.retryable());
}

#[tokio::test]
async fn debug_output_never_contains_the_token() {
    let server = MockServer::start().await;
    mount_user(&server).await;

    let config = GitlabConfig {
        base_url: "https://gitlab.example.com".to_owned(),
        token: TOKEN.to_owned(),
        ca_bundle_pem: Some(b"-----BEGIN CERTIFICATE-----".to_vec()),
        timeout: Duration::from_secs(5),
    };
    assert!(!format!("{config:?}").contains(TOKEN));
    assert!(format!("{config:?}").contains("[REDACTED]"));

    let client = client(&server);
    assert!(!format!("{client:?}").contains(TOKEN));

    let error = GitlabError::from_status(401, &format!("token {TOKEN} rejected"));
    assert!(!format!("{error:?}").contains(TOKEN));
    assert!(!error.to_string().contains(TOKEN));
}

#[test]
fn backoff_is_deterministic_and_capped() {
    let client = GitlabClient::for_test("http://127.0.0.1:1", TOKEN);

    let first = client.backoff_delay(1, "key");
    let again = client.backoff_delay(1, "key");
    assert_eq!(first, again);
    assert!(first >= Duration::from_millis(500));
    assert!(first <= Duration::from_millis(625));

    assert_eq!(client.backoff_delay(9, "key"), Duration::from_millis(8_000));
}

#[test]
fn retry_after_is_parsed_and_capped() {
    let mut headers = HeaderMap::new();
    headers.insert(RETRY_AFTER, HeaderValue::from_static("3"));
    assert_eq!(retry_after_delay(&headers), Some(Duration::from_secs(3)));

    headers.insert(RETRY_AFTER, HeaderValue::from_static("999"));
    assert_eq!(retry_after_delay(&headers), Some(Duration::from_secs(8)));

    headers.insert(RETRY_AFTER, HeaderValue::from_static("not-a-date"));
    assert_eq!(retry_after_delay(&headers), None);
}

#[test]
fn new_rejects_an_empty_token() {
    let error = GitlabClient::new(GitlabConfig {
        base_url: "https://gitlab.example.com".to_owned(),
        token: "   ".to_owned(),
        ca_bundle_pem: None,
        timeout: Duration::from_secs(5),
    })
    .expect_err("empty token");

    assert_eq!(error.code(), "gitlab.configuration");
}

#[test]
fn new_rejects_an_unreadable_ca_bundle() {
    let empty = GitlabClient::new(GitlabConfig {
        base_url: "https://gitlab.example.com".to_owned(),
        token: TOKEN.to_owned(),
        ca_bundle_pem: Some(Vec::new()),
        timeout: Duration::from_secs(5),
    })
    .expect_err("empty CA bundle");
    assert_eq!(empty.code(), "tls.ca_invalid");

    let garbage = GitlabClient::new(GitlabConfig {
        base_url: "https://gitlab.example.com".to_owned(),
        token: TOKEN.to_owned(),
        ca_bundle_pem: Some(b"not a certificate".to_vec()),
        timeout: Duration::from_secs(5),
    })
    .expect_err("invalid CA bundle");
    assert_eq!(garbage.code(), "tls.ca_invalid");
}

fn merge_request_json(iid: u64, branch: &str) -> serde_json::Value {
    json!({
        "iid": iid,
        "title": "Add graph",
        "state": "opened",
        "draft": false,
        "source_branch": branch,
        "target_branch": "main",
        "author": {"id": 7, "username": "octocat", "name": "Octo Cat", "avatar_url": null},
        "assignees": [],
        "reviewers": [],
        "labels": ["frontend"],
        "detailed_merge_status": "mergeable",
        "has_conflicts": false,
        "sha": "abc123",
        "web_url": format!("https://gitlab.example.com/team/bee/-/merge_requests/{iid}"),
        "updated_at": "2026-10-27T10:00:00Z",
        "user_notes_count": 1,
        "head_pipeline": {
            "id": 42,
            "status": "success",
            "ref": branch,
            "sha": "abc123",
            "web_url": "https://gitlab.example.com/team/bee/-/pipelines/42"
        }
    })
}

#[tokio::test]
async fn lists_merge_requests_with_scope_and_pagination() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .and(query_param("state", "opened"))
        .and(query_param("scope", "reviews_for_me"))
        .and(query_param("page", "2"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-next-page", "")
                .insert_header("x-total", "1")
                .set_body_json(json!([merge_request_json(12, "feature/graph")])),
        )
        .mount(&server)
        .await;

    let page = client(&server)
        .merge_requests(
            MergeRequestsQuery::default()
                .project(7)
                .with_scope(MergeRequestScope::ReviewsForMe)
                .with_page(2),
        )
        .await
        .expect("list");

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].iid, 12);
    assert_eq!(
        page.items[0].head_pipeline.as_ref().unwrap().status,
        "success"
    );
    assert_eq!(page.next_page, None);
    assert_eq!(page.total, Some(1));
}

#[tokio::test]
async fn creates_a_draft_merge_request_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/merge_requests"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .and(wiremock::matchers::body_partial_json(json!({
            "source_branch": "feature/graph",
            "target_branch": "main",
            "title": "Draft: Add graph",
            "remove_source_branch": true
        })))
        .respond_with(
            ResponseTemplate::new(201).set_body_json(merge_request_json(13, "feature/graph")),
        )
        .expect(1)
        .mount(&server)
        .await;

    let created = client(&server)
        .create_merge_request(&CreateMergeRequest {
            project_id: 7,
            source_branch: "feature/graph".into(),
            target_branch: "main".into(),
            title: "Add graph".into(),
            description: "Body".into(),
            draft: true,
            remove_source_branch: true,
            squash: false,
            allow_collaboration: false,
            reviewer_ids: Vec::new(),
            assignee_ids: Vec::new(),
            labels: Vec::new(),
        })
        .await
        .expect("create");

    assert_eq!(created.iid, 13);
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    assert!(!String::from_utf8_lossy(&requests[0].body).contains("draft"));
}

#[tokio::test]
async fn maps_validation_errors_on_creation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/merge_requests"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "message": {"source_branch": ["does not exist"]}
        })))
        .mount(&server)
        .await;

    let error = client(&server)
        .create_merge_request(&CreateMergeRequest {
            project_id: 7,
            source_branch: "missing".into(),
            target_branch: "main".into(),
            title: "Title".into(),
            description: String::new(),
            draft: false,
            remove_source_branch: false,
            squash: false,
            allow_collaboration: false,
            reviewer_ids: Vec::new(),
            assignee_ids: Vec::new(),
            labels: Vec::new(),
        })
        .await
        .expect_err("422");

    assert_eq!(error.code(), "gitlab.validation");
    assert_eq!(error.status(), Some(422));
}

#[tokio::test]
async fn lists_merge_request_pipelines() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/12/pipelines"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": 42, "status": "running", "ref": "feature/graph", "sha": "abc", "web_url": null},
            {"id": 43, "status": "future-status", "sha": null, "web_url": null}
        ])))
        .mount(&server)
        .await;

    let pipelines = client(&server)
        .merge_request_pipelines(7, 12)
        .await
        .expect("pipelines");
    assert_eq!(pipelines.len(), 2);
    assert_eq!(pipelines[1].status, "future-status");
}

fn position() -> GitlabPosition {
    GitlabPosition {
        base_sha: "a".repeat(40),
        start_sha: "b".repeat(40),
        head_sha: "c".repeat(40),
        position_type: "text".to_owned(),
        new_path: Some("src/lib.rs".into()),
        old_path: Some("src/lib.rs".into()),
        new_line: Some(12),
        old_line: None,
    }
}

fn discussion_json() -> serde_json::Value {
    json!({
        "id": "disc-1",
        "individual_note": false,
        "notes": [{
            "id": 5,
            "body": "Please rename this",
            "author": {"id": 7, "username": "octocat", "name": "Octo Cat", "avatar_url": null},
            "created_at": "2026-10-27T10:00:00Z",
            "system": false,
            "resolvable": true,
            "resolved": false,
            "position": {
                "base_sha": "a".repeat(40),
                "start_sha": "b".repeat(40),
                "head_sha": "c".repeat(40),
                "position_type": "text",
                "new_path": "src/lib.rs",
                "old_path": "src/lib.rs",
                "new_line": 12,
                "old_line": null
            }
        }]
    })
}

#[tokio::test]
async fn lists_discussions_with_positions() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/9/discussions"))
        .and(query_param("per_page", "50"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([discussion_json()])))
        .mount(&server)
        .await;

    let page = client(&server)
        .merge_request_discussions(7, 9, 1, 50)
        .await
        .expect("discussions");

    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0].notes[0].position.as_ref().unwrap().new_line,
        Some(12)
    );
    assert!(page.items[0].notes[0].resolvable);
}

#[tokio::test]
async fn creates_an_inline_discussion_with_snake_case_position() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/merge_requests/9/discussions"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .and(body_json(json!({
            "body": "Inline",
            "position": {
                "base_sha": "a".repeat(40),
                "start_sha": "b".repeat(40),
                "head_sha": "c".repeat(40),
                "position_type": "text",
                "new_path": "src/lib.rs",
                "old_path": "src/lib.rs",
                "new_line": 12
            }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(discussion_json()))
        .mount(&server)
        .await;

    let created = client(&server)
        .create_discussion(7, 9, "Inline", Some(&position()))
        .await
        .expect("create discussion");
    assert_eq!(created.id, "disc-1");
}

#[tokio::test]
async fn resolving_a_discussion_uses_put() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/v4/projects/7/merge_requests/9/discussions/disc-1",
        ))
        .and(body_json(json!({"resolved": true})))
        .respond_with(ResponseTemplate::new(200).set_body_json(discussion_json()))
        .mount(&server)
        .await;

    client(&server)
        .set_discussion_resolved(7, 9, "disc-1", true)
        .await
        .expect("resolve");
}

#[tokio::test]
async fn approvals_404_exposes_the_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/9/approvals"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"message": "404 Not Found"})))
        .mount(&server)
        .await;

    let error = client(&server)
        .approvals(7, 9)
        .await
        .expect_err("unavailable");
    assert_eq!(error.status(), Some(404));
}

#[tokio::test]
async fn merge_conflict_is_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/9/merge"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({"message": "SHA mismatch"})))
        .mount(&server)
        .await;

    let input = MergeRequestMerge {
        sha: Some("d".repeat(40)),
        merge_method: Some("merge".into()),
        squash: false,
        should_remove_source_branch: false,
        sha_must_match: true,
        merge_when_pipeline_succeeds: false,
    };
    let error = client(&server)
        .merge_merge_request(7, 9, &input)
        .await
        .expect_err("conflict");
    assert_eq!(error.status(), Some(409));
    assert!(!error.retryable());
}

#[tokio::test]
async fn job_logs_are_truncated_at_the_cap() {
    let server = MockServer::start().await;
    let body = "x".repeat(20_000);
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/jobs/9/trace"))
        .and(header("PRIVATE-TOKEN", TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let log = client(&server)
        .job_log(7, 9, 5_000, 0)
        .await
        .expect("job log");
    assert!(log.truncated);
    assert_eq!(log.bytes, 5_000);
    assert_eq!(log.text.len(), 5_000);
}

#[tokio::test]
async fn pipeline_jobs_are_paged() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/pipelines/3/jobs"))
        .and(query_param("per_page", "10"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "id": 9,
            "name": "build",
            "stage": "build",
            "status": "success",
            "web_url": "https://gitlab.example.com/jobs/9",
            "duration": 1.5,
            "created_at": "2026-10-27T10:00:00Z",
            "finished_at": "2026-10-27T10:00:02Z"
        }])))
        .mount(&server)
        .await;

    let page = client(&server)
        .pipeline_jobs(7, 3, 1, 10)
        .await
        .expect("jobs");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].name, "build");
}

#[tokio::test]
async fn reads_diff_refs_from_the_changes_endpoint() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/9/changes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "diff_refs": {
                "base_sha": "a".repeat(40),
                "start_sha": "b".repeat(40),
                "head_sha": "c".repeat(40)
            },
            "changes": []
        })))
        .mount(&server)
        .await;

    let refs = client(&server)
        .merge_request_diff_refs(7, 9)
        .await
        .expect("diff refs");
    assert_eq!(refs.head_sha, "c".repeat(40));
}

#[tokio::test]
async fn job_log_offset_pages_without_range_support() {
    let server = MockServer::start().await;
    let body = "ab".repeat(10_000);
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/jobs/9/trace"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let log = client(&server)
        .job_log(7, 9, 5_000, 5_000)
        .await
        .expect("job log page");
    assert_eq!(log.bytes, 5_000);
    assert_eq!(log.offset, 5_000);
    assert_eq!(log.next_offset, Some(10_000));
    assert!(log.truncated);
}

#[tokio::test]
async fn merge_sends_auto_merge_and_shas() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/9/merge"))
        .and(body_json(json!({
            "squash": true,
            "should_remove_source_branch": false,
            "merge_when_pipeline_succeeds": true,
            "sha": "d".repeat(40),
            "sha_must_match": true,
            "merge_method": "rebase_merge"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "iid": 9,
            "title": "Merged",
            "state": "merged",
            "source_branch": "feature",
            "target_branch": "main",
            "author": {"id": 1, "username": "alice", "name": "Alice", "avatar_url": null},
            "web_url": "https://gitlab.example.com/mr/9"
        })))
        .mount(&server)
        .await;

    let input = MergeRequestMerge {
        sha: Some("d".repeat(40)),
        merge_method: Some("rebase_merge".into()),
        squash: true,
        should_remove_source_branch: false,
        sha_must_match: true,
        merge_when_pipeline_succeeds: true,
    };
    let merged = client(&server)
        .merge_merge_request(7, 9, &input)
        .await
        .expect("merge");
    assert_eq!(merged.state, "merged");
}

#[tokio::test]
async fn updates_the_title_and_description_of_a_merge_request() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .and(body_json(json!({"title": "Nouveau titre", "description": ""})))
        .respond_with(ResponseTemplate::new(200).set_body_json(merge_request_json(12, "feature")))
        .mount(&server)
        .await;

    let updated = client(&server)
        .update_merge_request(
            7,
            12,
            &MergeRequestUpdate {
                title: Some(" Nouveau titre ".to_owned()),
                description: Some(String::new()),
            },
        )
        .await
        .expect("update");

    assert_eq!(updated.iid, 12);
}

#[tokio::test]
async fn closes_a_merge_request_with_state_event() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .and(body_json(json!({"state_event": "close"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(merge_request_json(12, "feature")))
        .mount(&server)
        .await;

    client(&server)
        .set_merge_request_open(7, 12, false)
        .await
        .expect("close");
}

#[tokio::test]
async fn toggles_draft_through_the_title_prefix_without_doubling_it() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(merge_request_json(12, "feature")),
        )
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .and(body_json(json!({"title": "Draft: Add graph"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(merge_request_json(12, "feature")))
        .mount(&server)
        .await;

    client(&server)
        .set_merge_request_draft(7, 12, true)
        .await
        .expect("to draft");

    // Coming back keeps a single marker and restores the original wording.
    let mut drafted = merge_request_json(12, "feature");
    drafted["title"] = json!("draft: add graph");
    drafted["draft"] = json!(true);
    Mock::given(method("GET"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .respond_with(ResponseTemplate::new(200).set_body_json(drafted))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/v4/projects/7/merge_requests/12"))
        .and(body_json(json!({"title": "add graph"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(merge_request_json(12, "feature")))
        .mount(&server)
        .await;

    client(&server)
        .set_merge_request_draft(7, 12, false)
        .await
        .expect("ready");
}

#[tokio::test]
async fn resolves_a_username_to_its_gitlab_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v4/users"))
        .and(query_param("username", "octocat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([user_json()])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v4/users"))
        .and(query_param("username", "ghost"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;

    let client = client(&server);
    assert_eq!(client.user_id("octocat").await.expect("lookup"), Some(7));
    assert_eq!(client.user_id("ghost").await.expect("lookup"), None);
    assert_eq!(client.user_id("  ").await.expect("lookup"), None);
}

#[tokio::test]
async fn sends_reviewers_assignees_and_labels_on_creation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v4/projects/7/merge_requests"))
        .and(wiremock::matchers::body_partial_json(json!({
            "reviewer_ids": [7],
            "assignee_ids": [8],
            "labels": "frontend,backend"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(merge_request_json(13, "feature")))
        .mount(&server)
        .await;

    client(&server)
        .create_merge_request(&CreateMergeRequest {
            project_id: 7,
            source_branch: "feature".into(),
            target_branch: "main".into(),
            title: "Add graph".into(),
            description: String::new(),
            draft: false,
            remove_source_branch: false,
            squash: false,
            allow_collaboration: false,
            reviewer_ids: vec![7],
            assignee_ids: vec![8],
            labels: vec!["frontend".to_owned(), "backend".to_owned()],
        })
        .await
        .expect("create");
}
