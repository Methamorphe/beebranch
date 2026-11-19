//! Azure DevOps REST client for Services and Server.
//!
//! The personal access token travels only in an `Authorization: Basic` header
//! (empty username, token as the password). It is never placed in a URL, a
//! log line or a `Debug` output. BeeBranch does not register an application:
//! the token belongs to the user, the same way a GitLab or GitHub PAT does.
//!
//! Idempotent requests retry up to three times on `429` and `5xx`.

use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine;
use beebranch_core::{now_unix, redaction, CachedResponse, ResponseCache};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, ETAG, IF_NONE_MATCH};
use reqwest::{Client, Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use tokio::time::sleep;

use crate::error::AzureError;
use crate::models::{
    pack_job, stable_id, AzureApprovals, AzureDiffRefs, AzureDiscussion, AzureFileChange, AzureJob,
    AzureJobStep, AzureNote, AzurePipeline, AzureProject, AzurePullRequest, AzureUser,
    AzureUserRef, JobLog, Paged,
};
use crate::pipeline::{normalize_build, normalize_record};
use crate::url::{normalize_url, NormalizedUrl};

pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
pub const MAX_PER_PAGE: u32 = 100;
/// Projects listed when building the repository picker. Each one is a request.
const MAX_PROJECTS: usize = 25;
const MAX_ATTEMPTS: usize = 3;
const API_VERSION: &str = "7.1";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str = concat!("BeeBranch/", env!("CARGO_PKG_VERSION"));

/// Configuration of one Azure DevOps organization or collection.
pub struct AzureConfig {
    pub base_url: String,
    /// Personal access token. Never logged or serialized.
    pub token: String,
    pub ca_bundle_pem: Option<Vec<u8>>,
    pub timeout: Duration,
}

impl fmt::Debug for AzureConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AzureConfig")
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepositoriesQuery {
    pub search: Option<String>,
    pub page: u32,
    pub per_page: u32,
}

impl RepositoriesQuery {
    pub fn new() -> Self {
        Self {
            search: None,
            page: 1,
            per_page: 50,
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

/// Address of one Git repository. API calls use the GUIDs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub id: u64,
    pub project_id: String,
    pub project_name: String,
    pub repository_id: String,
    pub name: String,
}

impl RepoRef {
    pub fn external_id(&self) -> String {
        format!("{}/{}", self.project_id, self.repository_id)
    }

    pub fn from_external(id: u64, external: &str, project_name: &str, name: &str) -> Option<Self> {
        let (project_id, repository_id) = external.split_once('/')?;
        if project_id.is_empty() || repository_id.is_empty() || repository_id.contains('/') {
            return None;
        }
        Some(Self {
            id,
            project_id: project_id.to_owned(),
            project_name: project_name.to_owned(),
            repository_id: repository_id.to_owned(),
            name: name.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestScope {
    CreatedByMe,
    AssignedToMe,
    ReviewsForMe,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestsQuery {
    pub repo: RepoRef,
    pub scope: PullRequestScope,
    pub page: u32,
    pub per_page: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePullRequest {
    pub title: String,
    pub source_branch: String,
    pub target_branch: String,
    pub description: String,
    pub draft: bool,
}

#[derive(Clone)]
pub struct AzureClient {
    http: Client,
    url: NormalizedUrl,
    token: Arc<RwLock<SecretToken>>,
    user_guid: Arc<RwLock<Option<String>>>,
    cache: Option<Arc<dyn ResponseCache>>,
    cache_ttl: Duration,
}

impl fmt::Debug for AzureClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AzureClient")
            .field("api_url", &self.url.api_url)
            .field("host", &self.url.host)
            .field("organization", &self.url.organization)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

impl AzureClient {
    pub fn new(config: AzureConfig) -> Result<Self, AzureError> {
        let url = normalize_url(&config.base_url)?;
        Ok(Self {
            http: build_http_client(&config)?,
            url,
            token: Arc::new(RwLock::new(SecretToken::new(&config.token)?)),
            user_guid: Arc::new(RwLock::new(None)),
            cache: None,
            cache_ttl: DEFAULT_CACHE_TTL,
        })
    }

    #[cfg(test)]
    fn for_test(base_url: &str, token: &str) -> Self {
        let url = NormalizedUrl {
            base_url: base_url.to_owned(),
            api_url: base_url.to_owned(),
            web_url: base_url.to_owned(),
            host: "127.0.0.1".to_owned(),
            organization: "contoso".to_owned(),
        };
        let config = AzureConfig {
            base_url: base_url.to_owned(),
            token: token.to_owned(),
            ca_bundle_pem: None,
            timeout: Duration::from_secs(5),
        };
        Self {
            http: build_http_client(&config).expect("test HTTP client"),
            url,
            token: Arc::new(RwLock::new(SecretToken::new(token).expect("token"))),
            user_guid: Arc::new(RwLock::new(None)),
            cache: None,
            cache_ttl: DEFAULT_CACHE_TTL,
        }
    }

    pub fn with_cache(mut self, cache: Arc<dyn ResponseCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    pub fn with_cache_ttl(mut self, ttl: Duration) -> Self {
        self.cache_ttl = ttl;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.url.base_url
    }

    pub fn api_url(&self) -> &str {
        &self.url.api_url
    }

    pub fn host(&self) -> &str {
        &self.url.host
    }

    pub fn organization(&self) -> &str {
        &self.url.organization
    }

    pub fn set_user_guid(&self, guid: &str) {
        if guid.is_empty() {
            return;
        }
        *self
            .user_guid
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(guid.to_owned());
    }

    pub fn user_guid(&self) -> Option<String> {
        self.user_guid
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Validate the token with `GET /_apis/connectionData`.
    pub async fn validate(&self) -> Result<AzureUser, AzureError> {
        let url = self.endpoint(&["_apis", "connectionData"])?;
        let body = self.send(Method::GET, &url, None).await?;
        let wire: WireConnection = decode(&body)?;
        let user = wire.into_user()?;
        *self
            .user_guid
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(user.guid.clone());
        Ok(user)
    }

    /// Repositories the token can see, paged after the projects have been read.
    pub async fn repositories(
        &self,
        query: RepositoriesQuery,
    ) -> Result<Paged<AzureProject>, AzureError> {
        let projects = self.team_projects().await?;
        let mut repos = Vec::new();
        for project in projects.into_iter().take(MAX_PROJECTS) {
            repos.extend(self.repositories_of(&project.id, &project.name).await?);
        }
        if let Some(search) = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let needle = search.to_ascii_lowercase();
            repos.retain(|repo| {
                repo.name.to_ascii_lowercase().contains(&needle)
                    || repo
                        .path_with_namespace
                        .to_ascii_lowercase()
                        .contains(&needle)
            });
        }
        repos.sort_by(|left, right| {
            left.path_with_namespace
                .to_ascii_lowercase()
                .cmp(&right.path_with_namespace.to_ascii_lowercase())
        });
        page_slice(
            repos,
            query.page.max(1),
            query.per_page.clamp(1, MAX_PER_PAGE),
        )
    }

    /// One repository addressed by its project and repository names.
    pub async fn repository_by_name(
        &self,
        project: &str,
        name: &str,
    ) -> Result<AzureProject, AzureError> {
        let url = self.project_endpoint(project, &["_apis", "git", "repositories", name])?;
        let body = self.send(Method::GET, &url, None).await?;
        let wire: WireRepository = decode(&body)?;
        wire.into_project(&self.url)
    }

    pub async fn pull_requests(
        &self,
        query: &PullRequestsQuery,
    ) -> Result<Paged<AzurePullRequest>, AzureError> {
        let mut url = self.repo_endpoint(&query.repo, &["pullrequests"])?;
        let top = query.per_page.clamp(1, MAX_PER_PAGE);
        let skip = top.saturating_mul(query.page.max(1).saturating_sub(1));
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("searchCriteria.status", "active");
            pairs.append_pair("$top", &top.to_string());
            pairs.append_pair("$skip", &skip.to_string());
            if matches!(query.scope, PullRequestScope::CreatedByMe) {
                if let Some(guid) = self.user_guid() {
                    pairs.append_pair("searchCriteria.creatorId", &guid);
                }
            }
            if matches!(
                query.scope,
                PullRequestScope::ReviewsForMe | PullRequestScope::AssignedToMe
            ) {
                if let Some(guid) = self.user_guid() {
                    pairs.append_pair("searchCriteria.reviewerId", &guid);
                }
            }
        }
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireList<WirePullRequest> = decode(&body)?;
        let items: Vec<_> = page
            .items()
            .into_iter()
            .filter_map(|pull| pull.into_public(&self.url, Some(query.repo.id)).ok())
            .collect();
        let next_page = if items.len() as u32 >= top {
            Some(query.page.max(1) + 1)
        } else {
            None
        };
        Ok(Paged {
            items,
            page: query.page.max(1),
            per_page: top,
            next_page,
            total: None,
            not_modified: false,
            from_cache: false,
        })
    }

    pub async fn pull_request(
        &self,
        repo: &RepoRef,
        iid: u64,
    ) -> Result<AzurePullRequest, AzureError> {
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}")])?;
        let body = self.send(Method::GET, &url, None).await?;
        let wire: WirePullRequest = decode(&body)?;
        wire.into_public(&self.url, Some(repo.id))
    }

    pub async fn create_pull_request(
        &self,
        repo: &RepoRef,
        request: &CreatePullRequest,
    ) -> Result<AzurePullRequest, AzureError> {
        let url = self.repo_endpoint(repo, &["pullrequests"])?;
        let payload = serde_json::json!({
            "sourceRefName": ref_name(&request.source_branch),
            "targetRefName": ref_name(&request.target_branch),
            "title": request.title,
            "description": request.description,
            "isDraft": request.draft,
        });
        let body = self
            .send(Method::POST, &url, Some(payload.to_string()))
            .await?;
        let wire: WirePullRequest = decode(&body)?;
        wire.into_public(&self.url, Some(repo.id))
    }

    /// Complete (merge) a pull request. `strategy` is `merge`, `squash` or `rebase`.
    pub async fn complete_pull_request(
        &self,
        repo: &RepoRef,
        iid: u64,
        source_sha: &str,
        strategy: &str,
        delete_source: bool,
    ) -> Result<AzurePullRequest, AzureError> {
        let merge_strategy = match strategy {
            "squash" => "squash",
            "rebase" => "rebase",
            _ => "noFastForward",
        };
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}")])?;
        let payload = serde_json::json!({
            "status": "completed",
            "lastMergeSourceCommit": { "commitId": source_sha },
            "completionOptions": {
                "deleteSourceBranch": delete_source,
                "mergeStrategy": merge_strategy,
                "squashMerge": strategy == "squash",
            }
        });
        let body = self
            .send(Method::PATCH, &url, Some(payload.to_string()))
            .await?;
        let wire: WirePullRequest = decode(&body)?;
        wire.into_public(&self.url, Some(repo.id))
    }

    pub async fn reviewers(&self, repo: &RepoRef, iid: u64) -> Result<AzureApprovals, AzureError> {
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}/reviewers")])?;
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireList<WireReviewer> = decode(&body)?;
        Ok(approvals_from(page.items()))
    }

    /// `vote` is `10` (approve), `0` (withdraw) or `-10` (reject).
    pub async fn set_vote(
        &self,
        repo: &RepoRef,
        iid: u64,
        vote: i32,
    ) -> Result<AzureApprovals, AzureError> {
        let guid = self.user_guid().ok_or_else(|| {
            AzureError::configuration("L'identité Azure DevOps n'est pas encore connue.")
        })?;
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}/reviewers/{guid}")])?;
        let payload = serde_json::json!({ "vote": vote, "id": guid });
        self.send(Method::PUT, &url, Some(payload.to_string()))
            .await?;
        self.reviewers(repo, iid).await
    }

    pub async fn discussions(
        &self,
        repo: &RepoRef,
        iid: u64,
    ) -> Result<Vec<AzureDiscussion>, AzureError> {
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}/threads")])?;
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireList<WireThread> = decode(&body)?;
        Ok(page
            .items()
            .into_iter()
            .filter_map(WireThread::into_public)
            .collect())
    }

    pub async fn create_discussion(
        &self,
        repo: &RepoRef,
        iid: u64,
        content: &str,
    ) -> Result<AzureDiscussion, AzureError> {
        let url = self.repo_endpoint(repo, &[&format!("pullrequests/{iid}/threads")])?;
        let payload = serde_json::json!({
            "comments": [{ "parentCommentId": 0, "content": content, "commentType": 1 }],
            "status": 1,
        });
        let body = self
            .send(Method::POST, &url, Some(payload.to_string()))
            .await?;
        let thread: WireThread = decode(&body)?;
        thread
            .into_public()
            .ok_or_else(|| AzureError::invalid_response("Le fil de discussion créé est vide."))
    }

    pub async fn reply(
        &self,
        repo: &RepoRef,
        iid: u64,
        thread_id: &str,
        content: &str,
    ) -> Result<AzureNote, AzureError> {
        let url = self.repo_endpoint(
            repo,
            &[&format!("pullrequests/{iid}/threads/{thread_id}/comments")],
        )?;
        let payload = serde_json::json!({
            "content": content,
            "parentCommentId": 1,
            "commentType": 1,
        });
        let body = self
            .send(Method::POST, &url, Some(payload.to_string()))
            .await?;
        let comment: WireComment = decode(&body)?;
        Ok(comment.into_note())
    }

    pub async fn builds_for_sha(
        &self,
        repo: &RepoRef,
        sha: &str,
        limit: u32,
    ) -> Result<Vec<AzurePipeline>, AzureError> {
        self.builds(repo, Some(sha), 1, limit)
            .await
            .map(|page| page.items)
    }

    pub async fn builds_page(
        &self,
        repo: &RepoRef,
        page: u32,
        per_page: u32,
    ) -> Result<Paged<AzurePipeline>, AzureError> {
        self.builds(repo, None, page, per_page).await
    }

    pub async fn build_jobs(
        &self,
        repo: &RepoRef,
        build_id: u64,
    ) -> Result<Vec<AzureJob>, AzureError> {
        let url = self.project_endpoint(
            &repo.project_id,
            &[
                "_apis",
                "build",
                "builds",
                &build_id.to_string(),
                "timeline",
            ],
        )?;
        let body = self.send(Method::GET, &url, None).await?;
        let timeline: WireTimeline = decode(&body)?;
        Ok(timeline
            .records
            .into_iter()
            .filter(|record| {
                record.record_type.as_deref() == Some("Job")
                    || record.record_type.as_deref() == Some("Task")
            })
            .filter(|record| record.record_type.as_deref() != Some("Task") || record.log.is_some())
            .filter_map(|record| record.into_job(build_id))
            .collect())
    }

    pub async fn build_log(
        &self,
        repo: &RepoRef,
        job_id: u64,
        max_bytes: usize,
        offset: usize,
    ) -> Result<JobLog, AzureError> {
        let (build_id, log_id) = crate::models::unpack_job(job_id);
        if build_id == 0 {
            return Err(AzureError::not_log());
        }
        let url = self.project_endpoint(
            &repo.project_id,
            &[
                "_apis",
                "build",
                "builds",
                &build_id.to_string(),
                "logs",
                &log_id.to_string(),
            ],
        )?;
        let body = self.send(Method::GET, &url, None).await?;
        let text = String::from_utf8_lossy(&body);
        let end = offset.saturating_add(max_bytes.max(1)).min(text.len());
        let start = offset.min(text.len());
        let slice = text.get(start..end).unwrap_or("");
        let truncated = end < text.len();
        Ok(JobLog {
            text: slice.to_owned(),
            truncated,
            bytes: slice.len(),
            source_url: url.as_str().to_owned(),
            offset: start,
            next_offset: if truncated { Some(end) } else { None },
        })
    }

    pub async fn diff_refs(&self, repo: &RepoRef, iid: u64) -> Result<AzureDiffRefs, AzureError> {
        let pull = self.pull_request(repo, iid).await?;
        let head = pull.sha.clone().unwrap_or_default();
        let base = pull.target_sha.clone().unwrap_or_default();
        if head.is_empty() || base.is_empty() {
            return Err(AzureError::invalid_response(
                "La pull request n'a pas de commits de comparaison.",
            ));
        }
        Ok(AzureDiffRefs {
            base_sha: base.clone(),
            start_sha: base,
            head_sha: head,
        })
    }

    pub async fn file_changes(
        &self,
        repo: &RepoRef,
        base: &str,
        head: &str,
    ) -> Result<Vec<AzureFileChange>, AzureError> {
        let mut url = self.project_endpoint(
            &repo.project_id,
            &[
                "_apis",
                "git",
                "repositories",
                &repo.repository_id,
                "diffs",
                "commits",
            ],
        )?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("baseVersion", base);
            pairs.append_pair("baseVersionType", "commit");
            pairs.append_pair("targetVersion", head);
            pairs.append_pair("targetVersionType", "commit");
        }
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireDiff = decode(&body)?;
        Ok(page
            .changes
            .into_iter()
            .filter_map(WireChange::into_file)
            .collect())
    }

    async fn builds(
        &self,
        repo: &RepoRef,
        sha: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> Result<Paged<AzurePipeline>, AzureError> {
        let mut url = self.project_endpoint(&repo.project_id, &["_apis", "build", "builds"])?;
        let top = per_page.clamp(1, MAX_PER_PAGE);
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("repositoryId", &repo.repository_id);
            pairs.append_pair("repositoryType", "TfsGit");
            pairs.append_pair("queryOrder", "queueTimeDescending");
            pairs.append_pair("$top", &top.to_string());
            if page > 1 {
                let token = top.saturating_mul(page - 1).to_string();
                pairs.append_pair("continuationToken", &token);
            }
            if let Some(sha) = sha {
                pairs.append_pair("sourceVersion", sha);
            }
        }
        let body = self.send(Method::GET, &url, None).await?;
        let list: WireList<WireBuild> = decode(&body)?;
        let items = list
            .items()
            .into_iter()
            .map(|build| build.into_pipeline())
            .collect::<Vec<_>>();
        let next_page = if items.len() as u32 >= top {
            Some(page.max(1) + 1)
        } else {
            None
        };
        Ok(Paged {
            items,
            page: page.max(1),
            per_page: top,
            next_page,
            total: None,
            not_modified: false,
            from_cache: false,
        })
    }

    async fn team_projects(&self) -> Result<Vec<WireProject>, AzureError> {
        let mut url = self.endpoint(&["_apis", "projects"])?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("$top", "100");
            pairs.append_pair("stateFilter", "wellFormed");
        }
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireList<WireProject> = decode(&body)?;
        Ok(page.items())
    }

    async fn repositories_of(
        &self,
        project_id: &str,
        project_name: &str,
    ) -> Result<Vec<AzureProject>, AzureError> {
        let url = self.project_endpoint(project_id, &["_apis", "git", "repositories"])?;
        let body = self.send(Method::GET, &url, None).await?;
        let page: WireList<WireRepository> = decode(&body)?;
        let mut items = Vec::new();
        for repo in page.items() {
            if repo.project.name.as_deref().unwrap_or(project_name) != project_name
                && repo.project.id.as_deref() != Some(project_id)
            {
                continue;
            }
            if let Ok(project) = repo.into_project(&self.url) {
                items.push(project);
            }
        }
        Ok(items)
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, AzureError> {
        self.project_endpoint("", segments)
    }

    fn project_endpoint(&self, project: &str, segments: &[&str]) -> Result<Url, AzureError> {
        let mut url = Url::parse(&self.url.api_url).map_err(|error| {
            AzureError::configuration(format!("Base API Azure DevOps invalide : {error}"))
        })?;
        {
            let mut path = url.path_segments_mut().map_err(|_| {
                AzureError::configuration(
                    "La base API Azure DevOps ne peut pas recevoir de chemin.",
                )
            })?;
            if !project.is_empty() {
                path.push(project);
            }
            for segment in segments {
                if !segment.is_empty() {
                    path.push(segment);
                }
            }
        }
        with_version(&mut url);
        Ok(url)
    }

    fn repo_endpoint(&self, repo: &RepoRef, tail: &[&str]) -> Result<Url, AzureError> {
        let mut segments = vec![
            "_apis".to_owned(),
            "git".to_owned(),
            "repositories".to_owned(),
            repo.repository_id.clone(),
        ];
        segments.extend(tail.iter().map(|segment| (*segment).to_owned()));
        let refs: Vec<&str> = segments.iter().map(String::as_str).collect();
        self.project_endpoint(&repo.project_id, &refs)
    }

    async fn send(
        &self,
        method: Method,
        url: &Url,
        json_body: Option<String>,
    ) -> Result<Vec<u8>, AzureError> {
        let cacheable = method == Method::GET && json_body.is_none();
        let cache_key = url.as_str();
        let cached = if cacheable {
            self.cache.as_ref().and_then(|cache| cache.get(cache_key))
        } else {
            None
        };
        let conditional = cached
            .as_ref()
            .filter(|entry| entry.expires_at.is_none_or(|expires| expires > now_unix()))
            .and_then(|entry| entry.etag.clone());

        let mut last_error = None;
        for attempt in 1..=MAX_ATTEMPTS {
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .header(ACCEPT, "application/json")
                .header(AUTHORIZATION, self.authorization());
            if let Some(etag) = conditional.as_deref() {
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(body) = json_body.as_deref() {
                request = request
                    .header("Content-Type", "application/json")
                    .body(body.to_owned());
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    if status == StatusCode::NOT_MODIFIED {
                        if let Some(entry) = cached.as_ref() {
                            return Ok(entry.body.clone());
                        }
                    }
                    if status.is_success() && status.as_u16() != 203 {
                        let etag = response
                            .headers()
                            .get(ETAG)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        let bytes = read_limited(response).await?;
                        if cacheable {
                            if let Some(cache) = &self.cache {
                                let now = now_unix();
                                let ttl = i64::try_from(self.cache_ttl.as_secs()).unwrap_or(300);
                                cache.put(
                                    cache_key,
                                    CachedResponse {
                                        etag,
                                        body: bytes.clone(),
                                        fetched_at: now,
                                        expires_at: Some(now.saturating_add(ttl)),
                                    },
                                );
                            }
                        }
                        return Ok(bytes);
                    }
                    let text = response.text().await.unwrap_or_default();
                    let error = AzureError::from_status(status.as_u16(), &text);
                    if error.retryable() && attempt < MAX_ATTEMPTS {
                        last_error = Some(error);
                        sleep(Duration::from_millis(200 * attempt as u64)).await;
                        continue;
                    }
                    return Err(error);
                }
                Err(error) => {
                    let mapped = if error.is_timeout() || error.is_connect() {
                        AzureError::network(self.host(), error.to_string())
                    } else {
                        AzureError::tls(self.host(), error.to_string())
                    };
                    if mapped.retryable() && attempt < MAX_ATTEMPTS {
                        last_error = Some(mapped);
                        sleep(Duration::from_millis(200 * attempt as u64)).await;
                        continue;
                    }
                    return Err(mapped);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| AzureError::network(self.host(), "requête interrompue")))
    }

    fn authorization(&self) -> HeaderValue {
        self.token
            .read()
            .map(|token| token.header())
            .unwrap_or_else(|poisoned| poisoned.into_inner().header())
    }
}

impl AzureError {
    fn not_log() -> Self {
        Self::new("azure.not_found", "Ce job Azure DevOps n'a pas de journal.")
    }
}

fn page_slice<T>(items: Vec<T>, page: u32, per_page: u32) -> Result<Paged<T>, AzureError> {
    let total = items.len() as u64;
    let start = (page.saturating_sub(1) as usize).saturating_mul(per_page as usize);
    let page_items: Vec<T> = items
        .into_iter()
        .skip(start)
        .take(per_page as usize)
        .collect();
    let next_page = if (start + page_items.len()) < total as usize {
        Some(page + 1)
    } else {
        None
    };
    Ok(Paged {
        items: page_items,
        page,
        per_page,
        next_page,
        total: Some(total),
        not_modified: false,
        from_cache: false,
    })
}

fn with_version(url: &mut Url) {
    let mut pairs = url.query_pairs_mut();
    pairs.append_pair("api-version", API_VERSION);
}

fn ref_name(branch: &str) -> String {
    if branch.starts_with("refs/") {
        branch.to_owned()
    } else {
        format!("refs/heads/{branch}")
    }
}

fn branch_name(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .unwrap_or(reference)
        .to_owned()
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, AzureError> {
    serde_json::from_slice(bytes).map_err(|error| AzureError::invalid_response(error.to_string()))
}

async fn read_limited(response: reqwest::Response) -> Result<Vec<u8>, AzureError> {
    let bytes = response.bytes().await.map_err(|error| {
        AzureError::invalid_response(format!("lecture de la réponse : {error}"))
    })?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(AzureError::invalid_response("réponse trop volumineuse"));
    }
    Ok(bytes.to_vec())
}

fn build_http_client(config: &AzureConfig) -> Result<Client, AzureError> {
    let mut builder = Client::builder()
        .timeout(config.timeout)
        .user_agent(USER_AGENT)
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pem) = &config.ca_bundle_pem {
        if pem.is_empty() {
            return Err(AzureError::invalid_ca("Le certificat CA importé est vide."));
        }
        let certificates = reqwest::Certificate::from_pem_bundle(pem).map_err(|error| {
            AzureError::invalid_ca(format!("Certificat CA illisible : {error}"))
        })?;
        if certificates.is_empty() {
            return Err(AzureError::invalid_ca(
                "Le fichier ne contient aucun certificat CA.",
            ));
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().map_err(|error| {
        AzureError::configuration(format!("Client HTTP Azure DevOps invalide : {error}"))
    })
}

#[derive(Clone)]
struct SecretToken(HeaderValue);

impl SecretToken {
    fn new(token: &str) -> Result<Self, AzureError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(AzureError::configuration(
                "Le jeton d'accès Azure DevOps est vide.",
            ));
        }
        if trimmed
            .chars()
            .any(|character| character.is_control() || character == ':')
        {
            return Err(AzureError::configuration(
                "Le jeton d'accès Azure DevOps contient des caractères interdits.",
            ));
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!(":{trimmed}"));
        HeaderValue::from_str(&format!("Basic {encoded}"))
            .map(Self)
            .map_err(|_| {
                AzureError::configuration(
                    "Le jeton d'accès Azure DevOps contient des caractères interdits.",
                )
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

#[derive(Debug, Deserialize)]
struct WireList<T> {
    value: Option<Vec<T>>,
}

impl<T> WireList<T> {
    fn items(self) -> Vec<T> {
        self.value.unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireConnection {
    authenticated_user: Option<WireIdentity>,
}

impl WireConnection {
    fn into_user(self) -> Result<AzureUser, AzureError> {
        let identity = self.authenticated_user.ok_or_else(|| {
            AzureError::invalid_response("connectionData ne contient pas d'utilisateur.")
        })?;
        identity.into_user()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIdentity {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    unique_name: Option<String>,
    #[serde(default)]
    provider_display_name: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
}

impl WireIdentity {
    fn into_user(self) -> Result<AzureUser, AzureError> {
        if self.id.trim().is_empty() {
            return Err(AzureError::invalid_response("identité sans id"));
        }
        let username = self
            .unique_name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.id.clone());
        let name = self
            .display_name
            .or(self.provider_display_name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| username.clone());
        Ok(AzureUser {
            id: stable_id(&self.id),
            username,
            name,
            avatar_url: self.image_url,
            guid: self.id,
        })
    }

    fn into_ref(self) -> AzureUserRef {
        let username = self
            .unique_name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.id.clone());
        let name = self
            .display_name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| username.clone());
        AzureUserRef {
            id: stable_id(&self.id),
            username,
            name,
            avatar_url: self.image_url,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProject {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRepository {
    id: String,
    name: String,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    remote_url: Option<String>,
    #[serde(default)]
    ssh_url: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    project: WireProjectRef,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProjectRef {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    last_update_time: Option<String>,
}

impl WireRepository {
    fn into_project(self, instance: &NormalizedUrl) -> Result<AzureProject, AzureError> {
        let project_name = self
            .project
            .name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "project".to_owned());
        let project_id = self
            .project
            .id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_default();
        if self.id.is_empty() || project_id.is_empty() {
            return Err(AzureError::invalid_response("dépôt sans identifiant"));
        }
        let external_id = format!("{project_id}/{}", self.id);
        let web_url = self.web_url.unwrap_or_else(|| {
            format!(
                "{}/{}/_git/{}",
                instance.web_url.trim_end_matches('/'),
                project_name,
                self.name
            )
        });
        Ok(AzureProject {
            id: stable_id(&external_id),
            name: self.name.clone(),
            path_with_namespace: format!("{project_name}/{}", self.name),
            web_url,
            ssh_url_to_repo: self.ssh_url,
            http_url_to_repo: self.remote_url,
            default_branch: self.default_branch.map(|value| branch_name(&value)),
            last_activity_at: self.project.last_update_time,
            description: None,
            external_id,
            project_name,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePullRequest {
    pull_request_id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    source_ref_name: String,
    #[serde(default)]
    target_ref_name: String,
    #[serde(default)]
    merge_status: Option<String>,
    #[serde(default)]
    created_by: Option<WireIdentity>,
    #[serde(default)]
    reviewers: Vec<WireReviewer>,
    #[serde(default)]
    last_merge_source_commit: Option<WireCommit>,
    #[serde(default)]
    last_merge_target_commit: Option<WireCommit>,
    #[serde(default)]
    creation_date: Option<String>,
    #[serde(default)]
    repository: Option<WireRepository>,
}

impl WirePullRequest {
    fn into_public(
        self,
        instance: &NormalizedUrl,
        project_id: Option<u64>,
    ) -> Result<AzurePullRequest, AzureError> {
        let repository = self.repository;
        let project_name = repository
            .as_ref()
            .and_then(|repo| repo.project.name.clone())
            .unwrap_or_default();
        let repo_name = repository
            .as_ref()
            .map(|repo| repo.name.clone())
            .unwrap_or_default();
        let web_url = if project_name.is_empty() || repo_name.is_empty() {
            instance.web_url.clone()
        } else {
            format!(
                "{}/{project_name}/_git/{repo_name}/pullrequest/{}",
                instance.web_url.trim_end_matches('/'),
                self.pull_request_id
            )
        };
        let state = match self.status.as_str() {
            "completed" => "merged",
            "abandoned" => "closed",
            _ => "opened",
        };
        let conflicts = self
            .merge_status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("conflicts"));
        let author = self
            .created_by
            .map(WireIdentity::into_ref)
            .unwrap_or(AzureUserRef {
                id: 0,
                username: "azure".into(),
                name: "Azure DevOps".into(),
                avatar_url: None,
            });
        let reviewers = self
            .reviewers
            .into_iter()
            .map(|reviewer| reviewer.identity.into_ref())
            .collect();
        Ok(AzurePullRequest {
            project_id,
            iid: self.pull_request_id,
            title: self.title,
            description: self.description.unwrap_or_default(),
            state: state.to_owned(),
            draft: self.is_draft,
            work_in_progress: self.is_draft,
            source_branch: branch_name(&self.source_ref_name),
            target_branch: branch_name(&self.target_ref_name),
            author,
            assignees: Vec::new(),
            reviewers,
            labels: Vec::new(),
            detailed_merge_status: self.merge_status.clone(),
            merge_status: self.merge_status,
            has_conflicts: conflicts,
            sha: self
                .last_merge_source_commit
                .as_ref()
                .map(|commit| commit.commit_id.clone()),
            web_url,
            updated_at: self.creation_date,
            user_notes_count: 0,
            head_pipeline: None,
            repository_name: if project_name.is_empty() {
                None
            } else {
                Some(format!("{project_name}/{repo_name}"))
            },
            target_sha: self.last_merge_target_commit.map(|commit| commit.commit_id),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommit {
    commit_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReviewer {
    #[serde(flatten)]
    identity: WireIdentity,
    #[serde(default)]
    vote: i32,
}

fn approvals_from(reviewers: Vec<WireReviewer>) -> AzureApprovals {
    let mut approved_by = Vec::new();
    let mut changes_requested_by = Vec::new();
    for reviewer in reviewers {
        let vote = reviewer.vote;
        let user = reviewer.identity.into_ref();
        if vote > 0 {
            approved_by.push(crate::models::AzureApproval { user });
        } else if vote < 0 {
            changes_requested_by.push(crate::models::AzureApproval { user });
        }
    }
    AzureApprovals {
        approvals_required: 0,
        approvals_left: 0,
        approved_by,
        changes_requested_by,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireThread {
    id: u64,
    #[serde(default)]
    comments: Vec<WireComment>,
}

impl WireThread {
    fn into_public(self) -> Option<AzureDiscussion> {
        let notes: Vec<_> = self
            .comments
            .into_iter()
            .filter(|comment| !comment.is_deleted.unwrap_or(false))
            .map(WireComment::into_note)
            .collect();
        if notes.is_empty() {
            return None;
        }
        Some(AzureDiscussion {
            id: self.id.to_string(),
            individual_note: notes.len() == 1,
            notes,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireComment {
    id: u64,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    comment_type: Option<String>,
    #[serde(default)]
    published_date: Option<String>,
    #[serde(default)]
    author: Option<WireIdentity>,
    #[serde(default)]
    is_deleted: Option<bool>,
}

impl WireComment {
    fn into_note(self) -> AzureNote {
        let system = self
            .comment_type
            .as_deref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("system"));
        AzureNote {
            id: self.id,
            body: self.content.unwrap_or_default(),
            author: self
                .author
                .map(WireIdentity::into_ref)
                .unwrap_or(AzureUserRef {
                    id: 0,
                    username: "azure".into(),
                    name: "Azure DevOps".into(),
                    avatar_url: None,
                }),
            created_at: self.published_date.clone(),
            updated_at: self.published_date,
            system,
            resolvable: false,
            resolved: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireBuild {
    id: u64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    source_branch: Option<String>,
    #[serde(default)]
    source_version: Option<String>,
    #[serde(default)]
    finish_time: Option<String>,
    #[serde(default)]
    start_time: Option<String>,
    #[serde(default)]
    definition: Option<WireDefinition>,
    #[serde(default, rename = "_links")]
    links: Option<WireLinks>,
}

impl WireBuild {
    fn into_pipeline(self) -> AzurePipeline {
        AzurePipeline {
            id: self.id,
            status: normalize_build(&self.status, self.result.as_deref()).to_owned(),
            detailed_status: self.definition.map(|definition| definition.name),
            ref_name: self.source_branch.map(|value| branch_name(&value)),
            sha: self.source_version,
            web_url: self.links.and_then(|links| links.web).map(|web| web.href),
            updated_at: self.finish_time.or(self.start_time),
        }
    }
}

#[derive(Debug, Deserialize)]
struct WireDefinition {
    name: String,
}

#[derive(Debug, Deserialize)]
struct WireLinks {
    web: Option<WireHref>,
}

#[derive(Debug, Deserialize)]
struct WireHref {
    href: String,
}

#[derive(Debug, Deserialize)]
struct WireTimeline {
    #[serde(default)]
    records: Vec<WireRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRecord {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "type")]
    record_type: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    start_time: Option<String>,
    #[serde(default)]
    finish_time: Option<String>,
    #[serde(default)]
    log: Option<WireLogRef>,
}

impl WireRecord {
    fn into_job(self, build_id: u64) -> Option<AzureJob> {
        let name = self.name.filter(|value| !value.is_empty())?;
        let log_id = self.log.as_ref().map(|log| log.id).unwrap_or(0);
        let status = normalize_record(self.state.as_deref().unwrap_or(""), self.result.as_deref());
        let started = parse_time(&self.start_time);
        let finished = parse_time(&self.finish_time);
        let duration = started
            .zip(finished)
            .map(|(start, end)| (end - start).max(0) as f64);
        Some(AzureJob {
            id: if log_id == 0 {
                pack_job(build_id, 0)
            } else {
                pack_job(build_id, log_id)
            },
            name: name.clone(),
            stage: self.record_type.unwrap_or_else(|| "Job".to_owned()),
            status: status.to_owned(),
            web_url: None,
            duration,
            created_at: self.start_time,
            finished_at: self.finish_time,
            steps: vec![AzureJobStep {
                name,
                status: status.to_owned(),
                conclusion: self.result,
            }],
        })
    }
}

fn parse_time(value: &Option<String>) -> Option<i64> {
    let text = value.as_deref()?;
    // ISO-8601 without a dependency: keep only a duration when both sides parse
    // as the same prefix length. A missing parse yields no duration.
    chrono_less(text)
}

fn chrono_less(value: &str) -> Option<i64> {
    // `2026-01-02T03:04:05Z` or with fractional seconds. Enough to subtract.
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let time = time.trim_end_matches('Z');
    let time = time.split('.').next().unwrap_or(time);
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next().unwrap_or("0").parse().ok()?;
    Some(
        year.saturating_mul(1_000_000)
            + month.saturating_mul(40_000)
            + day.saturating_mul(1_000)
            + hour.saturating_mul(60)
            + minute
            + second / 60,
    )
}

#[derive(Debug, Deserialize)]
struct WireLogRef {
    id: u64,
}

#[derive(Debug, Deserialize)]
struct WireDiff {
    #[serde(default)]
    changes: Vec<WireChange>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireChange {
    #[serde(default)]
    change_type: Option<String>,
    #[serde(default)]
    item: Option<WireItem>,
    #[serde(default)]
    original_path: Option<String>,
}

impl WireChange {
    fn into_file(self) -> Option<AzureFileChange> {
        let path = self.item.and_then(|item| item.path)?;
        let new_path = trim_path(&path);
        if new_path.is_empty() {
            return None;
        }
        let kind = self.change_type.unwrap_or_default().to_ascii_lowercase();
        let status = if kind.contains("delete") {
            "removed"
        } else if kind.contains("rename") {
            "renamed"
        } else if kind.contains("add") {
            "added"
        } else {
            "modified"
        };
        let old_path = self
            .original_path
            .map(|path| trim_path(&path))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| new_path.clone());
        Some(AzureFileChange {
            old_path,
            new_path,
            status: status.to_owned(),
        })
    }
}

fn trim_path(path: &str) -> String {
    path.trim_start_matches('/').to_owned()
}

#[derive(Debug, Deserialize)]
struct WireItem {
    path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const TOKEN: &str = "azure-pat-secret-value";

    fn client(server: &MockServer) -> AzureClient {
        AzureClient::for_test(&server.uri(), TOKEN)
    }

    #[tokio::test]
    async fn validates_with_basic_auth_and_hides_the_token() {
        let server = MockServer::start().await;
        let expected = base64::engine::general_purpose::STANDARD.encode(format!(":{TOKEN}"));
        Mock::given(method("GET"))
            .and(path_regex(".*/_apis/connectionData"))
            .and(query_param("api-version", "7.1"))
            .and(header("authorization", format!("Basic {expected}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "authenticatedUser": {
                    "id": "11111111-2222-3333-4444-555555555555",
                    "displayName": "Ada Lovelace",
                    "uniqueName": "ada@contoso.com"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let api = client(&server);
        let user = api.validate().await.expect("user");
        assert_eq!(user.username, "ada@contoso.com");
        assert_eq!(user.name, "Ada Lovelace");
        assert_eq!(
            api.user_guid().as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
        let rendered = format!("{api:?}");
        assert!(!rendered.contains(TOKEN));
        assert!(!rendered.contains(&expected));
    }

    #[tokio::test]
    async fn expired_token_is_auth_failed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let error = client(&server).validate().await.expect_err("401");
        assert_eq!(error.code(), "auth.failed");
        assert!(!format!("{error:?}").contains(TOKEN));
    }

    #[tokio::test]
    async fn lists_repositories_and_pull_requests() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(".*/_apis/projects$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "value": [{ "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "name": "Fabrikam" }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(".*/git/repositories$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "value": [{
                    "id": "99999999-8888-7777-6666-555555555555",
                    "name": "website",
                    "defaultBranch": "refs/heads/main",
                    "remoteUrl": "https://dev.azure.com/contoso/Fabrikam/_git/website",
                    "sshUrl": "git@ssh.dev.azure.com:v3/contoso/Fabrikam/website",
                    "webUrl": "https://dev.azure.com/contoso/Fabrikam/_git/website",
                    "project": { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "name": "Fabrikam" }
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(".*/pullrequests$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "value": [{
                    "pullRequestId": 12,
                    "title": "Add graph",
                    "description": "lanes",
                    "status": "active",
                    "isDraft": false,
                    "sourceRefName": "refs/heads/feature",
                    "targetRefName": "refs/heads/main",
                    "mergeStatus": "succeeded",
                    "createdBy": { "id": "1", "displayName": "Ada", "uniqueName": "ada" },
                    "reviewers": [],
                    "lastMergeSourceCommit": { "commitId": "abc" },
                    "lastMergeTargetCommit": { "commitId": "def" },
                    "repository": {
                        "id": "99999999-8888-7777-6666-555555555555",
                        "name": "website",
                        "project": { "name": "Fabrikam" }
                    }
                }]
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let page = api
            .repositories(RepositoriesQuery::new())
            .await
            .expect("repos");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].path_with_namespace, "Fabrikam/website");
        let repo = RepoRef::from_external(
            page.items[0].id,
            &page.items[0].external_id,
            "Fabrikam",
            "website",
        )
        .expect("ref");
        let pulls = api
            .pull_requests(&PullRequestsQuery {
                repo,
                scope: PullRequestScope::All,
                page: 1,
                per_page: 20,
            })
            .await
            .expect("pulls");
        assert_eq!(pulls.items[0].iid, 12);
        assert_eq!(pulls.items[0].state, "opened");
        assert_eq!(pulls.items[0].source_branch, "feature");
        assert!(pulls.items[0].web_url.contains("/pullrequest/12"));
    }
}
