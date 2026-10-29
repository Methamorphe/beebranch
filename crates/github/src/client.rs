//! GitHub REST v3 HTTP client.
//!
//! The client owns its `reqwest::Client`, configured with rustls, mandatory
//! certificate verification, an optional extra CA bundle and a hard timeout.
//! The personal access token travels exclusively in the `Authorization`
//! header: it is never placed in a URL, a log line or a `Debug` output.
//!
//! Idempotent requests retry up to three times on `429`, rate-limited `403`
//! and `5xx` with deterministic jittered backoff, honouring `Retry-After`.
//! Successful `GET` responses are cached and revalidated with `If-None-Match`.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use beebranch_core::{now_unix, redaction, CachedResponse, ResponseCache};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, ETAG, IF_NONE_MATCH, LINK, LOCATION, RETRY_AFTER,
};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use tokio::time::sleep;
use tracing::debug;

use crate::error::GithubError;
use crate::models::{
    GithubApprovals, GithubDiffRefs, GithubDiscussion, GithubJob, GithubNote, GithubPipeline,
    GithubPosition, GithubProject, GithubPullRequest, GithubUser, GithubUserRef, JobLog, Paged,
    PullRequestMerge,
};
use crate::pipeline::normalize_status;
use crate::url::{normalize_url, NormalizedUrl};

/// Number of pages fetched at most by a single [`GithubClient::repositories`] call.
pub const DEFAULT_MAX_PAGES: u32 = 20;
/// Upper bound accepted by [`GithubClient::with_max_pages`].
pub const MAX_PAGES_LIMIT: u32 = 100;
/// Default lifetime of a cached response before it is fetched again.
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// GitHub maximum page size.
pub const MAX_PER_PAGE: u32 = 100;

const MAX_ATTEMPTS: usize = 3;
const BASE_BACKOFF_MS: u64 = 500;
const MAX_BACKOFF_MS: u64 = 8_000;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const USER_AGENT: &str = concat!("BeeBranch/", env!("CARGO_PKG_VERSION"));
const API_VERSION: &str = "2022-11-28";

/// Configuration of a GitHub instance connection.
pub struct GithubConfig {
    /// Address entered by the user (https; `github.com` or an Enterprise host).
    pub base_url: String,
    /// Personal access token. Never logged or serialized.
    pub token: String,
    /// Optional PEM bundle of internal CAs added to the system trust store.
    pub ca_bundle_pem: Option<Vec<u8>>,
    /// Total request timeout.
    pub timeout: Duration,
}

impl fmt::Debug for GithubConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GithubConfig")
            .field("base_url", &redaction::redact(&self.base_url))
            .field("token", &"[REDACTED]")
            .field(
                "ca_bundle_pem",
                &self
                    .ca_bundle_pem
                    .as_ref()
                    .map(|pem| format!("{} octets", pem.len())),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Query for [`GithubClient::repositories`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepositoriesQuery {
    /// Optional search expression.
    pub search: Option<String>,
    /// First page to request (1-based).
    pub page: u32,
    /// Requested page size, clamped to `1..=MAX_PER_PAGE`.
    pub per_page: u32,
}

impl RepositoriesQuery {
    /// Query starting at the first page.
    pub fn new() -> Self {
        Self {
            search: None,
            page: 1,
            per_page: MAX_PER_PAGE,
        }
    }

    pub fn with_search(mut self, search: impl Into<String>) -> Self {
        self.search = Some(search.into());
        self
    }

    pub fn with_page(mut self, page: u32) -> Self {
        self.page = page.max(1);
        self
    }

    pub fn with_per_page(mut self, per_page: u32) -> Self {
        self.per_page = per_page.clamp(1, MAX_PER_PAGE);
        self
    }
}

/// Address of one repository for the API paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    /// Numeric repository identifier (used by the local store).
    pub id: u64,
    /// Owner login or organization.
    pub owner: String,
    /// Repository name.
    pub name: String,
}

impl RepoRef {
    /// Build a reference from an `owner/repo` string.
    pub fn from_full_name(id: u64, full_name: &str) -> Option<Self> {
        let (owner, name) = full_name.split_once('/')?;
        if owner.is_empty() || name.is_empty() || name.contains('/') {
            return None;
        }
        Some(Self {
            id,
            owner: owner.to_owned(),
            name: name.to_owned(),
        })
    }

    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// Pull request list scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestScope {
    CreatedByMe,
    AssignedToMe,
    ReviewsForMe,
    All,
}

impl PullRequestScope {
    /// Search qualifier appended to `is:pr is:open`, if any.
    fn qualifier(self) -> Option<&'static str> {
        match self {
            Self::CreatedByMe => Some("author:@me"),
            Self::AssignedToMe => Some("assignee:@me"),
            Self::ReviewsForMe => Some("review-requested:@me"),
            Self::All => None,
        }
    }
}

/// Pull request list request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestsQuery {
    /// Repository to list; `None` searches across accessible repositories.
    pub repo: Option<RepoRef>,
    pub scope: PullRequestScope,
    pub page: u32,
    pub per_page: u32,
}

impl Default for PullRequestsQuery {
    fn default() -> Self {
        Self {
            repo: None,
            scope: PullRequestScope::CreatedByMe,
            page: 1,
            per_page: 50,
        }
    }
}

impl PullRequestsQuery {
    pub fn with_repo(mut self, repo: RepoRef) -> Self {
        self.repo = Some(repo);
        self
    }

    pub fn with_scope(mut self, scope: PullRequestScope) -> Self {
        self.scope = scope;
        self
    }

    pub fn with_page(mut self, page: u32) -> Self {
        self.page = page.max(1);
        self
    }

    pub fn with_per_page(mut self, per_page: u32) -> Self {
        self.per_page = per_page.clamp(1, MAX_PER_PAGE);
        self
    }
}

/// Pull request creation payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePullRequest {
    pub title: String,
    /// Source branch (`owner:branch` for cross-repository pull requests).
    pub head: String,
    pub base: String,
    pub body: String,
    pub draft: bool,
    pub maintainer_can_modify: bool,
}

/// One page of Actions jobs.
#[derive(Debug, Clone, PartialEq)]
pub struct JobsPage {
    pub run_id: Option<u64>,
    pub items: Vec<GithubJob>,
    pub page: u32,
    pub per_page: u32,
    pub next_page: Option<u32>,
    pub total: Option<u64>,
    pub not_modified: bool,
    pub from_cache: bool,
}

/// GitHub REST v3 client.
#[derive(Clone)]
pub struct GithubClient {
    http: Client,
    url: NormalizedUrl,
    token: SecretToken,
    cache: Option<Arc<dyn ResponseCache>>,
    cache_ttl: Duration,
    max_pages: u32,
}

impl fmt::Debug for GithubClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GithubClient")
            .field("api_url", &self.url.api_url)
            .field("host", &self.url.host)
            .field("token", &"[REDACTED]")
            .field("cache", &self.cache.is_some())
            .field("cache_ttl", &self.cache_ttl)
            .field("max_pages", &self.max_pages)
            .finish()
    }
}

impl GithubClient {
    /// Build a client from an instance configuration.
    pub fn new(config: GithubConfig) -> Result<Self, GithubError> {
        let url = normalize_url(&config.base_url)?;
        let token = SecretToken::new(&config.token)?;
        let http = build_http_client(&config)?;

        Ok(Self {
            http,
            url,
            token,
            cache: None,
            cache_ttl: DEFAULT_CACHE_TTL,
            max_pages: DEFAULT_MAX_PAGES,
        })
    }

    /// Build a client against a plain-HTTP mock server.
    #[cfg(test)]
    fn for_test(base_url: &str, token: &str) -> Self {
        let url = NormalizedUrl {
            base_url: base_url.to_owned(),
            api_url: base_url.to_owned(),
            web_url: base_url.to_owned(),
            host: "127.0.0.1".to_owned(),
            path_prefix: String::new(),
        };
        let config = GithubConfig {
            base_url: base_url.to_owned(),
            token: token.to_owned(),
            ca_bundle_pem: None,
            timeout: Duration::from_secs(5),
        };

        Self {
            http: build_http_client(&config).expect("test HTTP client"),
            url,
            token: SecretToken::new(token).expect("test token"),
            cache: None,
            cache_ttl: DEFAULT_CACHE_TTL,
            max_pages: DEFAULT_MAX_PAGES,
        }
    }

    /// Attach a response cache used for conditional requests.
    pub fn with_cache(mut self, cache: Arc<dyn ResponseCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Change how long a cached response stays revalidatable.
    pub fn with_cache_ttl(mut self, ttl: Duration) -> Self {
        self.cache_ttl = ttl;
        self
    }

    /// Change the page cap applied to [`Self::repositories`].
    pub fn with_max_pages(mut self, max_pages: u32) -> Self {
        self.max_pages = max_pages.clamp(1, MAX_PAGES_LIMIT);
        self
    }

    /// Normalized web base.
    pub fn base_url(&self) -> &str {
        &self.url.base_url
    }

    /// Normalized REST base.
    pub fn api_url(&self) -> &str {
        &self.url.api_url
    }

    /// Instance host, including an explicit port.
    pub fn host(&self) -> &str {
        &self.url.host
    }

    /// Validate the token with `GET /user`.
    pub async fn validate(&self) -> Result<GithubUser, GithubError> {
        let url = self.endpoint(&["user"])?;
        let fetched = self.fetch(&url).await?;
        let user: WireUser = decode(&fetched.body)?;
        Ok(user.into_public())
    }

    /// List repositories accessible to the token.
    ///
    /// Pages are fetched until no `rel="next"` link remains, a page is empty,
    /// or the configured page cap is reached.
    pub async fn repositories(
        &self,
        query: RepositoriesQuery,
    ) -> Result<Paged<GithubProject>, GithubError> {
        let per_page = query.per_page.clamp(1, MAX_PER_PAGE);
        let start_page = query.page.max(1);
        let search = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let mut page = start_page;
        let mut items = Vec::new();
        let mut pages_fetched = 0u32;
        let mut all_not_modified = true;
        let mut all_from_cache = true;
        let mut total = None;
        let next_page;

        loop {
            if pages_fetched >= self.max_pages {
                next_page = Some(page);
                break;
            }

            let url = match search {
                Some(search) => self.search_repositories_url(page, per_page, search)?,
                None => self.repositories_url(page, per_page)?,
            };
            let fetched = self.fetch(&url).await?;
            pages_fetched += 1;
            all_not_modified &= fetched.not_modified;
            all_from_cache &= fetched.from_cache;

            let batch = match search {
                Some(_) => {
                    let result: WireSearchRepositories = decode(&fetched.body)?;
                    total = Some(result.total_count);
                    result
                        .items
                        .into_iter()
                        .map(WireRepo::into_public)
                        .collect::<Vec<_>>()
                }
                None => decode::<Vec<WireRepo>>(&fetched.body)?
                    .into_iter()
                    .map(WireRepo::into_public)
                    .collect::<Vec<_>>(),
            };

            if batch.is_empty() {
                next_page = None;
                break;
            }

            items.extend(batch);

            // GitHub always emits `Link: rel="next"` while more pages exist.
            // Absence of that link means the listing is complete.
            match fetched.next_page {
                Some(next) if next > page => page = next,
                _ => {
                    next_page = None;
                    break;
                }
            }
        }

        Ok(Paged {
            items,
            page: start_page,
            per_page,
            next_page,
            total,
            not_modified: pages_fetched > 0 && all_not_modified,
            from_cache: pages_fetched > 0 && all_from_cache,
        })
    }

    /// Fetch one repository by numeric identifier.
    pub async fn repository(&self, id: u64) -> Result<GithubProject, GithubError> {
        let id = id.to_string();
        let url = self.endpoint(&["repositories", &id])?;
        let fetched = self.fetch(&url).await?;
        let repo: WireRepo = decode(&fetched.body)?;
        Ok(repo.into_public())
    }

    /// Fetch one repository by `owner/name`.
    pub async fn repository_by_name(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<GithubProject, GithubError> {
        let url = self.endpoint(&["repos", owner, name])?;
        let fetched = self.fetch(&url).await?;
        let repo: WireRepo = decode(&fetched.body)?;
        Ok(repo.into_public())
    }

    /// List pull requests for one repository or across accessible repositories.
    pub async fn pull_requests(
        &self,
        query: PullRequestsQuery,
    ) -> Result<Paged<GithubPullRequest>, GithubError> {
        if query.page == 0 {
            return Err(GithubError::configuration("page invalide"));
        }
        let per_page = query.per_page.clamp(1, MAX_PER_PAGE);

        if let Some(repo) = query.repo.as_ref() {
            let mut url = self.repo_endpoint(repo, &["pulls"])?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("state", "open")
                    .append_pair("sort", "updated")
                    .append_pair("direction", "desc")
                    .append_pair("per_page", &per_page.to_string())
                    .append_pair("page", &query.page.to_string());
            }
            let fetched = self.fetch(&url).await?;
            let items: Vec<WirePull> = decode(&fetched.body)?;
            return Ok(Paged {
                items: items
                    .into_iter()
                    .map(|pull| pull.into_public(Some(repo.id)))
                    .collect(),
                page: query.page,
                per_page,
                next_page: fetched.next_page,
                total: fetched.total,
                not_modified: fetched.not_modified,
                from_cache: fetched.from_cache,
            });
        }

        let qualifier = query.scope.qualifier().ok_or_else(|| {
            GithubError::configuration(
                "La liste globale des pull requests exige un filtre (auteur, assignation ou relecture).",
            )
        })?;
        let mut url = self.endpoint(&["search", "issues"])?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("q", &format!("is:pr is:open {qualifier}"))
                .append_pair("sort", "updated")
                .append_pair("order", "desc")
                .append_pair("per_page", &per_page.to_string())
                .append_pair("page", &query.page.to_string());
        }
        let fetched = self.fetch(&url).await?;
        let result: WireSearchIssues = decode(&fetched.body)?;
        Ok(Paged {
            items: result
                .items
                .into_iter()
                .map(WireSearchIssue::into_public)
                .collect(),
            page: query.page,
            per_page,
            next_page: fetched.next_page,
            total: Some(result.total_count),
            not_modified: fetched.not_modified,
            from_cache: fetched.from_cache,
        })
    }

    /// Fetch one pull request.
    pub async fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<GithubPullRequest, GithubError> {
        let number = number.to_string();
        let url = self.repo_endpoint(repo, &["pulls", &number])?;
        let fetched = self.fetch(&url).await?;
        let pull: WirePull = decode(&fetched.body)?;
        Ok(pull.into_public(Some(repo.id)))
    }

    /// Check runs attached to a commit, exposed as CI pipelines.
    pub async fn check_runs(
        &self,
        repo: &RepoRef,
        head_sha: &str,
    ) -> Result<Vec<GithubPipeline>, GithubError> {
        let url = self.repo_endpoint(repo, &["commits", head_sha, "check-runs"])?;
        let mut url = url;
        url.query_pairs_mut()
            .append_pair("per_page", &MAX_PER_PAGE.to_string())
            .append_pair("filter", "latest");
        let fetched = self.fetch(&url).await?;
        let runs: WireCheckRuns = decode(&fetched.body)?;
        Ok(runs
            .check_runs
            .into_iter()
            .map(|run| GithubPipeline {
                id: run.id,
                status: normalize_status(&run.status, run.conclusion.as_deref()).to_owned(),
                detailed_status: Some(run.name),
                ref_name: None,
                sha: run.head_sha,
                web_url: run.html_url.or(run.details_url),
            })
            .collect())
    }

    /// Create a pull request. Mutations are never retried.
    pub async fn create_pull_request(
        &self,
        repo: &RepoRef,
        input: &CreatePullRequest,
    ) -> Result<GithubPullRequest, GithubError> {
        if input.head.trim().is_empty() || input.base.trim().is_empty() {
            return Err(GithubError::configuration(
                "les branches source et cible sont requises",
            ));
        }
        if input.title.trim().is_empty() {
            return Err(GithubError::configuration(
                "le titre de la pull request est requis",
            ));
        }
        let url = self.repo_endpoint(repo, &["pulls"])?;
        let payload = serde_json::json!({
            "title": input.title,
            "head": input.head,
            "base": input.base,
            "body": input.body,
            "draft": input.draft,
            "maintainer_can_modify": input.maintainer_can_modify,
        });
        let created: WirePull = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_pulls(repo);
        Ok(created.into_public(Some(repo.id)))
    }

    /// Issue comments and review threads of a pull request.
    pub async fn discussions(
        &self,
        repo: &RepoRef,
        number: u64,
        page: u32,
        per_page: u32,
    ) -> Result<Paged<GithubDiscussion>, GithubError> {
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let page = page.max(1);
        let number_text = number.to_string();

        let mut comments_url = self.repo_endpoint(repo, &["issues", &number_text, "comments"])?;
        comments_url
            .query_pairs_mut()
            .append_pair("per_page", &per_page.to_string())
            .append_pair("page", &page.to_string());
        let comments = self.fetch(&comments_url).await?;
        let issue_comments: Vec<WireIssueComment> = decode(&comments.body)?;

        let mut review_url = self.repo_endpoint(repo, &["pulls", &number_text, "comments"])?;
        review_url
            .query_pairs_mut()
            .append_pair("per_page", &per_page.to_string())
            .append_pair("page", &page.to_string());
        let reviews = self.fetch(&review_url).await?;
        let review_comments: Vec<WireReviewComment> = decode(&reviews.body)?;

        Ok(Paged {
            items: build_discussions(issue_comments, review_comments),
            page,
            per_page,
            next_page: reviews.next_page.or(comments.next_page),
            total: None,
            not_modified: comments.not_modified && reviews.not_modified,
            from_cache: comments.from_cache && reviews.from_cache,
        })
    }

    /// Create a discussion. `position` anchors an inline review comment.
    pub async fn create_discussion(
        &self,
        repo: &RepoRef,
        number: u64,
        body: &str,
        position: Option<&GithubPosition>,
    ) -> Result<GithubDiscussion, GithubError> {
        if body.trim().is_empty() {
            return Err(GithubError::configuration(
                "le commentaire ne peut pas être vide",
            ));
        }
        let number_text = number.to_string();
        if let Some(position) = position {
            let path = position
                .new_path
                .as_ref()
                .or(position.old_path.as_ref())
                .ok_or_else(|| GithubError::configuration("le chemin du commentaire est requis"))?;
            let new_side = position.new_line.is_some();
            let line = position
                .new_line
                .or(position.old_line)
                .ok_or_else(|| GithubError::configuration("la ligne du commentaire est requise"))?;
            let url = self.repo_endpoint(repo, &["pulls", &number_text, "comments"])?;
            let payload = serde_json::json!({
                "body": body,
                "commit_id": position.head_sha,
                "path": path,
                "line": line,
                "side": if new_side { "RIGHT" } else { "LEFT" },
            });
            let comment: WireReviewComment = self.send_json(Method::POST, &url, &payload).await?;
            self.invalidate_pull(repo, number);
            return Ok(GithubDiscussion {
                id: format!("review_{}", comment.id),
                individual_note: false,
                notes: vec![comment.into_note()],
            });
        }

        let url = self.repo_endpoint(repo, &["issues", &number_text, "comments"])?;
        let payload = serde_json::json!({ "body": body });
        let comment: WireIssueComment = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_pull(repo, number);
        let id = comment.id;
        Ok(GithubDiscussion {
            id: format!("issue_{id}"),
            individual_note: true,
            notes: vec![comment.into_note()],
        })
    }

    /// Reply to a discussion. Review threads use the dedicated replies
    /// endpoint; issue comments are flat and get a new individual comment.
    pub async fn reply_to_discussion(
        &self,
        repo: &RepoRef,
        number: u64,
        discussion_id: &str,
        body: &str,
    ) -> Result<GithubNote, GithubError> {
        if body.trim().is_empty() {
            return Err(GithubError::configuration(
                "la réponse ne peut pas être vide",
            ));
        }
        let number_text = number.to_string();
        if let Some(root) = discussion_id.strip_prefix("review_") {
            let url =
                self.repo_endpoint(repo, &["pulls", &number_text, "comments", root, "replies"])?;
            let payload = serde_json::json!({ "body": body });
            let comment: WireReviewComment = self.send_json(Method::POST, &url, &payload).await?;
            self.invalidate_pull(repo, number);
            return Ok(comment.into_note());
        }
        let url = self.repo_endpoint(repo, &["issues", &number_text, "comments"])?;
        let payload = serde_json::json!({ "body": body });
        let comment: WireIssueComment = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_pull(repo, number);
        Ok(comment.into_note())
    }

    /// Approval state aggregated from the latest review of each user.
    pub async fn approvals(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<GithubApprovals, GithubError> {
        let url = self.reviews_url(repo, number)?;
        let fetched = self.fetch(&url).await?;
        let reviews: Vec<WireReview> = decode(&fetched.body)?;
        Ok(aggregate_reviews(reviews))
    }

    /// Submit an approving review.
    pub async fn approve(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<GithubApprovals, GithubError> {
        let number_text = number.to_string();
        let url = self.repo_endpoint(repo, &["pulls", &number_text, "reviews"])?;
        let payload = serde_json::json!({ "event": "APPROVE" });
        let _: WireReview = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_pull(repo, number);
        self.approvals(repo, number).await
    }

    /// Dismiss the authenticated user's approving review.
    pub async fn unapprove(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<GithubApprovals, GithubError> {
        let me = self.validate().await?;
        let reviews_url = self.reviews_url(repo, number)?;
        let fetched = self.fetch(&reviews_url).await?;
        let reviews: Vec<WireReview> = decode(&fetched.body)?;
        let Some(review) = latest_review_for(&reviews, &me.username) else {
            return Ok(aggregate_reviews(reviews));
        };
        if review.state != "APPROVED" {
            return Ok(aggregate_reviews(reviews));
        }
        let number_text = number.to_string();
        let id = review.id.to_string();
        let url =
            self.repo_endpoint(repo, &["pulls", &number_text, "reviews", &id, "dismissals"])?;
        let payload = serde_json::json!({
            "message": "Approbation retirée depuis BeeBranch."
        });
        let _: serde_json::Value = self.send_json(Method::PUT, &url, &payload).await?;
        self.invalidate_pull(repo, number);
        self.approvals(repo, number).await
    }

    /// Merge a pull request, then return its refreshed state.
    pub async fn merge_pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
        input: &PullRequestMerge,
    ) -> Result<GithubPullRequest, GithubError> {
        let number_text = number.to_string();
        let url = self.repo_endpoint(repo, &["pulls", &number_text, "merge"])?;
        let method = if input.squash {
            "squash"
        } else {
            match input.merge_method.as_deref() {
                Some("rebase") | Some("rebase_merge") => "rebase",
                Some("squash") => "squash",
                _ => "merge",
            }
        };
        let mut payload = serde_json::json!({ "merge_method": method });
        if let Some(sha) = &input.sha {
            payload["sha"] = serde_json::Value::String(sha.clone());
        }
        let merged: WireMerge = self.send_json(Method::PUT, &url, &payload).await?;
        if !merged.merged {
            return Err(GithubError::new(
                "github.conflict",
                if merged.message.is_empty() {
                    "GitHub n'a pas fusionné la pull request.".to_owned()
                } else {
                    format!(
                        "GitHub n'a pas fusionné la pull request : {}",
                        merged.message
                    )
                },
            ));
        }
        self.invalidate_pull(repo, number);
        self.pull_request(repo, number).await
    }

    /// Jobs of the latest Actions run for a commit.
    pub async fn workflow_jobs(
        &self,
        repo: &RepoRef,
        head_sha: &str,
        page: u32,
        per_page: u32,
    ) -> Result<JobsPage, GithubError> {
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let page = page.max(1);

        let mut runs_url = self.repo_endpoint(repo, &["actions", "runs"])?;
        runs_url
            .query_pairs_mut()
            .append_pair("head_sha", head_sha)
            .append_pair("per_page", "1")
            .append_pair("page", "1");
        let fetched_runs = self.fetch(&runs_url).await?;
        let runs: WireWorkflowRuns = decode(&fetched_runs.body)?;
        let Some(run) = runs.workflow_runs.into_iter().next() else {
            return Ok(JobsPage {
                run_id: None,
                items: Vec::new(),
                page,
                per_page,
                next_page: None,
                total: None,
                not_modified: fetched_runs.not_modified,
                from_cache: fetched_runs.from_cache,
            });
        };

        let run_id = run.id.to_string();
        let mut jobs_url = self.repo_endpoint(repo, &["actions", "runs", &run_id, "jobs"])?;
        jobs_url
            .query_pairs_mut()
            .append_pair("per_page", &per_page.to_string())
            .append_pair("page", &page.to_string());
        let jobs = self.fetch(&jobs_url).await?;
        let result: WireWorkflowJobs = decode(&jobs.body)?;

        Ok(JobsPage {
            run_id: Some(run.id),
            items: result
                .jobs
                .into_iter()
                .map(|job| {
                    let duration = job.duration_seconds();
                    GithubJob {
                        id: job.id,
                        name: job.name,
                        stage: run.name.clone(),
                        status: normalize_status(&job.status, job.conclusion.as_deref()).to_owned(),
                        web_url: job.html_url,
                        duration,
                        created_at: job.started_at,
                        finished_at: job.completed_at,
                    }
                })
                .collect(),
            page,
            per_page,
            next_page: jobs.next_page,
            total: Some(result.total_count),
            not_modified: fetched_runs.not_modified && jobs.not_modified,
            from_cache: fetched_runs.from_cache && jobs.from_cache,
        })
    }

    /// Fetch one page of a GitHub Actions job log.
    ///
    /// GitHub answers with a redirect to a short-lived signed URL. The signed
    /// URL is followed without the token, then the body is streamed up to
    /// `max_bytes`; when GitHub ignores `Range`, `offset` bytes are skipped.
    pub async fn job_log(
        &self,
        repo: &RepoRef,
        job_id: u64,
        max_bytes: usize,
        offset: usize,
    ) -> Result<JobLog, GithubError> {
        let job = job_id.to_string();
        let url = self.repo_endpoint(repo, &["actions", "jobs", &job, "logs"])?;
        let cap = max_bytes.clamp(4 * 1024, 4 * 1024 * 1024);

        let response = self
            .http
            .get(url.clone())
            .header(ACCEPT, HeaderValue::from_static("*/*"))
            .header(AUTHORIZATION, self.token.bearer())
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;

        let status = response.status();
        let rate_limited = is_rate_limited_headers(response.headers());
        let response = if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| GithubError::invalid_response("redirection sans Location"))?;
            let target = url.join(location).map_err(|error| {
                GithubError::invalid_response(format!("redirection invalide : {error}"))
            })?;
            self.http
                .get(target)
                .send()
                .await
                .map_err(|error| self.transport_error(&error))?
        } else if status.is_success() {
            response
        } else {
            let bytes = self.read_body(response).await?;
            let text = String::from_utf8_lossy(&bytes);
            return Err(GithubError::from_status(
                status.as_u16(),
                &text,
                rate_limited,
            ));
        };

        let status = response.status();
        if !status.is_success() {
            let bytes = self.read_body(response).await?;
            let text = String::from_utf8_lossy(&bytes);
            return Err(GithubError::from_status(status.as_u16(), &text, false));
        }

        let partial = status == StatusCode::PARTIAL_CONTENT;
        let mut response = response;
        let mut buffer: Vec<u8> = Vec::new();
        let mut skip = if partial { 0 } else { offset };
        let mut overflow = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| self.transport_error(&error))?
        {
            let mut chunk = chunk.as_ref();
            if skip > 0 {
                let consumed = skip.min(chunk.len());
                skip -= consumed;
                chunk = &chunk[consumed..];
                if chunk.is_empty() {
                    continue;
                }
            }
            let remaining = cap.saturating_sub(buffer.len());
            if chunk.len() > remaining {
                buffer.extend_from_slice(&chunk[..remaining]);
                overflow = true;
                break;
            }
            buffer.extend_from_slice(chunk);
            if buffer.len() == cap {
                overflow = true;
                break;
            }
        }

        Ok(JobLog {
            text: String::from_utf8_lossy(&buffer).into_owned(),
            bytes: buffer.len(),
            truncated: overflow,
            source_url: url.to_string(),
            offset,
            next_offset: overflow.then(|| offset.saturating_add(buffer.len())),
        })
    }

    /// Diff anchors (`base` and `head` SHAs) of a pull request version.
    pub async fn diff_refs(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<GithubDiffRefs, GithubError> {
        // The public pull request carries the head SHA only; fetch the raw
        // wire payload again to expose the base SHA as well.
        let number_text = number.to_string();
        let url = self.repo_endpoint(repo, &["pulls", &number_text])?;
        let fetched = self.fetch(&url).await?;
        let wire: WirePull = decode(&fetched.body)?;
        let head_sha = wire
            .head
            .as_ref()
            .map(|head| head.sha.clone())
            .unwrap_or_default();
        let base_sha = wire
            .base
            .as_ref()
            .map(|base| base.sha.clone())
            .unwrap_or_default();
        Ok(GithubDiffRefs {
            start_sha: base_sha.clone(),
            base_sha,
            head_sha,
        })
    }

    fn reviews_url(&self, repo: &RepoRef, number: u64) -> Result<Url, GithubError> {
        let number_text = number.to_string();
        let mut url = self.repo_endpoint(repo, &["pulls", &number_text, "reviews"])?;
        url.query_pairs_mut()
            .append_pair("per_page", &MAX_PER_PAGE.to_string());
        Ok(url)
    }

    fn invalidate_pulls(&self, repo: &RepoRef) {
        if let Some(cache) = &self.cache {
            let base = self.url.api_url.trim_end_matches('/');
            cache.remove_prefix(&format!("{base}/repos/{}/{}/pulls", repo.owner, repo.name));
        }
    }

    fn invalidate_pull(&self, repo: &RepoRef, number: u64) {
        if let Some(cache) = &self.cache {
            let base = self.url.api_url.trim_end_matches('/');
            cache.remove_prefix(&format!(
                "{base}/repos/{}/{}/pulls/{number}",
                repo.owner, repo.name
            ));
            self.invalidate_pulls(repo);
        }
    }

    async fn send_json<B, T>(&self, method: Method, url: &Url, body: &B) -> Result<T, GithubError>
    where
        B: serde::Serialize,
        T: DeserializeOwned,
    {
        if method == Method::GET {
            return Err(GithubError::configuration(
                "send_json ne gère pas les lectures",
            ));
        }
        let response = self
            .http
            .request(method, url.clone())
            .header(
                ACCEPT,
                HeaderValue::from_static("application/vnd.github+json"),
            )
            .header(AUTHORIZATION, self.token.bearer())
            .header("X-GitHub-Api-Version", API_VERSION)
            .json(body)
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        let status = response.status();
        let rate_limited = is_rate_limited_headers(response.headers());
        let bytes = self.read_body(response).await?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            return Err(GithubError::from_status(
                status.as_u16(),
                &text,
                rate_limited,
            ));
        }
        decode(&bytes)
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, GithubError> {
        let mut url = Url::parse(&self.url.api_url).map_err(|error| {
            GithubError::configuration(format!("Base API GitHub invalide : {error}"))
        })?;
        {
            let mut path = url.path_segments_mut().map_err(|_| {
                GithubError::configuration("La base API GitHub ne peut pas recevoir de chemin.")
            })?;
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    fn repo_endpoint(&self, repo: &RepoRef, tail: &[&str]) -> Result<Url, GithubError> {
        let mut segments = Vec::with_capacity(tail.len() + 3);
        segments.push("repos");
        segments.push(repo.owner.as_str());
        segments.push(repo.name.as_str());
        segments.extend_from_slice(tail);
        self.endpoint(&segments)
    }

    fn repositories_url(&self, page: u32, per_page: u32) -> Result<Url, GithubError> {
        let mut url = self.endpoint(&["user", "repos"])?;
        let per_page_value = per_page.to_string();
        let page_value = page.to_string();
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("affiliation", "owner,collaborator,organization_member")
                .append_pair("sort", "updated")
                .append_pair("direction", "desc")
                .append_pair("per_page", &per_page_value)
                .append_pair("page", &page_value);
        }
        Ok(url)
    }

    fn search_repositories_url(
        &self,
        page: u32,
        per_page: u32,
        search: &str,
    ) -> Result<Url, GithubError> {
        let mut url = self.endpoint(&["search", "repositories"])?;
        let per_page_value = per_page.to_string();
        let page_value = page.to_string();
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("q", search)
                .append_pair("sort", "updated")
                .append_pair("order", "desc")
                .append_pair("per_page", &per_page_value)
                .append_pair("page", &page_value);
        }
        Ok(url)
    }

    async fn fetch(&self, url: &Url) -> Result<Fetched, GithubError> {
        let cache_key = url.as_str();
        let cached = self.cache.as_ref().and_then(|cache| cache.get(cache_key));
        let conditional = cached
            .as_ref()
            .filter(|entry| is_fresh(entry, now_unix()))
            .and_then(|entry| entry.etag.clone());

        let mut last_error = None;

        for attempt in 1..=MAX_ATTEMPTS {
            let request = self.request(url, conditional.as_deref());

            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let rate_limited = is_rate_limited_headers(response.headers());

                    if status == StatusCode::NOT_MODIFIED {
                        let Some(entry) = cached.as_ref().filter(|_| conditional.is_some()) else {
                            return Err(GithubError::invalid_response(
                                "GitHub a répondu 304 sans requête conditionnelle valide.",
                            ));
                        };
                        return Ok(Fetched::from_cache(entry));
                    }

                    if status.is_success() {
                        let meta = ResponseMeta::from_headers(response.headers());
                        let body = self.read_body(response).await?;
                        if let Some(cache) = &self.cache {
                            let now = now_unix();
                            let ttl = i64::try_from(self.cache_ttl.as_secs()).unwrap_or(i64::MAX);
                            cache.put(
                                cache_key,
                                CachedResponse {
                                    etag: meta.etag.clone(),
                                    body: body.clone(),
                                    fetched_at: now,
                                    expires_at: Some(now.saturating_add(ttl)),
                                },
                            );
                        }
                        return Ok(Fetched {
                            body,
                            next_page: meta.next_page,
                            total: meta.total,
                            not_modified: false,
                            from_cache: false,
                        });
                    }

                    if retryable_status(status, rate_limited) && attempt < MAX_ATTEMPTS {
                        let delay = if status == StatusCode::TOO_MANY_REQUESTS || rate_limited {
                            retry_after_delay(response.headers())
                                .unwrap_or_else(|| self.backoff_delay(attempt, cache_key))
                        } else {
                            self.backoff_delay(attempt, cache_key)
                        };
                        debug!(
                            attempt,
                            delay_ms = delay.as_millis(),
                            status = status.as_u16(),
                            "Retrying GitHub request"
                        );
                        sleep(delay).await;
                        continue;
                    }

                    let body = self.read_body(response).await?;
                    let text = String::from_utf8_lossy(&body);
                    return Err(GithubError::from_status(
                        status.as_u16(),
                        &text,
                        rate_limited,
                    ));
                }
                Err(error) => {
                    let classified = self.transport_error(&error);
                    if classified.retryable() && attempt < MAX_ATTEMPTS {
                        let delay = self.backoff_delay(attempt, cache_key);
                        debug!(
                            attempt,
                            delay_ms = delay.as_millis(),
                            "Retrying GitHub request after a transport error"
                        );
                        last_error = Some(classified);
                        sleep(delay).await;
                        continue;
                    }
                    return Err(classified);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            GithubError::network(&self.url.host, "Toutes les tentatives ont échoué.")
        }))
    }

    fn request(&self, url: &Url, etag: Option<&str>) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .get(url.clone())
            .header(
                ACCEPT,
                HeaderValue::from_static("application/vnd.github+json"),
            )
            .header(AUTHORIZATION, self.token.bearer())
            .header("X-GitHub-Api-Version", API_VERSION);

        if let Some(etag) = etag {
            if let Ok(value) = HeaderValue::from_str(etag) {
                request = request.header(IF_NONE_MATCH, value);
            }
        }

        request
    }

    async fn read_body(&self, response: reqwest::Response) -> Result<Vec<u8>, GithubError> {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| self.transport_error(&error))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(GithubError::invalid_response(
                "La réponse GitHub dépasse la taille maximale autorisée.",
            ));
        }
        Ok(bytes.to_vec())
    }

    fn transport_error(&self, error: &reqwest::Error) -> GithubError {
        let detail = error_chain(error);

        if error.is_timeout() {
            GithubError::timeout(&self.url.host, detail)
        } else if looks_like_tls(&detail) {
            GithubError::tls(&self.url.host, detail)
        } else if error.is_decode() {
            GithubError::invalid_response(detail)
        } else if error.is_builder() {
            GithubError::configuration(format!(
                "Impossible de construire la requête GitHub : {detail}"
            ))
        } else {
            GithubError::network(&self.url.host, detail)
        }
    }

    fn backoff_delay(&self, attempt: usize, key: &str) -> Duration {
        let exponent = attempt.saturating_sub(1).min(4);
        let base = BASE_BACKOFF_MS
            .saturating_mul(1u64 << exponent)
            .min(MAX_BACKOFF_MS);
        let jitter = deterministic_jitter(key, attempt as u32, base);
        Duration::from_millis(base.saturating_add(jitter).min(MAX_BACKOFF_MS))
    }
}

/// Token kept as a pre-validated header value; its `Debug` is always redacted.
#[derive(Clone)]
struct SecretToken(HeaderValue);

impl SecretToken {
    fn new(token: &str) -> Result<Self, GithubError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(GithubError::configuration(
                "Le jeton d'accès GitHub est vide.",
            ));
        }
        HeaderValue::from_str(&format!("Bearer {trimmed}"))
            .map(Self)
            .map_err(|_| {
                GithubError::configuration(
                    "Le jeton d'accès GitHub contient des caractères interdits.",
                )
            })
    }

    fn bearer(&self) -> HeaderValue {
        self.0.clone()
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Debug)]
struct Fetched {
    body: Vec<u8>,
    next_page: Option<u32>,
    total: Option<u64>,
    not_modified: bool,
    from_cache: bool,
}

impl Fetched {
    fn from_cache(entry: &CachedResponse) -> Self {
        Self {
            body: entry.body.clone(),
            next_page: None,
            total: None,
            not_modified: true,
            from_cache: true,
        }
    }
}

#[derive(Debug, Default)]
struct ResponseMeta {
    etag: Option<String>,
    next_page: Option<u32>,
    total: Option<u64>,
}

impl ResponseMeta {
    fn from_headers(headers: &HeaderMap) -> Self {
        Self {
            etag: headers
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            next_page: next_page_from_link(headers),
            total: None,
        }
    }
}

/// Extract `page=N` from the `rel="next"` entry of a `Link` header.
fn next_page_from_link(headers: &HeaderMap) -> Option<u32> {
    let link = headers.get(LINK)?.to_str().ok()?;
    for part in link.split(',') {
        if !part.contains("rel=\"next\"") {
            continue;
        }
        let start = part.find('<')? + 1;
        let end = part[start..].find('>')? + start;
        let url = Url::parse(&part[start..end]).ok()?;
        return url
            .query_pairs()
            .find(|(key, _)| key == "page")
            .and_then(|(_, value)| value.parse::<u32>().ok())
            .filter(|page| *page > 0);
    }
    None
}

fn is_rate_limited_headers(headers: &HeaderMap) -> bool {
    headers
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .is_some_and(|remaining| remaining == 0)
}

fn aggregate_reviews(reviews: Vec<WireReview>) -> GithubApprovals {
    let mut latest: BTreeMap<String, WireReview> = BTreeMap::new();
    for review in reviews {
        // A later COMMENTED review does not withdraw an approval; only
        // APPROVED, CHANGES_REQUESTED and DISMISSED are decisive.
        if !matches!(
            review.state.as_str(),
            "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
        ) {
            continue;
        }
        let Some(user) = review.user.as_ref() else {
            continue;
        };
        let submitted = review.submitted_at.clone().unwrap_or_default();
        let replace = latest
            .get(&user.login)
            .map(|current| current.submitted_at.clone().unwrap_or_default() <= submitted)
            .unwrap_or(true);
        if replace {
            latest.insert(user.login.clone(), review);
        }
    }
    let approved_by = latest
        .into_values()
        .filter(|review| review.state == "APPROVED")
        .filter_map(|review| review.user)
        .map(|user| crate::models::GithubApproval {
            user: user.into_ref(),
        })
        .collect();
    GithubApprovals {
        approvals_required: 0,
        approvals_left: 0,
        approved_by,
    }
}

fn latest_review_for<'a>(reviews: &'a [WireReview], login: &str) -> Option<&'a WireReview> {
    reviews
        .iter()
        .filter(|review| {
            matches!(
                review.state.as_str(),
                "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
            ) && review
                .user
                .as_ref()
                .is_some_and(|user| user.login.eq_ignore_ascii_case(login))
        })
        .max_by_key(|review| review.submitted_at.clone().unwrap_or_default())
}

fn build_discussions(
    issue_comments: Vec<WireIssueComment>,
    review_comments: Vec<WireReviewComment>,
) -> Vec<GithubDiscussion> {
    let mut discussions: Vec<(String, GithubDiscussion)> = issue_comments
        .into_iter()
        .map(|comment| {
            let created = comment.created_at.clone().unwrap_or_default();
            let id = format!("issue_{}", comment.id);
            (
                created,
                GithubDiscussion {
                    id,
                    individual_note: true,
                    notes: vec![comment.into_note()],
                },
            )
        })
        .collect();

    let mut by_id: HashMap<u64, WireReviewComment> = review_comments
        .into_iter()
        .map(|comment| (comment.id, comment))
        .collect();
    let mut roots: BTreeMap<u64, Vec<WireReviewComment>> = BTreeMap::new();
    let ids: Vec<u64> = by_id.keys().copied().collect();
    // Resolve every root against the complete map before removing entries;
    // otherwise a reply can be orphaned when its parent was already taken.
    let grouped: Vec<(u64, u64)> = ids
        .into_iter()
        .map(|id| (id, root_of(&by_id, id)))
        .collect();
    for (id, root) in grouped {
        if let Some(comment) = by_id.remove(&id) {
            roots.entry(root).or_default().push(comment);
        }
    }
    for (root, mut notes) in roots {
        notes.sort_by_key(|note| (note.created_at.clone().unwrap_or_default(), note.id));
        let created = notes
            .first()
            .and_then(|note| note.created_at.clone())
            .unwrap_or_default();
        discussions.push((
            created,
            GithubDiscussion {
                id: format!("review_{root}"),
                individual_note: notes.len() == 1,
                notes: notes
                    .into_iter()
                    .map(WireReviewComment::into_note)
                    .collect(),
            },
        ));
    }

    discussions.sort_by(|left, right| left.0.cmp(&right.0));
    discussions.into_iter().map(|(_, value)| value).collect()
}

/// Follow `in_reply_to_id` links until the thread root (cycle-safe).
fn root_of(comments: &HashMap<u64, WireReviewComment>, start: u64) -> u64 {
    let mut current = start;
    for _ in 0..comments.len().min(64) {
        let Some(comment) = comments.get(&current) else {
            break;
        };
        match comment.in_reply_to_id {
            Some(parent) if comments.contains_key(&parent) && parent != current => current = parent,
            _ => break,
        }
    }
    current
}

pub(crate) fn build_http_client(config: &GithubConfig) -> Result<Client, GithubError> {
    let mut builder = Client::builder()
        .timeout(config.timeout)
        .user_agent(USER_AGENT)
        .use_rustls_tls()
        // The token must never follow a redirect to another origin.
        .redirect(reqwest::redirect::Policy::none());

    if let Some(pem) = &config.ca_bundle_pem {
        if pem.is_empty() {
            return Err(GithubError::invalid_ca(
                "Le certificat CA importé est vide.",
            ));
        }
        let certificates = reqwest::Certificate::from_pem_bundle(pem).map_err(|error| {
            GithubError::invalid_ca(format!("Certificat CA illisible : {error}"))
        })?;
        if certificates.is_empty() {
            return Err(GithubError::invalid_ca(
                "Le fichier ne contient aucun certificat CA.",
            ));
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }

    builder.build().map_err(|error| {
        GithubError::configuration(format!("Client HTTP GitHub invalide : {error}"))
    })
}

fn is_fresh(entry: &CachedResponse, now: i64) -> bool {
    entry.expires_at.is_none_or(|expires_at| expires_at > now)
}

fn retryable_status(status: StatusCode, rate_limited: bool) -> bool {
    rate_limited || status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_after_delay(headers: &HeaderMap) -> Option<Duration> {
    let seconds = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())?;
    Some(Duration::from_secs(seconds).min(Duration::from_millis(MAX_BACKOFF_MS)))
}

fn deterministic_jitter(key: &str, attempt: u32, base_ms: u64) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hasher.update(attempt.to_be_bytes());
    let digest = hasher.finalize();
    let value = digest.iter().take(8).fold(0u64, |accumulator, byte| {
        (accumulator << 8) | u64::from(*byte)
    });
    value % (base_ms / 4 + 1)
}

pub(crate) fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = Vec::new();
    let mut current = Some(error);
    while let Some(error) = current {
        if parts.len() >= 6 {
            break;
        }
        parts.push(error.to_string());
        current = error.source();
    }
    parts.join(" : ")
}

pub(crate) fn looks_like_tls(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    [
        "certificate",
        "unknown issuer",
        "self signed",
        "self-signed",
        "tls",
        "ssl",
    ]
    .iter()
    .any(|needle| detail.contains(needle))
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, GithubError> {
    serde_json::from_slice(body)
        .map_err(|error| GithubError::invalid_response(format!("JSON inattendu : {error}")))
}

// --- Wire models ----------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct WireUser {
    id: u64,
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

impl WireUser {
    fn into_public(self) -> GithubUser {
        GithubUser {
            id: self.id,
            username: self.login.clone(),
            name: self.name.unwrap_or(self.login),
            avatar_url: self.avatar_url,
        }
    }

    fn into_ref(self) -> GithubUserRef {
        GithubUserRef {
            id: self.id,
            username: self.login.clone(),
            name: self.name.unwrap_or(self.login),
            avatar_url: self.avatar_url,
        }
    }
}

impl From<WireUser> for GithubUserRef {
    fn from(user: WireUser) -> Self {
        user.into_ref()
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireRepo {
    id: u64,
    name: String,
    full_name: String,
    html_url: String,
    #[serde(default)]
    ssh_url: Option<String>,
    #[serde(default)]
    clone_url: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl WireRepo {
    fn into_public(self) -> GithubProject {
        GithubProject {
            id: self.id,
            name: self.name,
            path_with_namespace: self.full_name,
            web_url: self.html_url,
            ssh_url_to_repo: self.ssh_url,
            http_url_to_repo: self.clone_url,
            default_branch: self.default_branch,
            last_activity_at: self.pushed_at.or(self.updated_at),
            description: self.description,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireSearchRepositories {
    total_count: u64,
    #[serde(default)]
    items: Vec<WireRepo>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireRef {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WireLabel {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WirePull {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    head: Option<WireRef>,
    #[serde(default)]
    base: Option<WireRef>,
    #[serde(default)]
    user: Option<WireUser>,
    #[serde(default)]
    assignees: Option<Vec<WireUser>>,
    #[serde(default)]
    requested_reviewers: Option<Vec<WireUser>>,
    #[serde(default)]
    labels: Option<Vec<WireLabel>>,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    mergeable_state: Option<String>,
    html_url: String,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    comments: Option<u32>,
    #[serde(default)]
    review_comments: Option<u32>,
}

impl WirePull {
    fn into_public(self, project_id: Option<u64>) -> GithubPullRequest {
        let draft = self.draft.unwrap_or(false);
        let author = self
            .user
            .map(WireUser::into_ref)
            .unwrap_or_else(unknown_user);
        let source_branch = self
            .head
            .as_ref()
            .map(|head| head.ref_name.clone())
            .unwrap_or_default();
        let target_branch = self
            .base
            .as_ref()
            .map(|base| base.ref_name.clone())
            .unwrap_or_default();
        let state = if self.merged_at.is_some() {
            "merged".to_owned()
        } else if self.state == "open" {
            "opened".to_owned()
        } else {
            self.state
        };
        GithubPullRequest {
            project_id,
            iid: self.number,
            title: self.title,
            state,
            draft,
            work_in_progress: draft,
            source_branch,
            target_branch,
            author,
            assignees: self
                .assignees
                .unwrap_or_default()
                .into_iter()
                .map(WireUser::into_ref)
                .collect(),
            reviewers: self
                .requested_reviewers
                .unwrap_or_default()
                .into_iter()
                .map(WireUser::into_ref)
                .collect(),
            labels: self
                .labels
                .unwrap_or_default()
                .into_iter()
                .map(|label| label.name)
                .collect(),
            detailed_merge_status: self.mergeable_state.clone(),
            merge_status: self.mergeable_state,
            has_conflicts: self.mergeable == Some(false),
            sha: self.head.map(|head| head.sha),
            web_url: self.html_url,
            updated_at: self.updated_at,
            user_notes_count: self.comments.unwrap_or(0) + self.review_comments.unwrap_or(0),
            head_pipeline: None,
            repository_name: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireSearchIssues {
    total_count: u64,
    #[serde(default)]
    items: Vec<WireSearchIssue>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireSearchIssue {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    user: Option<WireUser>,
    #[serde(default)]
    assignees: Option<Vec<WireUser>>,
    #[serde(default)]
    labels: Option<Vec<WireLabel>>,
    html_url: String,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    comments: Option<u32>,
    #[serde(default)]
    repository_url: Option<String>,
}

impl WireSearchIssue {
    fn into_public(self) -> GithubPullRequest {
        let draft = self.draft.unwrap_or(false);
        let state = if self.state == "open" {
            "opened".to_owned()
        } else {
            self.state
        };
        let repository_name = self.repository_url.as_deref().and_then(|url| {
            url.split_once("/repos/")
                .map(|(_, rest)| rest.trim_end_matches('/').to_owned())
        });
        GithubPullRequest {
            project_id: None,
            iid: self.number,
            title: self.title,
            state,
            draft,
            work_in_progress: draft,
            source_branch: String::new(),
            target_branch: String::new(),
            author: self
                .user
                .map(WireUser::into_ref)
                .unwrap_or_else(unknown_user),
            assignees: self
                .assignees
                .unwrap_or_default()
                .into_iter()
                .map(WireUser::into_ref)
                .collect(),
            reviewers: Vec::new(),
            labels: self
                .labels
                .unwrap_or_default()
                .into_iter()
                .map(|label| label.name)
                .collect(),
            detailed_merge_status: None,
            merge_status: None,
            has_conflicts: false,
            sha: None,
            web_url: self.html_url,
            updated_at: self.updated_at,
            user_notes_count: self.comments.unwrap_or(0),
            head_pipeline: None,
            repository_name,
        }
    }
}

fn unknown_user() -> GithubUserRef {
    GithubUserRef {
        id: 0,
        username: "inconnu".to_owned(),
        name: "Utilisateur inconnu".to_owned(),
        avatar_url: None,
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireCheckRuns {
    #[serde(default)]
    check_runs: Vec<WireCheckRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireCheckRun {
    id: u64,
    name: String,
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    head_sha: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    details_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireReviewComment {
    id: u64,
    body: String,
    #[serde(default)]
    user: Option<WireUser>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    original_line: Option<u32>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    commit_id: Option<String>,
    #[serde(default)]
    in_reply_to_id: Option<u64>,
}

impl WireReviewComment {
    fn into_note(self) -> GithubNote {
        let position = self.position();
        GithubNote {
            id: self.id,
            body: self.body,
            author: self
                .user
                .map(WireUser::into_ref)
                .unwrap_or_else(unknown_user),
            created_at: self.created_at,
            updated_at: self.updated_at,
            system: false,
            resolvable: false,
            resolved: false,
            position,
        }
    }

    fn position(&self) -> Option<GithubPosition> {
        let path = self.path.clone()?;
        let line = self.line.or(self.original_line)?;
        let commit = self.commit_id.clone().unwrap_or_default();
        let left_side = self
            .side
            .as_deref()
            .is_some_and(|side| side.eq_ignore_ascii_case("LEFT"));
        Some(GithubPosition {
            base_sha: commit.clone(),
            start_sha: commit.clone(),
            head_sha: commit,
            position_type: "text".to_owned(),
            new_path: (!left_side).then(|| path.clone()),
            old_path: left_side.then(|| path.clone()),
            new_line: (!left_side).then_some(line),
            old_line: left_side.then_some(line),
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireIssueComment {
    id: u64,
    body: String,
    #[serde(default)]
    user: Option<WireUser>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

impl WireIssueComment {
    fn into_note(self) -> GithubNote {
        GithubNote {
            id: self.id,
            body: self.body,
            author: self
                .user
                .map(WireUser::into_ref)
                .unwrap_or_else(unknown_user),
            created_at: self.created_at,
            updated_at: self.updated_at,
            system: false,
            resolvable: false,
            resolved: false,
            position: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct WireReview {
    id: u64,
    #[serde(default)]
    user: Option<WireUser>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    submitted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireMerge {
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WireWorkflowRuns {
    #[serde(default)]
    workflow_runs: Vec<WireWorkflowRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireWorkflowRun {
    id: u64,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WireWorkflowJobs {
    #[serde(default)]
    total_count: u64,
    #[serde(default)]
    jobs: Vec<WireWorkflowJob>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireWorkflowJob {
    id: u64,
    name: String,
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
}

impl WireWorkflowJob {
    fn duration_seconds(&self) -> Option<f64> {
        let started = self.started_at.as_deref()?;
        let finished = self.completed_at.as_deref()?;
        let started = chrono_like_epoch(started)?;
        let finished = chrono_like_epoch(finished)?;
        (finished >= started).then_some((finished - started) as f64)
    }
}

/// Minimal RFC 3339 parser returning seconds since the Unix epoch.
fn chrono_like_epoch(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests;
