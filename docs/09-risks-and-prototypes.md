# 09 — Risks, prototypes, and decisions

## 1. Risk register

| ID | Risk | Probability | Impact | Mitigation | Warning sign |
|---|---|---|---|---|---|
| R-01 | The graph does not achieve the expected smoothness | Medium | Very high | P0 canvas prototype + measurement; no late optimization | p95 frame > budget on 100k corpus |
| R-02 | CLI parsing is fragile | Medium | High | Machine formats, fixtures, contract tests, typed errors | a parser breaks on a real repository |
| R-03 | Line/hunk staging corrupts the index | Medium | Very high | Tested patch engine (CRLF, no-newline, renames), before/after verification | inconsistent `git diff` after staging |
| R-04 | Merge/rebase/conflicts produce incorrect states | Medium | Very high | Delegation to Git, preflight, tested abort/continue, fault injection | undetected intermediate state |
| R-05 | Self-hosted GitLab variants | High | Medium | Feature detection, tests on the 3 latest maintained versions, current endpoints | unexpected 404/403 in production |
| R-06 | Corporate TLS/proxy | Medium | High | Importable CA, explicit proxy, actionable messages | users blocked when connecting |
| R-07 | Scope creep | High | High | Closed P0–P3 scope, task sheets, scope review | feature outside the task sheet in a PR |
| R-08 | Tauri webview differences | Medium | Medium | 3-OS tests, canvas rendering, no exotic API | visual/perf bug on just one OS |
| R-09 | Undo causes data loss | Low | Very high | Matrix, preconditions, refusal by default, explicit irreversible actions | unreported partial restoration |
| R-10 | Executable repository configuration | Medium | Medium | Warning on opening, transparency, no implicit execution | unexpected filter/hook |
| R-11 | Unreliable process cancellation | Medium | Medium | Tests per OS, graceful then forced termination, revalidation | orphaned process |
| R-12 | Budgets unattainable with CLI | Medium | High | P0 baseline, documented decision, targeted `gix` if supported by evidence | scenario > budget after optimizations |
| R-13 | Excessive memory on large repositories | Medium | Medium | Bounded caches, pages, release on closing | RSS > budget on 100k |
| R-14 | Long-term maintenance | Medium | Medium | Few abstractions, docs, tests, ADR | growing complexity without need |
| R-15 | Token leak | Low | Very high | OS keychain, redaction, artifact tests | token in a log/export |
| R-16 | Loss of work through destructive action (no backup) | Medium | High | Strong confirmation, irreversibility displayed, no untracked file deleted | user surprised by a discard or a reset --hard |

## 2. Required prototypes (P0)

Each prototype answers a question and produces evidence. It is not a product: it may be discarded.

### SP-01 — Graph rendering

- **Question:** can canvas + virtualization + Rust lanes handle scrolling through 100k–1M commits with branches/merges?
- **Method:** `linear-100k`, `merges-deep`, `branches-5k` corpus; programmatic scrolling; measure frame p50/p95, frames > 50 ms, RSS.
- **Exit criterion:** provisional budget met or cause identified; lane algorithm validated on merges/octopus.
- **Fallback:** reduce visual features, revisit the rendering strategy, or revise the budget with evidence.

### SP-02 — CLI reads

- **Question:** are `status`, the first log page, diff, and refs fast enough through CLI?
- **Method:** isolated measurement of each command and parsing on the corpus; comparison with the budget.
- **Exit criterion:** table of measurements per scenario; explicit decision: keep CLI, optimize, or introduce `gix` on a specific path.
- **Fallback:** targeted `gix` for a read, with ADR and regression tests.

### SP-03 — Partial staging

- **Question:** can line/hunk patches be generated and applied reliably?
- **Method:** fixtures for CRLF, missing newline, rename, executable mode, Unicode, ambiguous context, empty patch; index verification before/after.
- **Exit criterion:** 100% of fixtures pass, no silent partial cases.
- **Fallback:** limit P1 to file/hunk staging and defer line staging, with an explicit decision.

### SP-04 — Interactive rebase

- **Question:** is todo injection through a helper reliable on all three OSes?
- **Method:** pick/reword/squash/drop plan, conflicts, abort, crash recovery.
- **Exit criterion:** correct todo, working reword/squash, manageable conflicts, no corrupted todo.
- **Fallback:** non-interactive rebase + separate message editing, in the meantime.

### SP-05 — Self-hosted GitLab

- **Question:** does the integration work with URL prefixes, internal CA, token, maintained versions, and tiers?
- **Method:** containerized test instance, three maintained versions, self-signed certificate, list/detail/diffs/creation/pipelines endpoints.
- **Exit criterion:** full workflow green, correctly mapped 401/403/404/429 errors, validated feature detection.
- **Fallback:** reduce MVP scope (list + open in browser) and schedule the rest.

### SP-06 — IPC and streaming

- **Question:** do pages and events stay within limits without degrading the UI?
- **Method:** 500/1000-item page, 50k-line diff, fetch with progress.
- **Exit criterion:** payload < 1 MiB, no UI thread blocking, working cancellation.
- **Fallback:** adjust page size, introduce a binary format if measurements show it is necessary.

### SP-07 — Crash and recovery

- **Question:** does a kill during fetch/commit/rebase leave an understandable and recoverable status?
- **Method:** kill -9 / TerminateProcess at controlled points; restart; check status and locks.
- **Exit criterion:** no file lost, intermediate state detected, no automatic lock deletion.
- **Fallback:** strengthen the journal, add a manual recovery panel.

## 3. What is not an acceptable risk

- Deleting an `index.lock` automatically.
- Disabling TLS to “make it work”.
- Putting a token in a URL or a log.
- Using `reset --hard` as a generic mechanism.
- Loading the entire history at startup.
- Executing a command through a shell.
- Marking a feature complete without a real test.
- Adding an abstraction “for later”.

## 4. Decisions

### 4.1 Settled decisions

| ID | Decision | Value | Date | Reference |
|---|---|---|---|---|
| D-01 | Frontend framework | **React 19.3 + TypeScript + Vite** | 2026-10-27 | [ADR-0006](adr/0006-react-frontend.md) |
| D-02 | Product name | **BeeBranch** | 2026-10-27 | [SPECIFICATION](SPECIFICATION.md) |
| D-03 | Minimum Git version | **2.34** (distro LTS floor), tests on 2.56.0 | 2026-10-27 | [ADR-0007](adr/0007-version-baseline.md) |
| D-04 | GitLab versions | **3 latest maintained** (19.3–19.5), no LTS | 2026-10-27 | [ADR-0007](adr/0007-version-baseline.md) |
| D-05 | Undo backups | **No application backups** | 2026-10-27 | [ADR-0008](adr/0008-no-application-backups.md) |
| D-13 | Visual identity | **Amber palette, `#FED100` accent, ergonomics inspired by established desktop Git clients** | 2026-10-27 | [10-design-direction](10-design-direction.md) |

### 4.2 Open decisions

| ID | Decision | Options | Recommendation | Impact |
|---|---|---|---|---|
| D-06 | Bare / shallow / partial repositories | support / refuse / read-only | read-only for shallow, refuse bare | Scope |
| D-07 | Update | built-in / package manager | signed built-in | Distribution |
| D-08 | Accessibility level | basic / WCAG 2.2 AA | AA on main views | Design, tests |
| D-09 | Local cache encryption | no / OS / app | no in MVP, documented | Complexity |
| D-10 | Local vs API MR diff | API / local ref | API in MVP, local ref later | Accuracy, perf |
| D-11 | Non-TLS HTTP | prohibit / allow with warning | prohibit | Security |
| D-12 | Telemetry | none / local opt-in | none | Trust |

Each decision made must be recorded in an ADR or in this table with its date.
