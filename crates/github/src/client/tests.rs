use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use std::collections::HashMap;
use std::sync::Mutex;

use beebranch_core::{CachedResponse, ResponseCache};

use super::*;
use crate::models::GithubNote;

#[derive(Default)]
struct MemoryResponseCache {
    entries: Mutex<HashMap<String, CachedResponse>>,
}

impl MemoryResponseCache {
    fn new() -> Self {
        Self::default()
    }
}

impl ResponseCache for MemoryResponseCache {
    fn get(&self, key: &str) -> Option<CachedResponse> {
        self.entries.lock().ok()?.get(key).cloned()
    }

    fn put(&self, key: &str, entry: CachedResponse) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key.to_owned(), entry);
        }
    }

    fn remove_prefix(&self, prefix: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|key, _| !key.starts_with(prefix));
        }
    }
}

const TOKEN: &str = "ghp_super-secret-token";

fn client(server: &MockServer) -> GithubClient {
    GithubClient::for_test(&server.uri(), TOKEN)
}

fn user_json() -> serde_json::Value {
    json!({
        "id": 7,
        "login": "octocat",
        "name": "Octo Cat",
        "avatar_url": "https://avatars.example.com/octocat.png"
    })
}

fn repo_json(id: u64, name: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "full_name": format!("team/{name}"),
        "html_url": format!("https://github.example.test/team/{name}"),
        "ssh_url": format!("git@github.example.test:team/{name}.git"),
        "clone_url": format!("https://github.example.test/team/{name}.git"),
        "default_branch": "main",
        "pushed_at": "2026-01-02T03:04:05Z",
        "updated_at": "2026-01-03T03:04:05Z",
        "description": null
    })
}

fn pull_json(number: u64) -> serde_json::Value {
    json!({
        "number": number,
        "title": "Add graph",
        "state": "open",
        "draft": false,
        "merged_at": null,
        "head": {"ref": "feature/graph", "sha": "head-sha"},
        "base": {"ref": "main", "sha": "base-sha"},
        "user": user_json(),
        "assignees": [user_json()],
        "requested_reviewers": [user_json()],
        "labels": [{"name": "frontend"}],
        "mergeable": true,
        "mergeable_state": "clean",
        "html_url": format!("https://github.example.test/team/app/pull/{number}"),
        "updated_at": "2026-10-27T10:00:00Z",
        "comments": 2,
        "review_comments": 3
    })
}

fn repo_ref() -> RepoRef {
    RepoRef {
        id: 12,
        owner: "team".to_owned(),
        name: "app".to_owned(),
    }
}

async fn mount_user(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("Authorization", format!("Bearer {TOKEN}")))
        .and(header("X-GitHub-Api-Version", "2022-11-28"))
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
    assert_eq!(user.name, "Octo Cat");
}

#[tokio::test]
async fn maps_401_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({"message": "Bad credentials"})),
        )
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("401");

    assert_eq!(error.code(), "auth.failed");
    assert_eq!(error.status(), Some(401));
    assert!(!error.retryable());
    assert_eq!(server.received_requests().await.expect("recorded").len(), 1);
}

#[tokio::test]
async fn maps_403_rate_limit_exhaustion_to_a_retryable_error() {
    let server = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::clone(&calls);

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(move |_request: &Request| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .set_body_json(json!({"message": "API rate limit exceeded"}))
        })
        .mount(&server)
        .await;

    let error = client(&server).validate().await.expect_err("403");

    assert_eq!(error.code(), "github.rate_limited");
    assert!(error.retryable());
    assert_eq!(calls.load(Ordering::SeqCst), MAX_ATTEMPTS);
}

#[tokio::test]
async fn lists_repositories_across_pages_and_keeps_the_link_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user/repos"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([repo_json(2, "two")])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/user/repos"))
        .and(query_param("page", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header(
                    "Link",
                    format!("<{}/user/repos?page=2>; rel=\"next\"", server.uri()),
                )
                .set_body_json(json!([repo_json(1, "one")])),
        )
        .mount(&server)
        .await;

    let page = client(&server)
        .repositories(RepositoriesQuery::new().with_per_page(1))
        .await
        .expect("repositories");

    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].path_with_namespace, "team/one");
    assert_eq!(page.next_page, None);
    assert_eq!(
        page.items[0].last_activity_at.as_deref(),
        Some("2026-01-02T03:04:05Z")
    );
}

#[tokio::test]
async fn searches_repositories_with_total_count() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search/repositories"))
        .and(query_param("q", "bee"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 1,
            "incomplete_results": false,
            "items": [repo_json(5, "bee")]
        })))
        .mount(&server)
        .await;

    let page = client(&server)
        .repositories(RepositoriesQuery::new().with_search("bee"))
        .await
        .expect("search");

    assert_eq!(page.total, Some(1));
    assert_eq!(page.items[0].name, "bee");
}

#[tokio::test]
async fn lists_project_pulls_with_branches_and_mergeability() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/pulls"))
        .and(query_param("state", "open"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([pull_json(12)])))
        .mount(&server)
        .await;

    let page = client(&server)
        .pull_requests(PullRequestsQuery::default().with_repo(repo_ref()))
        .await
        .expect("pulls");

    let pull = &page.items[0];
    assert_eq!(pull.project_id, Some(12));
    assert_eq!(pull.iid, 12);
    assert_eq!(pull.state, "opened");
    assert_eq!(pull.source_branch, "feature/graph");
    assert_eq!(pull.target_branch, "main");
    assert_eq!(pull.user_notes_count, 5);
    assert_eq!(pull.author.username, "octocat");
    assert_eq!(pull.labels, vec!["frontend".to_owned()]);
    assert!(!pull.has_conflicts);
}

#[tokio::test]
async fn searches_pulls_across_repositories() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search/issues"))
        .and(query_param("q", "is:pr is:open review-requested:@me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "number": 4,
                "title": "Fix",
                "state": "open",
                "draft": true,
                "user": user_json(),
                "assignees": [],
                "labels": [],
                "html_url": "https://github.example.test/team/app/pull/4",
                "updated_at": "2026-10-27T10:00:00Z",
                "comments": 1,
                "repository_url": "https://api.github.example.test/repos/team/app"
            }]
        })))
        .mount(&server)
        .await;

    let page = client(&server)
        .pull_requests(PullRequestsQuery::default().with_scope(PullRequestScope::ReviewsForMe))
        .await
        .expect("search pulls");

    assert_eq!(page.total, Some(1));
    assert_eq!(page.items[0].project_id, None);
    assert_eq!(page.items[0].repository_name.as_deref(), Some("team/app"));
    assert!(page.items[0].draft);
}

#[tokio::test]
async fn creates_a_pull_request_with_snake_case_wire_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/repos/team/app/pulls"))
        .and(body_json(json!({
            "title": "Add graph",
            "head": "feature/graph",
            "base": "main",
            "body": "Body",
            "draft": true,
            "maintainer_can_modify": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(pull_json(3)))
        .mount(&server)
        .await;

    let created = client(&server)
        .create_pull_request(
            &repo_ref(),
            &CreatePullRequest {
                title: "Add graph".to_owned(),
                head: "feature/graph".to_owned(),
                base: "main".to_owned(),
                body: "Body".to_owned(),
                draft: true,
                maintainer_can_modify: true,
            },
        )
        .await
        .expect("created");

    assert_eq!(created.iid, 3);
    assert_eq!(created.project_id, Some(12));
}

#[tokio::test]
async fn maps_check_runs_to_pipelines() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/commits/head-sha/check-runs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 2,
            "check_runs": [
                {
                    "id": 1,
                    "name": "ci",
                    "status": "completed",
                    "conclusion": "success",
                    "head_sha": "head-sha",
                    "html_url": "https://github.example.test/checks/1"
                },
                {
                    "id": 2,
                    "name": "lint",
                    "status": "in_progress",
                    "conclusion": null,
                    "head_sha": "head-sha",
                    "details_url": "https://github.example.test/checks/2"
                }
            ]
        })))
        .mount(&server)
        .await;

    let checks = client(&server)
        .check_runs(&repo_ref(), "head-sha")
        .await
        .expect("checks");

    assert_eq!(checks.len(), 2);
    assert_eq!(checks[0].status, "success");
    assert_eq!(checks[0].detailed_status.as_deref(), Some("ci"));
    assert_eq!(checks[1].status, "running");
    assert_eq!(
        checks[1].web_url.as_deref(),
        Some("https://github.example.test/checks/2")
    );
}

#[tokio::test]
async fn groups_review_comments_into_threads_and_keeps_issue_comments() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/issues/12/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "id": 50,
            "body": "General note",
            "user": user_json(),
            "created_at": "2026-10-27T09:00:00Z"
        }])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/pulls/12/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {
                "id": 10,
                "body": "inline root",
                "user": user_json(),
                "created_at": "2026-10-27T10:00:00Z",
                "path": "src/lib.rs",
                "line": 4,
                "side": "RIGHT",
                "commit_id": "head-sha"
            },
            {
                "id": 11,
                "body": "reply",
                "user": user_json(),
                "created_at": "2026-10-27T10:05:00Z",
                "in_reply_to_id": 10
            }
        ])))
        .mount(&server)
        .await;

    let page = client(&server)
        .discussions(&repo_ref(), 12, 1, 50)
        .await
        .expect("discussions");

    assert_eq!(page.items.len(), 2);
    let issue = page
        .items
        .iter()
        .find(|discussion| discussion.id == "issue_50")
        .expect("issue discussion");
    assert!(issue.individual_note);

    let thread = page
        .items
        .iter()
        .find(|discussion| discussion.id == "review_10")
        .expect("review thread");
    assert_eq!(thread.notes.len(), 2);
    assert!(!thread.individual_note);
    let position = thread.notes[0].position.as_ref().expect("position");
    assert_eq!(position.new_path.as_deref(), Some("src/lib.rs"));
    assert_eq!(position.new_line, Some(4));
    let replies: Vec<&GithubNote> = thread.notes.iter().collect();
    assert_eq!(replies[1].body, "reply");
}

#[tokio::test]
async fn creates_inline_review_comments() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/repos/team/app/pulls/12/comments"))
        .and(body_json(json!({
            "body": "nit",
            "commit_id": "head-sha",
            "path": "src/lib.rs",
            "line": 4,
            "side": "RIGHT"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": 77,
            "body": "nit",
            "user": user_json(),
            "created_at": "2026-10-27T11:00:00Z",
            "path": "src/lib.rs",
            "line": 4,
            "side": "RIGHT",
            "commit_id": "head-sha"
        })))
        .mount(&server)
        .await;

    let discussion = client(&server)
        .create_discussion(
            &repo_ref(),
            12,
            "nit",
            Some(&GithubPosition {
                base_sha: "base-sha".to_owned(),
                start_sha: "base-sha".to_owned(),
                head_sha: "head-sha".to_owned(),
                position_type: "text".to_owned(),
                new_path: Some("src/lib.rs".to_owned()),
                old_path: None,
                new_line: Some(4),
                old_line: None,
            }),
        )
        .await
        .expect("created");

    assert_eq!(discussion.id, "review_77");
    assert_eq!(
        discussion.notes[0]
            .position
            .as_ref()
            .and_then(|p| p.new_line),
        Some(4)
    );
}

#[tokio::test]
async fn aggregates_reviews_and_submits_approval() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/pulls/12/reviews"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": 1, "user": user_json(), "state": "COMMENTED", "submitted_at": "2026-10-27T09:00:00Z"},
            {"id": 2, "user": user_json(), "state": "APPROVED", "submitted_at": "2026-10-27T10:00:00Z"},
            {"id": 3, "user": user_json(), "state": "COMMENTED", "submitted_at": "2026-10-27T11:00:00Z"}
        ])))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/repos/team/app/pulls/12/reviews"))
        .and(body_json(json!({"event": "APPROVE"})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"id": 3, "state": "APPROVED"})),
        )
        .mount(&server)
        .await;

    let approvals = client(&server)
        .approve(&repo_ref(), 12)
        .await
        .expect("approve");

    assert_eq!(approvals.approved_by.len(), 1);
    assert_eq!(approvals.approved_by[0].user.username, "octocat");
}

#[tokio::test]
async fn merges_with_a_sha_guard_and_returns_the_refreshed_pull() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/repos/team/app/pulls/12/merge"))
        .and(body_json(
            json!({"merge_method": "squash", "sha": "head-sha"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "merged": true,
            "message": "Pull Request successfully merged"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/pulls/12"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull_json(12)))
        .mount(&server)
        .await;

    let merged = client(&server)
        .merge_pull_request(
            &repo_ref(),
            12,
            &PullRequestMerge {
                sha: Some("head-sha".to_owned()),
                merge_method: Some("merge".to_owned()),
                squash: true,
                should_remove_source_branch: false,
                sha_must_match: true,
                merge_when_pipeline_succeeds: false,
            },
        )
        .await
        .expect("merged");

    assert_eq!(merged.iid, 12);
}

#[tokio::test]
async fn maps_actions_jobs_and_streams_logs() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/actions/runs"))
        .and(query_param("head_sha", "head-sha"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_runs": [{"id": 900, "name": "CI"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/actions/runs/900/jobs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 1,
            "jobs": [{
                "id": 5,
                "name": "build",
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.example.test/jobs/5",
                "started_at": "2026-10-27T10:00:00Z",
                "completed_at": "2026-10-27T10:01:00Z"
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/team/app/actions/jobs/5/logs"))
        .respond_with(ResponseTemplate::new(200).set_body_string("line one\nline two\n"))
        .mount(&server)
        .await;

    let page = client(&server)
        .workflow_jobs(&repo_ref(), "head-sha", 1, 50)
        .await
        .expect("jobs");
    assert_eq!(page.run_id, Some(900));
    assert_eq!(page.items[0].status, "success");
    assert_eq!(page.items[0].stage, "CI");
    assert_eq!(page.items[0].duration, Some(60.0));

    let log = client(&server)
        .job_log(&repo_ref(), 5, 1024 * 1024, 0)
        .await
        .expect("log");
    assert!(log.text.contains("line two"));
    assert!(!log.truncated);
}

#[tokio::test]
async fn revalidates_with_etag_and_replays_the_cache_on_304() {
    let server = MockServer::start().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::clone(&calls);

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(move |request: &Request| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            let etag = request
                .headers
                .get("if-none-match")
                .and_then(|value| value.to_str().ok());
            if etag == Some("\"v1\"") {
                ResponseTemplate::new(304)
            } else {
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"v1\"")
                    .set_body_json(user_json())
            }
        })
        .mount(&server)
        .await;

    let client = client(&server).with_cache(Arc::new(MemoryResponseCache::new()));
    let first = client.validate().await.expect("first");
    let second = client.validate().await.expect("cached");

    assert_eq!(first, second);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn parses_the_next_page_from_a_link_header() {
    let mut headers = HeaderMap::new();
    headers.insert(
        LINK,
        HeaderValue::from_static(
            "<https://api.github.com/user/repos?page=2>; rel=\"next\", <https://api.github.com/user/repos?page=5>; rel=\"last\"",
        ),
    );
    assert_eq!(next_page_from_link(&headers), Some(2));
    assert_eq!(next_page_from_link(&HeaderMap::new()), None);
}
