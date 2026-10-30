# P0-T07 — Evidence from a real GitLab instance

**Date:** 2026-10-27
**Instance:** `https://gitlab.example.com/` (self-hosted, anonymized)
**Version:** GitLab **19.2.9** (`/api/v4/version`, `enterprise: false`)
**TLS:** valid public certificate (`ssl_verify_result=0`), no internal CA
**Identity:** `jdoe` (id 35)
**Token:** PAT read from a local `0600` file, never displayed or logged.

## Commands run

```bash
curl -sS https://gitlab.example.com/api/v4/version
# {"version":"19.2.9", ...}

cargo run -q -p beebranch-app --example live_gitlab
# GITLAB_URL / GITLAB_TOKEN_FILE override the default values

TEST_KEYCHAIN=1 cargo run -q -p beebranch-app --example live_gitlab
LIVE_KEYCHAIN=1 cargo run -q -p beebranch-app --example live_gitlab
```

The example exercises the **real application path**: URL normalization,
`GitlabClient`, `GET /user` validation, project pagination, ETag cache,
`configure` (validation + SQLite persistence + secret), `projects_page`
(project persistence), redacted `diagnostics` and OS keychain.

## Results

```text
normalized base=https://gitlab.example.com api=https://gitlab.example.com/api/v4 host=gitlab.example.com
debug=GitlabClient { api_url: "https://gitlab.example.com/api/v4", host: "gitlab.example.com", token: "[REDACTED]", ... }

user id=35 username=jdoe name=Jane Doe
projects first page items=40 next=Some(3) total=Some(90)
project detail id=149 path=example-group/example-app http_url_has_token=false
projects second call cached=true not_modified=true items=40
bad token code=auth.failed status=Some(401) retryable=false detail=Some(false)

configured connected=true instance=https://gitlab.example.com user=jdoe
projects_via_app_client items=90 total=Some(90)
projects_page persisted items=3 next=None
persisted instances=1 identity=jdoe projects_cached=3 secret_present=true
sqlite_contains_token=false sqlite_contains_private_token_header=false
diagnostics_contains_token=false diagnostics_contains_instance=true
bad_token code=auth.failed detail_has_token=false
keychain_roundtrip=true keychain_value_len=Some(15) keychain_cleaned=true

# with LIVE_KEYCHAIN=1: configure stores the PAT via KeychainStore
persisted instances=1 identity=jdoe projects_cached=3 secret_present=true
live_keychain_secret_cleaned=true
```

## Coverage

| T07 requirement | Result |
|---|---|
| Valid connection | `GET /user` → 200, identity `jdoe` |
| Invalid connection | 401 → `auth.failed`, non-retryable |
| Token absent from logs | Client/config `Debug` → `[REDACTED]` |
| Token absent from SQLite | Full dump → no `glpat-`, no `private-token` |
| Token absent from frontend/diagnostics | Export → no token |
| Token in the OS keychain | `configure` with `KeychainStore`: write, read, deletion verified |
| Pagination | 40 items, `X-Next-Page=3`, total 90 |
| ETag cache | Second call `cached=true`, `not_modified=true` |
| Token-free remote URLs | `http_url_has_token=false` |
| 401/403/404/409/422/429/5xx errors | Live 401; others covered by wiremock (45 tests) |
| TLS | Public certificate verified |
| Internal CA | Not exercised (instance with a public certificate) |
| URL prefix | Not exercised (instance at the root) |
| Versions 19.3–19.5 | Not exercised: instance on **19.2.9** |

## Limitations and next steps

- The real instance is on **19.2.9**, below the documented 19.3–19.5 target.
  The P0 endpoints (`/user`, `/projects`, `/projects/:id`) work, but the
  version matrix and advanced feature detection (approvals, pipelines)
  still need to be run on 19.3/19.4/19.5.
- Only one instance: path prefix and internal CA not validated live.
- Live 403/429/5xx were not deliberately triggered; the mapping is covered by
  wiremock.
- The OS keychain test secret was deleted immediately after reading.

## Conclusion

The connection demonstration, project listing/search, persistence and
token-absence checks are **cleared on a real instance**. The
GitLab 19.3–19.5 matrix and internal CA case remain documented residual
risks.
