# 05 — Self-hosted GitLab integration

## 1. Scope

### MVP (P0/P1)

- Instance URL configuration (including path prefix).
- Personal Access Token authentication.
- Token storage in the OS keychain.
- Connection validation.
- Listing and searching accessible projects.
- SSH or HTTPS cloning.
- Automatic local repository ↔ GitLab project association.
- Merge request list.
- MR details.
- MR creation from a pushed local branch.
- Opening an MR in the browser.
- CI/CD pipeline status.
- MR/CI badge in the graph and branch view.

### After the MVP (P2)

- Inline comments and discussions.
- Approvals.
- Merge from the application.
- Pipeline history and job logs.
- Multi-repository dashboard.

### Out of scope

- Project creation, member management, instance settings.
- Import/export, wiki, snippets, releases.
- Multiple simultaneous instances per profile.
- Queued offline mutations.

## 2. Configuration and authentication

### URL normalization

| Input | API base | Web base |
|---|---|---|
| `https://gitlab.example.com` | `https://gitlab.example.com/api/v4` | `https://gitlab.example.com` |
| `https://example.com/gitlab` | `https://example.com/gitlab/api/v4` | `https://example.com/gitlab` |
| `https://example.com/gitlab/` | same, trailing slash removed | same |

Rules:

- `https` scheme required by default; `http` allowed only with an explicit warning and confirmation;
- no trailing slash;
- retain the path prefix;
- reject URLs containing credentials (`user:pass@`);
- never build an API URL through naive concatenation without encoding the segments.

### PAT

- Creation: `https://<instance>/-/user_settings/personal_access_tokens` (recent GitLab) or `/-/profile/personal_access_tokens` (older).
- Required scopes: `api` + `read_user`.
- Header: `PRIVATE-TOKEN: <token>`.
- Validation: `GET /user`; expected response: `id`, `username`, `name`, `avatar_url`.
- Token stored in the OS keychain: service `beebranch.gitlab`, account `<host>#<hash-url>`.
- Never in SQLite, logs, remote URLs, crash reports, or the frontend.
- Expiration: a `401` triggers `gitlab://auth-expired`; the user replaces the token; no automatic deletion.

### OAuth device flow (gitlab.com)

For `gitlab.com`, BeeBranch can connect without a Personal Access Token through
GitLab's device authorization grant (≥ 17.9):

1. `POST https://gitlab.com/oauth/authorize_device` with the Application ID and
   scopes `api read_user read_repository`;
2. the frontend displays the `user_code` and opens the `verification_uri` (the
   `verification_uri_complete` form, which prefills the code);
3. `gitlab_device_flow_poll` polls `POST /oauth/token`
   (`grant_type=device_code`) at the `interval` rate;
4. OAuth tokens are stored together in the OS keychain
   (`<host>#<instance>#oauth`, JSON) — the access token and refresh token are
   never returned to the frontend or logged.

GitLab access tokens expire after 2 h. A refresh token is retained and
renewed in the background two minutes before expiration
(`grant_type=refresh_token`, required rotation: the new refresh token
replaces the old one in the OS keychain). The GitLab client shares its token
cell, so rotation benefits all clones already held by
commands. If refresh fails, the session is invalidated (`gitlab://auth-expired`)
and the connection screen returns.

Build prerequisite: `BEEBRANCH_GITLAB_CLIENT_ID` (public Application ID of
the gitlab.com OAuth application, **public client**). A self-hosted instance
requires its own OAuth application: the built-in device flow is rejected
(`gitlab.device_flow_unavailable`), and the PAT / Git credential methods
remain available.

### Reusing Git credentials

A workstation where `git clone https://<instance>/…` works already has a
credential. BeeBranch detects it **without network access** at startup and on each
`gitlab_status` while no session is active:

| Source | Reading | Example |
|---|---|---|
| `git credential fill` for the instance host | the configured helper responds (macOS OS keychain, Windows Credential Manager, `gh auth git-credential`, …) | `username=oauth2` + `password=glpat-…` |
| `url.<base>.insteadOf` (global and system) | the rewrite base carries the credentials | `https://oauth2:glpat-…@gitlab.example.com/` |
| `store --file=<path>` helper | file specified by the configuration | `credential.helper = store --file=~/work/creds` |
| default `store` helper files | `$XDG_CONFIG_HOME/git/credentials`, `~/.git-credentials` | `https://oauth2:glpat-…@gitlab.example.com` |

The connection screen exposes “Use my Git credentials”: the instance URL
is sufficient; the helper is queried for that host, then the session is
validated through `GET /user`. No token is entered or copied.

Safety rules:

- helper queries are bounded (5 s), without terminal prompts
  (`GIT_TERMINAL_PROMPT=0`) and with `GCM_INTERACTIVE=never`: an interactive
  helper cannot block startup or open a window;
- the helper is queried only for the host of a known instance; without an
  instance, only the files above are scanned, and only a GitLab-shaped token
  (`glpat-`, `gloas-`, …) is used — a GitHub token is never
  mistaken for GitLab;
- only `https://user:password@host` entries with a password are
  retained; SSH and `http://` are ignored;
- an already configured instance accepts only the credential for **its** host;
- the token is not copied to the OS keychain or SQLite, or logged;
  the session indicates its source (`credentialSource`), and “Disconnect” is
  hidden: the secret remains managed by Git;
- HTTPS cloning uses this same credential for the matching host, through the
  existing `GIT_ASKPASS` helper (0600 temporary file, never in argv).

### TLS and network

- TLS verification always enabled.
- Internal CA: PEM import in settings, loaded in addition to the system trust store.
- Proxy: explicit support through settings (or standard environment variables), documented.
- TLS error: message containing the host, cause, and CA import procedure.
- No “ignore certificates” mode in the MVP.

```mermaid
sequenceDiagram
  participant U as User
  participant UI
  participant App
  participant KC as Keychain
  participant GL as GitLab

  U->>UI: URL + PAT
  UI->>App: gitlab_configure(url, token)
  App->>App: normalize the URL
  App->>GL: GET /user (PRIVATE-TOKEN)
  alt success
    GL-->>App: 200 {id, username}
    App->>KC: store the token
    App->>App: persist the instance (SQLite)
    App-->>UI: validated instance
  else 401
    GL-->>App: 401
    App-->>UI: auth.failed (invalid token)
  else TLS
    App-->>UI: tls.ca_required
  end
```

## 3. Projects and association

### Listing and search

```text
GET /projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&sort=desc
GET /projects?search=<q>&membership=true&simple=true&per_page=100
GET /groups/:id/projects?include_subgroups=true&per_page=100
```

- Pagination via `X-Next-Page`; stop on an empty page or the configured cap.
- `simple=true` to limit load.
- Local TTL cache (5 min); manual invalidation.
- The numeric `id` field is used for API calls; `path_with_namespace` for display.

### Repository ↔ project association

Sources of truth, in order of preference:

1. Exact match with `ssh_url_to_repo` or `http_url_to_repo`.
2. Normalized path (`path_with_namespace`) and host match.
3. Assisted manual association (filtered list).

Remote normalization:

| Form | Extraction |
|---|---|
| `git@host:group/project.git` | host, `group/project` |
| `ssh://git@host:2222/group/project.git` | host, port, path |
| `https://host/group/project.git` | host, path |
| `https://host/gitlab/group/project.git` | prefix + path |

- The SSH port and path prefix are taken into account.
- Subgroups are supported.
- The association is stored in SQLite and revalidated if the remote changes.
- A repository without an association remains fully usable; the UI offers “associate with a project”.

## 4. Cloning

### HTTPS

- Remote URL saved **without a token**.
- Credential helper provided by the application:
  - `git -c credential.helper= -c credential.helper=<helper> clone --progress <url> <path>`;
  - the helper reads the token from the OS keychain for the associated instance.
- No token in argv, URLs, or `.git/config`.
- If the helper fails: `auth.failed` with remediation.

### SSH

- Uses the existing agent and `~/.ssh/config`.
- No key generation or upload in the MVP.
- `Permission denied (publickey)` failure → message with a `ssh -T git@host` check.

### After cloning

- Open the repository session.
- Associate with the project.
- Offer submodule initialization if present (explicit action).

## 5. Merge requests

### List

```text
GET /projects/:id/merge_requests?state=opened&scope=<scope>&order_by=updated_at&sort=desc&per_page=50
GET /merge_requests?scope=created_by_me|assigned_to_me|reviews_for_me&state=opened&per_page=50
```

UI scopes:

- “My MRs”: `created_by_me`.
- “To review”: `reviews_for_me`.
- “Assigned”: `assigned_to_me`.
- “Project”: all open MRs in the current project.

Fields used: `iid`, `title`, `state`, `draft`, `source_branch`, `target_branch`, `author`, `assignees`, `reviewers`, `labels`, `detailed_merge_status`, `has_conflicts`, `sha`, `web_url`, `updated_at`, `user_notes_count`, `head_pipeline`.

### Details

```text
GET /projects/:id/merge_requests/:iid
GET /projects/:id/merge_requests/:iid/diffs?per_page=50&page=1
GET /projects/:id/merge_requests/:iid/pipelines
```

- Diffs come from `/diffs` (never `/changes`, deprecated since GitLab 15.7).
- Each entry contains `old_path`, `new_path`, `new_file`, `renamed_file`, `deleted_file`, `generated_file`, `diff`.
- The diff is unified text; the `crates/git` parser can be reused without running Git.
- `overflow` / `real_size`: display a warning if GitLab truncates the diff.
- Accuracy option: fetch `refs/merge-requests/<iid>/head` and calculate the diff locally. To be validated in P0; API fallback required.

### Creation

```text
POST /projects/:id/merge_requests
  source_branch, target_branch, title, description,
  remove_source_branch, squash, allow_collaboration
```

- The source branch must be pushed; otherwise, show an explicit message.
- Draft: `Draft:` prefix in the title (GitLab behavior).
- Description template: read the project template if available (P2).
- After creation: refresh the list, associate the MR with the branch, display the badge.

### Merge / approvals (P2)

```text
PUT /projects/:id/merge_requests/:iid/merge
    sha, squash, merge_when_pipeline_succeeds, should_remove_source_branch
POST /projects/:id/merge_requests/:iid/approve
GET  /projects/:id/merge_requests/:iid/approvals
```

- `approvals` is Premium/Ultimate: `403`/`404` → feature hidden, not an error.
- `405 Method Not Allowed`, `406 Not Acceptable`, `409 Conflict` → specific messages (conflict, pipeline required, already merged).
- The merge requires the current SHA to avoid a race.

### Discussions (P2)

```text
GET  /projects/:id/merge_requests/:iid/discussions
POST /projects/:id/merge_requests/:iid/discussions
     body, position[base_sha|start_sha|head_sha|old_path|new_path|new_line|old_line]
```

- Positions use the SHAs from `diff_refs`.
- A discussion can be resolved through `PUT .../discussions/:discussion_id?resolved=true`.

## 6. Pipelines and CI

```text
GET /projects/:id/merge_requests/:iid/pipelines
GET /projects/:id/pipelines/:pipeline_id
GET /projects/:id/pipelines/:pipeline_id/jobs?per_page=100
GET /projects/:id/jobs/:job_id/trace
```

- The MR exposes `head_pipeline`: `id`, `status`, `ref`, `sha`, `web_url`, `detailed_status`.
- Mapped statuses:

| GitLab | UI |
|---|---|
| `created`, `waiting_for_resource`, `preparing`, `pending` | pending |
| `running` | running |
| `success` | success |
| `failed` | failed |
| `canceled` | canceled |
| `skipped`, `manual`, `scheduled` | neutral / action required |
| unknown | unknown (do not hide) |

- Refresh: 30 s when the MR view is active and the window is in the foreground; paused otherwise; manual button.
- Job logs: P2, loaded on demand, truncated and paginated.

## 7. Cache, offline mode, and refresh

| Data | TTL | Invalidation |
|---|---|---|
| User identity | session | 401 |
| Project list | 5 min | manual, token change |
| MR list | 60 s (active view) | mutation, navigation |
| MR details | 60 s | same |
| Diffs | 5 min | new head SHA |
| Pipelines | 30 s (active) | end of operation |

- SQLite cache with `ETag`, `Last-Modified`, `fetched_at`, `body` (when the endpoint provides these headers; otherwise, TTL only).
- `If-None-Match`; `304` reuses the cache.
- Offline:
  - all local Git operations work;
  - GitLab views display the latest data with a “data from <date>” banner;
  - no GitLab mutations are queued;
  - network errors never block the repository tab.
- When back online: refresh active views, no request storm (backoff + jitter).

## 8. Errors, retries, and limits

| Code | Handling |
|---|---|
| `401` | invalid/expired token → auth event, no retry |
| `403` | insufficient scope or unavailable feature → message, feature off |
| `404` | resource deleted or access denied → remove from cache |
| `409` | conflict (merge, status) → message, refresh |
| `422` | validation (branch, title, source) → field message |
| `429` | `Retry-After` honored, backoff, no loop |
| `5xx` | retry GET with exponential backoff + jitter, capped |
| Network/TLS | classified message, no infinite retry |

- Retries only for **idempotent** requests (`GET`, `HEAD`).
- Maximum 3 attempts, 500 ms base delay, 8 s cap, jitter.
- No GitLab requests in the critical path of a local Git operation.

## 9. Local data model

```sql
gitlab_instances(
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  api_url TEXT NOT NULL,
  display_name TEXT,
  ca_bundle_id TEXT,
  created_at TEXT NOT NULL
)

gitlab_identity(
  instance_id TEXT PRIMARY KEY REFERENCES gitlab_instances(id),
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  validated_at TEXT NOT NULL
)

gitlab_projects(
  instance_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  path_with_namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  ssh_url TEXT,
  http_url TEXT,
  default_branch TEXT,
  last_activity_at TEXT,
  fetched_at TEXT NOT NULL,
  etag TEXT,
  PRIMARY KEY (instance_id, project_id)
)

repo_project_links(
  repo_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  match_kind TEXT NOT NULL,   -- url | path | manual
  verified_at TEXT NOT NULL
)

gitlab_cache(
  cache_key TEXT PRIMARY KEY,
  etag TEXT,
  body BLOB NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT
)
```

- The token does not appear in any table.
- Cache bodies may contain MR descriptions; storage is local and unencrypted in the MVP, documented.

## 10. Feature detection

| Feature | Detection |
|---|---|
| Approvals | `GET .../approvals` → 200 or 403/404 |
| Merge trains | project's `merge_trains_enabled` field |
| Job logs | `GET .../trace` → 200 |
| Positioned discussions | presence of `diff_refs` |
| Diffs | `/diffs` endpoint available |
| Version | `X-Gitlab-Version` header (if present) |

Unavailable features are hidden, never replaced with a blocking error.

## 11. Security

- Token in the OS keychain only; access through the backend.
- Headers and URLs redacted before any logging.
- No token values in error messages.
- TLS verified; CA explicitly imported.
- External links opened in the system browser through a scheme allowlist (`https`).
- GitLab data is never written to the repository.
- An instance URL change invalidates the association and cache; the token remains tied to the old URL until explicitly deleted.

## 12. Tests

| Type | Content |
|---|---|
| Unit | URL normalization, remote parsing, error mapping, pagination, feature detection |
| Contract | mocked client (local HTTP): 200/304/401/403/404/409/422/429/5xx |
| Integration | test GitLab instance (container): auth, projects, MRs, diffs, pipelines |
| Security | no tokens in logs, URLs, or errors |
| Offline | network disconnection: local Git OK, cached GitLab views, no queued mutations |
| TLS | self-signed CA accepted only if imported |
| Performance | load time for a list of 100 MRs, pagination, IPC size |
