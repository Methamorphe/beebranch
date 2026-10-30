# ADR-0003 — Measured performance and virtualized canvas rendering

- **Status:** accepted
- **Date:** 2026-10-27
- **Complements:** revision 1 performance strategy

## Context

Performance is a central reason for replacing the incumbent desktop client. Revision 1 proposed targets (1 M commits, opening < 1 s, 60 fps) without a corpus or methodology. These figures are not guarantees and do not necessarily represent real usage.

Tauri does not make an interface fast on its own: graph rendering, IPC volume, and loading policy determine the experience.

## Decision

1. **No structural optimization without measurement.** Budgets are set after the first reference campaign.
2. The campaign covers representative scenarios: cold opening, initial display, scrolling, many branches/merges, many files, status, partial staging, large diffs, repository switching, fetch/refresh, idle memory and CPU.
3. The corpus combines:
   - synthetic repositories generated and versioned by script;
   - real internal repositories, used only if available and anonymizable.
4. The graph is rendered in **canvas** (or equivalent) with strict virtualization, incremental loading, and topology calculated on the Rust side.
5. No IPC exchange per commit. Payloads are paginated and bounded.
6. Metrics and budgets are versioned; regressions are detected in CI on a fixed corpus.
7. Optimizations are ordered by evidence (profile, measurement), not intuition.

## Consequences

- Initial figures are explicitly marked **hypotheses**, replaced by the baseline.
- The graph prototype is a P0 deliverable, not an implementation detail.
- Budgets must tolerate CI machine variability (relative comparison, median/p95, multiple runs).
- A missed budget triggers a documented decision: optimize, reduce scope, or revise the architecture (ADR).

## Rejected alternatives

| Alternative | Reason |
|---|---|---|
| Arbitrary targets presented as guarantees | Unverifiable, risk of false confidence. |
| Benchmark only on 1 M commits | Does not represent real bottlenecks (branches, files, diffs, repository switching). |
| DOM/SVG with one node per commit | Memory and rendering cost incompatible with large histories. |
| Optimize first, measure later | Investment without prioritization. |

## Revision criteria

Revisit if canvas cannot provide the required accessibility, if the requested information density demands it, or if measurements show another dominant bottleneck.
