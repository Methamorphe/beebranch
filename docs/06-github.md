# 06 — GitHub integration

## 1. Scope

GitHub is added alongside GitLab without replacing it. The two providers are
independent: separate sessions, tokens, OS keychains, and instance
identifiers. A repository can be associated with only one project from one
provider at a time; each provider's commands read only
the association that belongs to it.

Delivered features:

- connection to `github.com` or GitHub Enterprise Server (`/api/v3`);
- Personal Access Token stored in the OS keychain (`beebranch.github`);
- offline detection of a token already present in Git: configured helper
  (`osxkeychain`, GCM, `gh auth git-credential`), `url.*.insteadOf`, or
  `~/.git-credentials`; “Use my Git credentials” onboarding;
- listing and searching accessible repositories;
- automatic or manual repository ↔ project association;
- pull requests: my PRs, to review, assigned, project; details and creation;
- reviews: approvals, approval dismissal, review comments;
- CI checks attached to the PR head;
- GitHub Actions jobs from the latest run and bounded logs;
- PR/CI badge in the graph and clone selector.

## 2. URL and authentication

| Input | REST base | Web base |
|---|---|---|
| `https://github.com` | `https://api.github.com` | `https://github.com` |
| `https://api.github.com` | `https://api.github.com` | `https://github.com` |
| `https://github.example.com` | `https://github.example.com/api/v3` | `https://github.example.com` |

Rules:

- `https` required; `http` rejected (`github.insecure_url`);
- credentials in the URL rejected (`github.url_credentials`);
- query parameters and fragments rejected;
- headers `Authorization: Bearer <token>`, `Accept:
  application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`;
- validation through `GET /user`; a `401` emits `github://auth-expired`.

Recommended scopes: `repo`, `read:user`, `checks:read` (classic token) or,
for a fine-grained token, repository access with read-only *Contents*,
read/write *Pull requests*, read-only *Checks*, and *Metadata*.
The form opens the token creation page with these scopes prefilled.

### OAuth device flow (github.com)

BeeBranch can connect to github.com without a Personal Access Token through the
[device authorization grant](https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow):

1. the application requests a code from `POST https://github.com/login/device/code`
   (scopes `repo read:user`);
2. the frontend displays `userCode` and opens `verificationUri` in the browser;
3. it polls `github_device_flow_poll` at the `interval` rate; the backend
   exchanges the `device_code` for a token (`authorization_pending` and
   `slow_down` are handled internally);
4. the `gho_` token is validated through `GET /user`, stored in the OS keychain
   (`beebranch.github`), and never returned to the frontend.

The `device_code` stays on the backend (memory only); it alone would allow
obtaining the token. The button is offered only for `github.com`: GitHub
Enterprise Server requires an instance-specific OAuth App.

Client ID: the BeeBranch OAuth App's ID (**Device Flow enabled**) is
embedded in the binary — an OAuth client ID is public, and the device flow
uses no client secret. `BEEBRANCH_GITHUB_CLIENT_ID` (runtime
or build variable) can point to another OAuth App for a fork or
a local test.

### Reusing Git credentials

Like GitLab, BeeBranch queries `git credential fill` for the host of
the configured instance: a workstation authenticated through `gh auth login` (which installs
`gh auth git-credential`), the macOS OS keychain, or Windows Credential
Manager connects without a new Personal Access Token. The
request is local, limited to 5 s, and noninteractive (`GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`). The “Use my Git credentials” button follows
the same path without a prior instance. The token stays in Git: it is not
copied to the `beebranch.github` OS keychain, SQLite, or logs.

## 3. Endpoints used

| Usage | Endpoint |
|---|---|
| identity | `GET /user` |
| repositories | `GET /user/repos`; search `GET /search/repositories` |
| repository by ID | `GET /repositories/{id}` |
| repository PRs | `GET /repos/{o}/{r}/pulls?state=open` |
| cross-repository PRs | `GET /search/issues?q=is:pr is:open <filter>` |
| details | `GET /repos/{o}/{r}/pulls/{n}` |
| creation | `POST /repos/{o}/{r}/pulls` |
| checks | `GET /repos/{o}/{r}/commits/{sha}/check-runs` |
| general comments | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| review comments | `GET/POST /repos/{o}/{r}/pulls/{n}/comments` |
| thread reply | `POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies` |
| reviews | `GET/POST /repos/{o}/{r}/pulls/{n}/reviews` |
| approval dismissal | `PUT /repos/{o}/{r}/pulls/{n}/reviews/{id}/dismissals` |
| merge | `PUT /repos/{o}/{r}/pulls/{n}/merge` |
| Actions runs | `GET /repos/{o}/{r}/actions/runs?head_sha={sha}` |
| run jobs | `GET /repos/{o}/{r}/actions/runs/{id}/jobs` |
| job logs | `GET /repos/{o}/{r}/actions/jobs/{id}/logs` (signed redirect) |

Pagination through the `Link: rel="next"` header. Pages are capped at 100
items; the client stops as soon as no next link is present.

## 4. Shared data model

GitHub DTOs use exactly the GitLab shapes consumed by the UI:

| GitHub | Normalized field |
|---|---|
| PR number | `iid` |
| numeric repository ID | `projectId` |
| login | `author.username` |
| `open` status | `opened` |
| `mergeable: false` | `hasConflicts` |
| `mergeable_state` | `detailedMergeStatus` |
| check-runs | `headPipeline` / pipelines |
| Actions jobs | CI jobs |

`repositoryName` is added to cross-repository search results so that
the application can find the numeric identifier in the local cache.

## 5. REST API limitations

| Feature | Behavior |
|---|---|
| Resolving a thread | not exposed through REST; the UI hides “Resolve” |
| Auto-merge | GraphQL only; the UI hides the option and the API rejects it |
| Branch deletion on merge | repository setting; the option is hidden |
| Required approval count | not exposed by the basic review; displayed as unknown (0) |
| CI status in a PR list | not included in `GET /pulls`; loaded in the details |

These limitations are explicit (`github.unsupported`, `github.auto_merge_unsupported`,
`github.remove_branch_unsupported`) and never degrade the rest of
the application.

## 6. Cache, retries, and security

- Shared SQLite cache (`core::http_cache`) with `ETag` and `If-None-Match`.
- Bounded retries (3) on `429`, `5xx`, and `403` with exhausted quota
  (`x-ratelimit-remaining: 0`), deterministic backoff.
- No tokens in URLs, logs, SQLite, or errors; details
  are redacted (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
- TLS verified; internal CA can be imported; redirects not followed for
  authenticated requests.

## 7. Tests

- `crates/github`: URL normalization, remotes, model, errors, wiremock
  client (auth, `Link` pagination, PRs, checks, discussions, reviews, merge,
  jobs, logs, 304 cache).
- `crates/core`: `gh_` credentials and GitHub token redaction.
- `crates/store`: `provider` isolation for instances and associations.
- `crates/app`: Git credential selection for GitHub.
- `npm run ui:smoke`: navigation to “GitHub connection” and “Pull requests”.
