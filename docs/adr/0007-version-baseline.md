# ADR-0007 — Version baseline: stable React, Git 2.34+, maintained GitLab

- **Status:** accepted
- **Date:** 2026-10-27
- **Decision makers:** project team

## Context

The initial instruction was to “use the LTS version”. After verification:

- **React** has no LTS channel; the Latest channel is the recommended stable channel ([React policy](https://react.dev/community/versioning-policy)). Stable version: **19.3** as of 2026-10-27.
- **Git** has no LTS channel. The version depends on the distribution. Latest version: **2.56.0** (2026-09-28) ([git-scm](https://git-scm.com/)).
- **GitLab** has no LTS channel. Its official policy maintains only the **three latest monthly versions**; as of 2026-10-27: **19.5, 19.4, 19.3** ([maintenance](https://docs.gitlab.com/policy/maintenance/)).

Choosing “the latest version” would break workstations whose Git comes from the system, and self-hosted GitLab often lags behind the latest release.

## Decision

| Component | Reference | Detail |
|---|---|---|
| React | **19.3** | Latest channel, version pinned at scaffold time |
| TypeScript / Vite | Latest stable | Exact versions pinned in the lockfile |
| Git | **Floor 2.34**, target **2.56.0** | 2.34 = Ubuntu 22.04 LTS version; covers current LTS distributions. CI on 2.34 and 2.56.0, feature detection between the two. |
| GitLab | **19.3–19.5** as of 2026-10-27 | The three latest maintained versions. Target = latest stable. Tests on three versions, feature detection for older instances. |

Rules:

- No feature depends on a higher version without a fallback or explicit message.
- The detected version is displayed in diagnostics.
- Raising the floor (Git or GitLab) requires a revision ADR and a test campaign.

## Alternatives considered

| Alternative | Advantages | Disadvantages | Why rejected |
|---|---|---|---|
| Require latest Git 2.56 | Recent features | Breaks workstations with system Git | Incompatible with a heterogeneous fleet |
| Git 2.39 floor | Matches Debian 12 / RHEL 9 | Excludes Ubuntu 22.04 LTS | Too restrictive without knowing the fleet |
| GitLab 19.5 only | Simple tests | Does not reflect self-hosted reality | Too fragile |
| Wait for a GitLab “LTS” | — | It does not exist | Impossible |

## Consequences

### Positive

- Works on current LTS distributions.
- The client remains usable with a slightly outdated GitLab.
- Feature detection avoids version assumptions.

### Negative

- Larger Git/GitLab test matrix.
- Some recent features are not available everywhere.

### Risks

- **Fleet older than 2.34**: blocking message, documented update procedure.
- **GitLab older than 19.3**: disabled features, no overall failure.
- **Changes to GitLab policy**: review the floor at each major release.

## Revision criteria

Revisit if the minimum fleet changes, if GitLab changes its maintenance policy, or if a critical feature requires a newer version.
