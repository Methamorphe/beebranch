//! GitLab REST v4 HTTP client.
//!
//! The client owns its `reqwest::Client`, configured with rustls, mandatory
//! certificate verification, an optional extra CA bundle and a hard timeout.
//! The personal access token travels exclusively in the `PRIVATE-TOKEN`
//! header: it is never placed in a URL, a log line or a `Debug` output.
//!
//! Idempotent requests retry up to three times on `429` and `5xx` with
//! deterministic jittered backoff, honouring `Retry-After`. Successful `GET`
//! responses are cached and revalidated with `If-None-Match`.

use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use beebranch_core::now_unix;
use beebranch_core::redaction;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ETAG, IF_NONE_MATCH, RETRY_AFTER};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use tokio::time::sleep;
use tracing::debug;

use crate::cache::{CachedResponse, ResponseCache};
use crate::error::GitlabError;
use crate::models::{
    CreateMergeRequest, GitlabApprovals, GitlabDiffRefs, GitlabDiscussion, GitlabFilePatch,
    GitlabJob, GitlabMergeRequest, GitlabNote, GitlabPipeline, GitlabPosition, GitlabProject,
    GitlabUser, JobLog, MergeRequestMerge, MergeRequestScope, MergeRequestUpdate,
    MergeRequestsQuery, Paged,
};
use crate::url::{normalize_url, NormalizedUrl};

/// Number of pages fetched at most by a single [`GitlabClient::projects`] call.
pub const DEFAULT_MAX_PAGES: u32 = 20;
/// Upper bound accepted by [`GitlabClient::with_max_pages`].
pub const MAX_PAGES_LIMIT: u32 = 100;
/// Default lifetime of a cached response before it is fetched again.
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// GitLab maximum page size.
pub const MAX_PER_PAGE: u32 = 100;

const MAX_ATTEMPTS: usize = 3;
const BASE_BACKOFF_MS: u64 = 500;
const MAX_BACKOFF_MS: u64 = 8_000;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const USER_AGENT: &str = concat!("BeeBranch/", env!("CARGO_PKG_VERSION"));

/// Configuration of a GitLab instance connection.
pub struct GitlabConfig {
    /// Address entered by the user (https, optional path prefix).
    pub base_url: String,
    /// Personal access token. Never logged or serialized.
    pub token: String,
    /// Optional PEM bundle of internal CAs added to the system trust store.
    pub ca_bundle_pem: Option<Vec<u8>>,
    /// Total request timeout.
    pub timeout: Duration,
}

impl fmt::Debug for GitlabConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitlabConfig")
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

/// Query for [`GitlabClient::projects`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectsQuery {
    /// Optional search expression forwarded to GitLab.
    pub search: Option<String>,
    /// First page to request (1-based).
    pub page: u32,
    /// Requested page size, clamped to `1..=MAX_PER_PAGE`.
    pub per_page: u32,
}

impl Default for ProjectsQuery {
    fn default() -> Self {
        Self {
            search: None,
            page: 1,
            per_page: MAX_PER_PAGE,
        }
    }
}

impl ProjectsQuery {
    /// Query starting at the first page.
    pub fn new() -> Self {
        Self::default()
    }

    /// Filter projects by name or path.
    pub fn with_search(mut self, search: impl Into<String>) -> Self {
        self.search = Some(search.into());
        self
    }

    /// Start at `page` (clamped to at least 1).
    pub fn with_page(mut self, page: u32) -> Self {
        self.page = page.max(1);
        self
    }

    /// Request `per_page` items (clamped to `1..=MAX_PER_PAGE`).
    pub fn with_per_page(mut self, per_page: u32) -> Self {
        self.per_page = per_page.clamp(1, MAX_PER_PAGE);
        self
    }
}

/// GitLab REST v4 client.
#[derive(Clone)]
pub struct GitlabClient {
    http: Client,
    url: NormalizedUrl,
    token: Arc<RwLock<SecretToken>>,
    cache: Option<Arc<dyn ResponseCache>>,
    cache_ttl: Duration,
    max_pages: u32,
}

impl fmt::Debug for GitlabClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitlabClient")
            .field("api_url", &self.url.api_url)
            .field("host", &self.url.host)
            .field("token", &"[REDACTED]")
            .field("cache", &self.cache.is_some())
            .field("cache_ttl", &self.cache_ttl)
            .field("max_pages", &self.max_pages)
            .finish()
    }
}

impl GitlabClient {
    /// Build a client from an instance configuration.
    pub fn new(config: GitlabConfig) -> Result<Self, GitlabError> {
        let url = normalize_url(&config.base_url)?;
        let token = SecretToken::new(&config.token)?;
        let http = build_http_client(&config)?;

        Ok(Self {
            http,
            url,
            token: Arc::new(RwLock::new(token)),
            cache: None,
            cache_ttl: DEFAULT_CACHE_TTL,
            max_pages: DEFAULT_MAX_PAGES,
        })
    }

    /// Build a client against a plain-HTTP mock server.
    ///
    /// Production instances always require `https`; this constructor only
    /// exists so wiremock integration tests never need a TLS server.
    #[cfg(test)]
    fn for_test(base_url: &str, token: &str) -> Self {
        let url = NormalizedUrl {
            base_url: base_url.to_owned(),
            api_url: format!("{base_url}/api/v4"),
            web_url: base_url.to_owned(),
            host: "127.0.0.1".to_owned(),
            path_prefix: String::new(),
        };
        let config = GitlabConfig {
            base_url: base_url.to_owned(),
            token: token.to_owned(),
            ca_bundle_pem: None,
            timeout: Duration::from_secs(5),
        };

        Self {
            http: build_http_client(&config).expect("test HTTP client"),
            url,
            token: Arc::new(RwLock::new(SecretToken::new(token).expect("test token"))),
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

    /// Change the page cap applied to [`Self::projects`].
    pub fn with_max_pages(mut self, max_pages: u32) -> Self {
        self.max_pages = max_pages.clamp(1, MAX_PAGES_LIMIT);
        self
    }

    /// Normalized web base.
    pub fn base_url(&self) -> &str {
        &self.url.base_url
    }

    /// Normalized REST base (`<web>/api/v4`).
    pub fn api_url(&self) -> &str {
        &self.url.api_url
    }

    /// Instance host, including an explicit port.
    pub fn host(&self) -> &str {
        &self.url.host
    }

    /// Replace the access token in place.
    ///
    /// Clones share the same token cell, so an OAuth refresh updates every
    /// client already held by the commands without rebuilding them.
    pub fn set_token(&self, token: &str) -> Result<(), GitlabError> {
        let secret = SecretToken::new(token)?;
        *self
            .token
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = secret;
        Ok(())
    }

    fn token_header(&self) -> HeaderValue {
        self.token
            .read()
            .map(|token| token.header())
            .unwrap_or_else(|poisoned| poisoned.into_inner().header())
    }

    /// Validate the token with `GET /user`.
    pub async fn validate(&self) -> Result<GitlabUser, GitlabError> {
        let url = self.endpoint(&["user"])?;
        let fetched = self.fetch(&url).await?;
        decode(&fetched.body)
    }

    /// List projects accessible to the token.
    ///
    /// Pages are fetched until `X-Next-Page` is empty, a page is empty, or
    /// the configured page cap is reached.
    pub async fn projects(
        &self,
        query: ProjectsQuery,
    ) -> Result<Paged<GitlabProject>, GitlabError> {
        let per_page = query.per_page.clamp(1, MAX_PER_PAGE);
        let start_page = query.page.max(1);
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

            let url = self.projects_url(page, per_page, query.search.as_deref())?;
            let fetched = self.fetch(&url).await?;
            pages_fetched += 1;
            all_not_modified &= fetched.not_modified;
            all_from_cache &= fetched.from_cache;
            if fetched.total.is_some() {
                total = fetched.total;
            }

            let batch: Vec<GitlabProject> = decode(&fetched.body)?;
            if batch.is_empty() {
                next_page = None;
                break;
            }

            let batch_len = batch.len();
            items.extend(batch);

            if fetched.end_of_pages {
                next_page = None;
                break;
            }

            let candidate = fetched.next_page.or_else(|| {
                if batch_len < per_page as usize {
                    None
                } else {
                    Some(page.saturating_add(1))
                }
            });

            match candidate {
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

    /// Fetch a single project by numeric identifier.
    pub async fn project(&self, id: u64) -> Result<GitlabProject, GitlabError> {
        let id = id.to_string();
        let url = self.endpoint(&["projects", &id])?;
        let fetched = self.fetch(&url).await?;
        decode(&fetched.body)
    }

    /// List merge requests for one project or across accessible projects.
    ///
    /// One page is returned; `next_page` follows GitLab's `X-Next-Page`.
    pub async fn merge_requests(
        &self,
        query: MergeRequestsQuery,
    ) -> Result<Paged<GitlabMergeRequest>, GitlabError> {
        if query.page == 0 {
            return Err(GitlabError::configuration("page invalide"));
        }
        let per_page = query.per_page.clamp(1, MAX_PER_PAGE);
        let project = query.project_id.map(|id| id.to_string());
        let url = match project.as_deref() {
            Some(id) => self.endpoint(&["projects", id, "merge_requests"])?,
            None => self.endpoint(&["merge_requests"])?,
        };
        let mut url = url;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("state", "opened")
                .append_pair("order_by", "updated_at")
                .append_pair("sort", "desc")
                .append_pair("per_page", &per_page.to_string())
                .append_pair("page", &query.page.to_string());
            if query.scope != MergeRequestScope::All {
                pairs.append_pair("scope", query.scope.as_str());
            }
        }
        let fetched = self.fetch(&url).await?;
        let items: Vec<GitlabMergeRequest> = decode(&fetched.body)?;
        Ok(Paged {
            items,
            page: query.page,
            per_page,
            next_page: fetched.next_page,
            total: fetched.total,
            not_modified: fetched.not_modified,
            from_cache: fetched.from_cache,
        })
    }

    /// Fetch one merge request.
    pub async fn merge_request(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        let project = project_id.to_string();
        let iid = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid])?;
        let fetched = self.fetch(&url).await?;
        decode(&fetched.body)
    }

    /// Create a merge request. Mutations are never retried.
    pub async fn create_merge_request(
        &self,
        input: &CreateMergeRequest,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        if input.source_branch.trim().is_empty() || input.target_branch.trim().is_empty() {
            return Err(GitlabError::configuration(
                "les branches source et cible sont requises",
            ));
        }
        if input.title.trim().is_empty() {
            return Err(GitlabError::configuration(
                "le titre de la merge request est requis",
            ));
        }
        let project = input.project_id.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests"])?;
        let mut payload = serde_json::to_value(input).map_err(|error| {
            GitlabError::configuration(format!("payload de merge request : {error}"))
        })?;
        if input.draft && !input.title.starts_with("Draft:") {
            payload["title"] = serde_json::Value::String(format!("Draft: {}", input.title.trim()));
        }
        if !input.reviewer_ids.is_empty() {
            payload["reviewer_ids"] = serde_json::json!(input.reviewer_ids);
        }
        if !input.assignee_ids.is_empty() {
            payload["assignee_ids"] = serde_json::json!(input.assignee_ids);
        }
        if !input.labels.is_empty() {
            // The REST parameter is a comma-separated string, not an array.
            payload["labels"] = serde_json::Value::String(input.labels.join(","));
        }
        let created: GitlabMergeRequest = self.post_json(&url, &payload).await?;
        if let Some(cache) = &self.cache {
            cache.remove_prefix(&format!(
                "{}/projects/{}/merge_requests",
                self.url.api_url.trim_end_matches('/'),
                input.project_id
            ));
            cache.remove_prefix(&format!(
                "{}/merge_requests",
                self.url.api_url.trim_end_matches('/')
            ));
        }
        Ok(created)
    }

    /// Pipelines attached to a merge request (status refresh).
    pub async fn merge_request_pipelines(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<Vec<GitlabPipeline>, GitlabError> {
        let project = project_id.to_string();
        let iid = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid, "pipelines"])?;
        let fetched = self.fetch(&url).await?;
        decode(&fetched.body)
    }

    /// Diff anchors (`diff_refs`) of the current merge request version.
    pub async fn merge_request_diff_refs(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<GitlabDiffRefs, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text, "changes"])?;
        let fetched = self.fetch(&url).await?;
        #[derive(Deserialize)]
        struct Changes {
            diff_refs: GitlabDiffRefs,
        }
        let changes: Changes = decode(&fetched.body)?;
        Ok(changes.diff_refs)
    }

    /// Files of a merge request with their hunk patches.
    pub async fn merge_request_changes(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<Vec<GitlabFilePatch>, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text, "changes"])?;
        let fetched = self.fetch(&url).await?;
        #[derive(Deserialize)]
        struct Changes {
            #[serde(default)]
            changes: Vec<GitlabFilePatch>,
        }
        let changes: Changes = decode(&fetched.body)?;
        Ok(changes.changes)
    }

    /// Discussions (including inline notes) of one merge request.
    pub async fn merge_request_discussions(
        &self,
        project_id: u64,
        iid: u64,
        page: u32,
        per_page: u32,
    ) -> Result<Paged<GitlabDiscussion>, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let mut url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "discussions",
        ])?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("per_page", &per_page.to_string())
                .append_pair("page", &page.max(1).to_string());
        }
        let fetched = self.fetch(&url).await?;
        let items: Vec<GitlabDiscussion> = decode(&fetched.body)?;
        Ok(Paged {
            items,
            page: page.max(1),
            per_page,
            next_page: fetched.next_page,
            total: fetched.total,
            not_modified: fetched.not_modified,
            from_cache: fetched.from_cache,
        })
    }

    /// Create a discussion. `position` anchors an inline note to `diff_refs`.
    pub async fn create_discussion(
        &self,
        project_id: u64,
        iid: u64,
        body: &str,
        position: Option<&GitlabPosition>,
    ) -> Result<GitlabDiscussion, GitlabError> {
        if body.trim().is_empty() {
            return Err(GitlabError::configuration(
                "le commentaire ne peut pas être vide",
            ));
        }
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "discussions",
        ])?;
        let mut payload = serde_json::json!({ "body": body });
        if let Some(position) = position {
            // GitLab expects snake_case keys on the wire, while the frontend
            // exchanges camelCase. Build the position payload explicitly.
            let mut wire = serde_json::json!({
                "base_sha": position.base_sha,
                "start_sha": position.start_sha,
                "head_sha": position.head_sha,
                "position_type": position.position_type,
            });
            if let Some(value) = &position.new_path {
                wire["new_path"] = serde_json::Value::String(value.clone());
            }
            if let Some(value) = &position.old_path {
                wire["old_path"] = serde_json::Value::String(value.clone());
            }
            if let Some(value) = position.new_line {
                wire["new_line"] = serde_json::Value::from(value);
            }
            if let Some(value) = position.old_line {
                wire["old_line"] = serde_json::Value::from(value);
            }
            payload["position"] = wire;
        }
        let discussion: GitlabDiscussion = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_mr(project_id, iid);
        Ok(discussion)
    }

    /// Reply to an existing discussion thread.
    pub async fn reply_to_discussion(
        &self,
        project_id: u64,
        iid: u64,
        discussion_id: &str,
        body: &str,
    ) -> Result<GitlabNote, GitlabError> {
        if body.trim().is_empty() {
            return Err(GitlabError::configuration(
                "la réponse ne peut pas être vide",
            ));
        }
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "discussions",
            discussion_id,
            "notes",
        ])?;
        let payload = serde_json::json!({ "body": body });
        let note: GitlabNote = self.send_json(Method::POST, &url, &payload).await?;
        self.invalidate_mr(project_id, iid);
        Ok(note)
    }

    /// Resolve or unresolve a discussion thread.
    pub async fn set_discussion_resolved(
        &self,
        project_id: u64,
        iid: u64,
        discussion_id: &str,
        resolved: bool,
    ) -> Result<GitlabDiscussion, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "discussions",
            discussion_id,
        ])?;
        let payload = serde_json::json!({ "resolved": resolved });
        let discussion: GitlabDiscussion = self.send_json(Method::PUT, &url, &payload).await?;
        self.invalidate_mr(project_id, iid);
        Ok(discussion)
    }

    /// Approvals state. 404 means the feature is disabled on the instance.
    pub async fn approvals(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<GitlabApprovals, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "approvals",
        ])?;
        let fetched = self.fetch(&url).await?;
        decode(&fetched.body)
    }

    pub async fn approve(&self, project_id: u64, iid: u64) -> Result<GitlabApprovals, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text, "approve"])?;
        let value: GitlabApprovals = self
            .send_json(Method::POST, &url, &serde_json::json!({}))
            .await?;
        self.invalidate_mr(project_id, iid);
        Ok(value)
    }

    pub async fn unapprove(
        &self,
        project_id: u64,
        iid: u64,
    ) -> Result<GitlabApprovals, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&[
            "projects",
            &project,
            "merge_requests",
            &iid_text,
            "unapprove",
        ])?;
        let value: GitlabApprovals = self
            .send_json(Method::POST, &url, &serde_json::json!({}))
            .await?;
        self.invalidate_mr(project_id, iid);
        Ok(value)
    }

    /// Numeric id of a user by exact username.
    ///
    /// Merge request creation takes user ids, while the UI collects names: a
    /// single bounded lookup per name resolves them, and an unknown name is
    /// reported instead of being dropped.
    pub async fn user_id(&self, username: &str) -> Result<Option<u64>, GitlabError> {
        let name = username.trim();
        if name.is_empty() {
            return Ok(None);
        }
        let mut url = self.endpoint(&["users"])?;
        url.query_pairs_mut().append_pair("username", name);
        let fetched = self.fetch(&url).await?;
        let users: Vec<GitlabUser> = decode(&fetched.body)?;
        Ok(users
            .into_iter()
            .find(|user| user.username.eq_ignore_ascii_case(name))
            .map(|user| user.id))
    }

    /// Edit the title and/or the description of a merge request.
    pub async fn update_merge_request(
        &self,
        project_id: u64,
        iid: u64,
        update: &MergeRequestUpdate,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        if update.is_empty() {
            return Err(GitlabError::configuration("aucun champ à modifier"));
        }
        let mut payload = serde_json::Map::new();
        if let Some(title) = update.title.as_ref() {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(GitlabError::configuration(
                    "le titre de la merge request ne peut pas être vide",
                ));
            }
            payload.insert(
                "title".to_owned(),
                serde_json::Value::String(trimmed.to_owned()),
            );
        }
        if let Some(description) = update.description.as_ref() {
            payload.insert(
                "description".to_owned(),
                serde_json::Value::String(description.clone()),
            );
        }
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text])?;
        let value: GitlabMergeRequest = self
            .send_json(Method::PUT, &url, &serde_json::Value::Object(payload))
            .await?;
        self.invalidate_mr(project_id, iid);
        Ok(value)
    }

    /// Close (`open = false`) or reopen a merge request.
    pub async fn set_merge_request_open(
        &self,
        project_id: u64,
        iid: u64,
        open: bool,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text])?;
        let payload = serde_json::json!({
            "state_event": if open { "reopen" } else { "close" }
        });
        let value: GitlabMergeRequest = self.send_json(Method::PUT, &url, &payload).await?;
        self.invalidate_mr(project_id, iid);
        Ok(value)
    }

    /// Convert a merge request to draft, or mark it ready.
    ///
    /// GitLab models the draft state as a `Draft:` title prefix: the toggle
    /// rewrites the title and keeps the original wording.
    pub async fn set_merge_request_draft(
        &self,
        project_id: u64,
        iid: u64,
        draft: bool,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        let current = self.merge_request(project_id, iid).await?;
        if current.is_draft() == draft {
            return Ok(current);
        }
        let stripped = strip_draft_prefix(&current.title);
        let title = if draft {
            format!("Draft: {stripped}")
        } else {
            stripped.to_owned()
        };
        self.update_merge_request(
            project_id,
            iid,
            &MergeRequestUpdate {
                title: Some(title),
                description: None,
            },
        )
        .await
    }

    /// Merge with an optional SHA guard.
    pub async fn merge_merge_request(
        &self,
        project_id: u64,
        iid: u64,
        input: &MergeRequestMerge,
    ) -> Result<GitlabMergeRequest, GitlabError> {
        let project = project_id.to_string();
        let iid_text = iid.to_string();
        let url = self.endpoint(&["projects", &project, "merge_requests", &iid_text, "merge"])?;
        let mut payload = serde_json::json!({
            "squash": input.squash,
            "should_remove_source_branch": input.should_remove_source_branch,
            "merge_when_pipeline_succeeds": input.merge_when_pipeline_succeeds,
        });
        if let Some(sha) = &input.sha {
            payload["sha"] = serde_json::Value::String(sha.clone());
            payload["sha_must_match"] = serde_json::Value::Bool(input.sha_must_match);
        }
        if let Some(method) = &input.merge_method {
            payload["merge_method"] = serde_json::Value::String(method.clone());
        }
        let merged: GitlabMergeRequest = self.send_json(Method::PUT, &url, &payload).await?;
        self.invalidate_mr(project_id, iid);
        Ok(merged)
    }

    /// Jobs of one pipeline.
    pub async fn pipeline_jobs(
        &self,
        project_id: u64,
        pipeline_id: u64,
        page: u32,
        per_page: u32,
    ) -> Result<Paged<GitlabJob>, GitlabError> {
        let project = project_id.to_string();
        let pipeline = pipeline_id.to_string();
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let mut url = self.endpoint(&["projects", &project, "pipelines", &pipeline, "jobs"])?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("per_page", &per_page.to_string())
                .append_pair("page", &page.max(1).to_string());
        }
        let fetched = self.fetch(&url).await?;
        let items: Vec<GitlabJob> = decode(&fetched.body)?;
        Ok(Paged {
            items,
            page: page.max(1),
            per_page,
            next_page: fetched.next_page,
            total: fetched.total,
            not_modified: fetched.not_modified,
            from_cache: fetched.from_cache,
        })
    }

    /// Retry one failed job (`POST /projects/:id/jobs/:job_id/retry`).
    ///
    /// GitLab answers with the new job; a token without the maintainer right
    /// gets a 403 that the command layer surfaces as the provider message.
    pub async fn retry_job(&self, project_id: u64, job_id: u64) -> Result<GitlabJob, GitlabError> {
        let project = project_id.to_string();
        let job = job_id.to_string();
        let url = self.endpoint(&["projects", &project, "jobs", &job, "retry"])?;
        let value: GitlabJob = self
            .send_json(Method::POST, &url, &serde_json::json!({}))
            .await?;
        self.invalidate_jobs(project_id);
        Ok(value)
    }

    /// Cancel one running job (`POST /projects/:id/jobs/:job_id/cancel`).
    pub async fn cancel_job(&self, project_id: u64, job_id: u64) -> Result<GitlabJob, GitlabError> {
        let project = project_id.to_string();
        let job = job_id.to_string();
        let url = self.endpoint(&["projects", &project, "jobs", &job, "cancel"])?;
        let value: GitlabJob = self
            .send_json(Method::POST, &url, &serde_json::json!({}))
            .await?;
        self.invalidate_jobs(project_id);
        Ok(value)
    }

    /// Fetch one page of a job trace. GitLab honours `Range` on traces; when
    /// it returns the full body instead, the client skips `offset` bytes.
    pub async fn job_log(
        &self,
        project_id: u64,
        job_id: u64,
        max_bytes: usize,
        offset: usize,
    ) -> Result<JobLog, GitlabError> {
        let project = project_id.to_string();
        let job = job_id.to_string();
        let url = self.endpoint(&["projects", &project, "jobs", &job, "trace"])?;
        let cap = max_bytes.clamp(4 * 1024, 4 * 1024 * 1024);
        let mut request = self
            .http
            .get(url.clone())
            .header(ACCEPT, HeaderValue::from_static("text/plain"))
            .header("PRIVATE-TOKEN", self.token_header());
        if offset > 0 {
            request = request.header(
                "RANGE",
                format!(
                    "bytes={offset}-{}",
                    offset.saturating_add(cap).saturating_sub(1)
                ),
            );
        }
        let response = request
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            let bytes = self.read_body(response).await?;
            let text = String::from_utf8_lossy(&bytes);
            return Err(GitlabError::from_status(status.as_u16(), &text));
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
        let text = String::from_utf8_lossy(&buffer).into_owned();
        let next_offset = overflow.then(|| offset.saturating_add(buffer.len()));
        Ok(JobLog {
            bytes: buffer.len(),
            truncated: overflow,
            text,
            source_url: url.to_string(),
            offset,
            next_offset,
        })
    }

    async fn send_json<B, T>(&self, method: Method, url: &Url, body: &B) -> Result<T, GitlabError>
    where
        B: serde::Serialize,
        T: DeserializeOwned,
    {
        if method == Method::GET {
            return Err(GitlabError::configuration(
                "send_json ne gère pas les lectures",
            ));
        }
        let response = self
            .http
            .request(method, url.clone())
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .header("PRIVATE-TOKEN", self.token_header())
            .json(body)
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        let status = response.status();
        let bytes = self.read_body(response).await?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            return Err(GitlabError::from_status(status.as_u16(), &text));
        }
        decode(&bytes)
    }

    fn invalidate_mr(&self, project_id: u64, iid: u64) {
        if let Some(cache) = &self.cache {
            let base = self.url.api_url.trim_end_matches('/');
            cache.remove_prefix(&format!(
                "{base}/projects/{project_id}/merge_requests/{iid}"
            ));
            cache.remove_prefix(&format!("{base}/projects/{project_id}/merge_requests"));
        }
    }

    /// Pipeline and job listings change when a job is retried or cancelled.
    fn invalidate_jobs(&self, project_id: u64) {
        if let Some(cache) = &self.cache {
            let base = self.url.api_url.trim_end_matches('/');
            cache.remove_prefix(&format!("{base}/projects/{project_id}/pipelines"));
            cache.remove_prefix(&format!("{base}/projects/{project_id}/jobs"));
        }
    }

    async fn post_json<B, T>(&self, url: &Url, body: &B) -> Result<T, GitlabError>
    where
        B: serde::Serialize,
        T: DeserializeOwned,
    {
        let response = self
            .http
            .post(url.clone())
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .header("PRIVATE-TOKEN", self.token_header())
            .json(body)
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        let status = response.status();
        let bytes = self.read_body(response).await?;
        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes);
            return Err(GitlabError::from_status(status.as_u16(), &text));
        }
        decode(&bytes)
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, GitlabError> {
        let mut url = Url::parse(&self.url.api_url).map_err(|error| {
            GitlabError::configuration(format!("Base API GitLab invalide : {error}"))
        })?;
        {
            let mut path = url.path_segments_mut().map_err(|_| {
                GitlabError::configuration("La base API GitLab ne peut pas recevoir de chemin.")
            })?;
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    fn projects_url(
        &self,
        page: u32,
        per_page: u32,
        search: Option<&str>,
    ) -> Result<Url, GitlabError> {
        let mut url = self.endpoint(&["projects"])?;
        let per_page_value = per_page.to_string();
        let page_value = page.to_string();
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("membership", "true")
                .append_pair("simple", "true")
                .append_pair("order_by", "last_activity_at")
                .append_pair("sort", "desc")
                .append_pair("per_page", &per_page_value)
                .append_pair("page", &page_value);

            if let Some(search) = search {
                let search = search.trim();
                if !search.is_empty() {
                    pairs.append_pair("search", search);
                }
            }
        }
        Ok(url)
    }

    async fn fetch(&self, url: &Url) -> Result<Fetched, GitlabError> {
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

                    if status == StatusCode::NOT_MODIFIED {
                        let Some(entry) = cached.as_ref().filter(|_| conditional.is_some()) else {
                            return Err(GitlabError::invalid_response(
                                "GitLab a répondu 304 sans requête conditionnelle valide.",
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
                            end_of_pages: meta.end_of_pages,
                            total: meta.total,
                            not_modified: false,
                            from_cache: false,
                        });
                    }

                    if retryable_status(status) && attempt < MAX_ATTEMPTS {
                        let delay = if status == StatusCode::TOO_MANY_REQUESTS {
                            retry_after_delay(response.headers())
                                .unwrap_or_else(|| self.backoff_delay(attempt, cache_key))
                        } else {
                            self.backoff_delay(attempt, cache_key)
                        };
                        debug!(
                            attempt,
                            delay_ms = delay.as_millis(),
                            status = status.as_u16(),
                            "Retrying GitLab request"
                        );
                        sleep(delay).await;
                        continue;
                    }

                    let body = self.read_body(response).await?;
                    let text = String::from_utf8_lossy(&body);
                    return Err(GitlabError::from_status(status.as_u16(), &text));
                }
                Err(error) => {
                    let classified = self.transport_error(&error);
                    if classified.retryable() && attempt < MAX_ATTEMPTS {
                        let delay = self.backoff_delay(attempt, cache_key);
                        debug!(
                            attempt,
                            delay_ms = delay.as_millis(),
                            "Retrying GitLab request after a transport error"
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
            GitlabError::network(&self.url.host, "Toutes les tentatives ont échoué.")
        }))
    }

    fn request(&self, url: &Url, etag: Option<&str>) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .get(url.clone())
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .header("PRIVATE-TOKEN", self.token_header());

        if let Some(etag) = etag {
            if let Ok(value) = HeaderValue::from_str(etag) {
                request = request.header(IF_NONE_MATCH, value);
            }
        }

        request
    }

    async fn read_body(&self, response: reqwest::Response) -> Result<Vec<u8>, GitlabError> {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| self.transport_error(&error))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(GitlabError::invalid_response(
                "La réponse GitLab dépasse la taille maximale autorisée.",
            ));
        }
        Ok(bytes.to_vec())
    }

    fn transport_error(&self, error: &reqwest::Error) -> GitlabError {
        let detail = error_chain(error);

        if error.is_timeout() {
            GitlabError::timeout(&self.url.host, detail)
        } else if looks_like_tls(&detail) {
            GitlabError::tls(&self.url.host, detail)
        } else if error.is_decode() {
            GitlabError::invalid_response(detail)
        } else if error.is_builder() {
            GitlabError::configuration(format!(
                "Impossible de construire la requête GitLab : {detail}"
            ))
        } else {
            GitlabError::network(&self.url.host, detail)
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
    fn new(token: &str) -> Result<Self, GitlabError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(GitlabError::configuration(
                "Le jeton d'accès GitLab est vide.",
            ));
        }
        HeaderValue::from_str(trimmed).map(Self).map_err(|_| {
            GitlabError::configuration("Le jeton d'accès GitLab contient des caractères interdits.")
        })
    }

    fn header(&self) -> HeaderValue {
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
    end_of_pages: bool,
    total: Option<u64>,
    not_modified: bool,
    from_cache: bool,
}

impl Fetched {
    fn from_cache(entry: &CachedResponse) -> Self {
        Self {
            body: entry.body.clone(),
            next_page: None,
            end_of_pages: false,
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
    end_of_pages: bool,
    total: Option<u64>,
}

impl ResponseMeta {
    fn from_headers(headers: &HeaderMap) -> Self {
        let next_header = headers
            .get("x-next-page")
            .and_then(|value| value.to_str().ok())
            .map(str::trim);

        Self {
            etag: headers
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            next_page: next_header
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|page| *page > 0),
            end_of_pages: matches!(next_header, Some("") | Some("0")),
            total: headers
                .get("x-total")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok()),
        }
    }
}

pub(crate) fn build_http_client(config: &GitlabConfig) -> Result<Client, GitlabError> {
    let mut builder = Client::builder()
        .timeout(config.timeout)
        .user_agent(USER_AGENT)
        .use_rustls_tls()
        // The token must never follow a redirect to another origin.
        .redirect(reqwest::redirect::Policy::none());

    if let Some(pem) = &config.ca_bundle_pem {
        if pem.is_empty() {
            return Err(GitlabError::invalid_ca(
                "Le certificat CA importé est vide.",
            ));
        }
        let certificates = reqwest::Certificate::from_pem_bundle(pem).map_err(|error| {
            GitlabError::invalid_ca(format!("Certificat CA illisible : {error}"))
        })?;
        if certificates.is_empty() {
            return Err(GitlabError::invalid_ca(
                "Le fichier ne contient aucun certificat CA.",
            ));
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }

    builder.build().map_err(|error| {
        GitlabError::configuration(format!("Client HTTP GitLab invalide : {error}"))
    })
}

fn is_fresh(entry: &CachedResponse, now: i64) -> bool {
    entry.expires_at.is_none_or(|expires_at| expires_at > now)
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
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

/// Title without a leading `Draft:` or `WIP:` marker.
///
/// GitLab stores the draft state in the title, so toggling it must not
/// accumulate prefixes: the marker is stripped whatever its casing.
fn strip_draft_prefix(title: &str) -> &str {
    let trimmed = title.trim_start();
    let lowered = trimmed.to_ascii_lowercase();
    for prefix in ["draft:", "wip:"] {
        if lowered.starts_with(prefix) {
            return trimmed[prefix.len()..].trim_start();
        }
    }
    trimmed
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, GitlabError> {
    serde_json::from_slice(body)
        .map_err(|error| GitlabError::invalid_response(format!("JSON inattendu : {error}")))
}

#[cfg(test)]
mod tests;
