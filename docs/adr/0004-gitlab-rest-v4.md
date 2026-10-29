# ADR-0004 — Self-hosted GitLab via REST v4 and PAT

- **Status:** accepted
- **Date:** 2026-10-27
- **Extends:** revision 1 GitLab integration, now required from P0/P1

## Context

The enterprise uses a self-hosted GitLab instance as its central platform. Integration cannot be a late addition: the first usable product must support cloning, tracking MRs, and viewing CI.

Constraints: varying versions, internal certificates, URLs with prefixes, pagination, rate limits, expired tokens, offline operation of local Git operations.

## Decision

1. Dedicated **REST v4** client (`/api/v4`), without a generic SDK.
2. Authentication using a **Personal Access Token** (`PRIVATE-TOKEN`), scopes `api` + `read_user`.
3. Token stored in the **OS keychain**, never in the frontend, logs, or remote URLs.
4. Connection validation via `GET /user`.
5. Current endpoints only:
   - MR diffs via `/merge_requests/:iid/diffs`;
   - no use of `/merge_requests/:iid/changes` (deprecated since GitLab 15.7).
6. Support for a **configurable trust authority** for internal certificates. TLS verification is never silently disabled.
7. Local cache with ETag/TTL; all local Git operations work offline; GitLab views display the last known data with a freshness indicator.
8. Feature detection rather than assuming version/tier: unavailable endpoints (Premium approvals, etc.) are cleanly disabled.
9. No `GitProvider` abstraction until a second provider is actually required.

## Consequences

- The client must handle URL prefixes, proxies, and internal CAs.
- Errors 401/403/404/409/422/429/5xx have an explicit mapping.
- GitLab mutations are not queued offline in the MVP.
- Compatibility is tested against the three latest maintained versions of GitLab self-managed (no LTS channel).

## Rejected alternatives

| Alternative | Reason |
|---|---|---|
| GraphQL | More powerful for batching, but a less stable surface and unnecessary complexity for the MVP scope. |
| Generic GitLab SDK | Broad dependency, opaque behavior, imposed versions. |
| Token in the HTTPS remote | Leak into `.git/config` and shell history. |
| Global TLS disabling | Unacceptable security risk. |

## Revision criteria

Revisit if the number of REST calls becomes a measured bottleneck (multi-project aggregation), or if GitLab requires an API migration. A switch to GraphQL should remain localized to the `gitlab` module.
