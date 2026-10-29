# ADR-0006 — React 19.3 + TypeScript + Vite

- **Status:** accepted
- **Date:** 2026-10-27
- **Decision makers:** project team

## Context

BeeBranch is a dense desktop application: history graph, diff, virtualized lists, resizable panels, GitLab. The frontend must be maintainable, testable, and able to host canvas rendering without imposing a heavy framework.

React has no LTS channel: the **Latest** channel is the recommended stable channel for user-facing applications, and versions follow SemVer ([React policy](https://react.dev/community/versioning-policy)). The stable version as of 2026-10-27 is **19.3**.

## Decision

1. Frontend in **React 19.3**, TypeScript in strict mode, **Vite** build.
2. No imposed UI kit at the outset: in-house components, design tokens.
3. The graph is rendered in **canvas**; React does not render one node per commit.
4. Business state stays in the Rust backend; React holds only presentation state.
5. Exact React, TypeScript, and Vite versions are pinned in the lockfile at scaffold time.

## Alternatives considered

| Alternative | Advantages | Disadvantages | Why rejected |
|---|---|---|---|
| Svelte 5 | Lighter bundle, simple reactivity | Smaller ecosystem, smaller hiring pool | No decisive gain since the graph is in canvas |
| SolidJS | Very fast on the DOM | More limited ecosystem and tooling | Maintenance risk |
| Vanilla TS | Full control | Structure and testing cost | Insufficient productivity |
| React 18 | Older, stable | No LTS, fewer features | No reason to start with an earlier version |

## Consequences

### Positive

- Mature ecosystem (virtualization, testing, tooling).
- Strict TypeScript and shared IPC typing.
- Easier hiring and maintenance.
- No dependency on a meta-framework.

### Negative

- React remains a dependency to track (infrequent major versions).
- Canvas rendering must be managed outside the React model.

### Risks

- **UI performance**: the risk is rendering, not React. Mitigation: canvas, virtualization, P0 measurement.
- **Dependency drift**: limit libraries, audit, pinned versions.

## Revision criteria

Revisit if P0 measurements show that React's rendering model is a bottleneck, or if the team cannot maintain the ecosystem. A framework change must not alter backend/IPC boundaries.
