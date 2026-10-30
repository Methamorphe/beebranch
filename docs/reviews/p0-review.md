# P0 — Exit review

**Date:** 2026-10-27
**Measurement machine:** macOS 27 arm64 (Darwin 27.0.0), Rust 1.98.1, Git 2.55.0,
LTO release build.
**Decision:** **Conditional NO-GO** — two pieces of evidence are missing (real GitLab
instance, completed 3-OS CI matrix). The technical foundation is demonstrated and measured.

---

## 1. Deliverables

| Task | Status | Evidence |
|---|---|---|
| P0-T01 Scaffold, Tauri 2, CI | done | `cargo build`, window launched, `ci.yml` matrix |
| P0-T02 Git process layer | done | 73 lib tests + `tests/process_contract.rs` (11) |
| P0-T03 Discovery and session | done | 11 `repository_contract` tests (worktree, submodule, merge, rebase, detached, locks) |
| P0-T04 Read model | done | 9 `read_model` tests + parser unit tests |
| P0-T05 Virtualized graph | done | Rust lanes + canvas + PERF-02/03 measurements |
| P0-T06 Diff viewer | done | hunk/inline/split, caps, PERF-08 measurements |
| P0-T07 Self-hosted GitLab | done (live + mock) | real 19.2.9 instance + 45 wiremock tests, real OS keychain |
| P0-T08 Benchmark harness | done | deterministic corpus, PERF-01..12, baseline, CI/nightly |
| P0-T09 Errors and recovery | done | taxonomy, SQLite journal, recovery, redaction tests |
| P0-T10 Review | this document | — |

## 2. Checks run

```text
cargo fmt --all -- --check                       OK
cargo clippy --workspace --all-targets -- -D warnings   OK
cargo test --workspace                           OK (211+ tests)
npm run lint                                     OK (warnings React hooks, 0 errors)
npm run build                                    OK
cargo build -p beebranch                         OK
./target/debug/beebranch                         window opened, log “application state ready”, git=2.55.0
npm run build && node scripts/ui-smoke.mjs       graph 800 commits, diff 4,000 lines, captures 1440×900
cargo run -p beebranch-app --example live_gitlab real instance: /user, 90 projects, ETag 304, 401, keychain
```

The headless UI smoke test injects a deterministic mocked IPC layer (not the
backend), loads the production bundle in Chrome, opens the repository, displays
the graph, then status, then diff and writes
`docs/reviews/p0-graph.png`, `p0-status.png`, `p0-diff.png`. Measurements:
frame p50/p95 = 16.7 ms, 0 missed frames during scroll/initial display,
`graph.first-page` and `diff.first-paint` markers present, 4,000 lines
displayed through windowing without freezing the tab.

Real recovery test: `running` operation → restart → `interrupted`,
`index.lock` reported and **preserved**. Token-free diagnostics export
(assertion on `glpat-`, `PRIVATE-TOKEN`, OS keychain secret).

## 3. Measurements

Reduced CI set (`--all-reduced --runs 5 --warmup 2`):

| Scenario | Corpus | p50 | p95 | Max RSS | IPC bytes |
|---|---|---:|---:|---:|---:|
| PERF-01 opening | linear-10k | 118.3 ms | 120.7 ms | 9.1 MB | 166 KB |
| PERF-02 first graph page | linear-10k | 44.0 ms | 45.6 ms | 9.2 MB | 210 KB |
| PERF-03 append 10 pages | linear-10k | 442.2 ms | 455.8 ms | 12.0 MB | 2.10 MB cumulative |
| PERF-04 refs | branches-5k (reduced) | 57.1 ms | 59.3 ms | 12.2 MB | 236 KB |
| PERF-05 status | wide-200k (20k files) | 176.9 ms | 188.5 ms | 12.2 MB | 252 B |
| PERF-06 modified status | dirty-10k (2k files) | 15.6 ms | 26.2 ms | 12.2 MB | 279 KB |
| PERF-08 diff | diff-50k (5k lines in CI) | 15.6 ms | 15.7 ms | 12.9 MB | 721 KB |
| PERF-12 log search | linear-10k | 44.6 ms | 45.5 ms | 12.9 MB | 166 KB |
| PERF-09 worktree switching | worktrees (6) | 527.0 ms | 531.4 ms | 9.0 MB | 31 KB |
| PERF-11 idle repositories (200 ms) | worktrees (6) | 202 ms | 202 ms | 8.7 MB | — (CPU 5%) |

Measurements outside CI:

| Scenario | Corpus | p50 | p95 | Max RSS | IPC bytes |
|---|---|---:|---:|---:|---:|
| PERF-02 first graph page | linear-100k | 345.4 ms | 346.7 ms | 9.8 MB | 210 KB |
| PERF-03 append 10 pages | linear-1m | 38.3 s | 38.9 s | 12.4 MB | 2.11 MB cumulative |
| PERF-08 full diff | diff-50k (50k lines) | 45.8 ms | 46.9 ms | 17.7 MB | 725 KB |

Interpretation: memory remains bounded by pages (RSS < 18 MB on the tested
corpora, including 1M commits), but loading deep pages on 1M
commits costs ~3.8 s per page because of `git log --skip` (10 pages = 38 s).
This is not lane recomputation: lane state is preserved between
pages. This is a measured design issue, to address in P1/P3 (incremental
SHA/date cursor or targeted `gix` traversal, with before/after benchmarks).

The provisional budgets in `docs/06-performance.md` are replaced by
`crates/bench/baselines/ci.json` for the reduced set. The baseline is valid
for this machine; it must be recalibrated on the GitHub runner before
becoming blocking.

## 4. Prototype decisions

### SP-01 Graph — canvas + Rust lanes retained

- Canvas, fixed row height, overscan, no DOM node per commit.
- Lanes computed in Rust from parents; linear, merge, octopus,
  dead branch, pagination continuity tests.
- Accepted limitations: lane density is compressed to 42% of the width
  when there are very many; beyond 16,384 lanes, edges are
  aggregated and flagged (`overflow`).
- Decision: retain this rendering. No DOM/SVG fallback.

### SP-02 CLI reads — CLI retained

First page on 100k at 345 ms, opening 10k at 116 ms, status on 20k files at
197 ms: no evidence justifies `gix` in P0. The cost of deep skips is
documented above; it will be reassessed with a targeted measurement.

### SP-06 Diff — windowed rendering, in-house highlighting

- No freeze: only visible lines are rendered and highlighted; the
  backend caps at 6,000 total lines (4,000 per file), 100 files,
  4 MiB, with an explicit truncation banner.
- Measured payload: 725 KB for diff-50k, below the 1 MiB IPC limit.
- Decision: no highlighting library in P0; tokenizer bounded to the
  visible window. A library (Shiki/Highlight.js) would add nothing
  without a cost measurement on long lines.
- Headless UI measurement: 4,000 lines, `diff.first-paint` present, frame p95
  16.7 ms during rendering (mocked data, real bundle rendering).

### SP-05 GitLab — validated live and with mocks

Real self-hosted instance (anonymized, 19.2.9, public certificate):
`GET /user` → identity, 90 paginated projects, ETag cache (`304`), token
`[REDACTED]`, 401 → `auth.failed`, token-free SQLite and diagnostics, real macOS
OS keychain. Details: [p0-gitlab-live.md](p0-gitlab-live.md).

45 wiremock tests cover 200/304/401/403/404/429/5xx, retry, invalid PEM CA
and token absence in `Debug`. Still not exercised live: the
19.3–19.5 matrix, path prefix, internal CA.

## 5. Security

- Token only in the OS keychain; no SQLite table contains it
  (dump test), no frontend DTO exposes it, client and error
  `Debug` masks it.
- Centralized redaction (URL userinfo, `PRIVATE-TOKEN`, `Authorization`,
  `access_token`, `private_token`, `glpat-*`) applied to Git errors,
  operation details and exports.
- TLS verified; internal CA imported explicitly; no “ignore” mode.
- No `sh -c`; argv validated by allowlist; filtered environment.
- Diagnostics export tested without a token.
- Live: public TLS verified, token never in SQLite/logs/diagnostics,
  real OS keychain. Limitation: self-signed CA, path prefix and
  19.3–19.5 matrix not exercised (pilot instance on 19.2.9).

## 6. Residual risks and blockers

| ID | Item | Severity | Treatment |
|---|---|---|---|
| B-01 | Real instance validated on 19.2.9; 19.3–19.5 matrix, prefix and internal CA not exercised | Medium | Run SP-05 on 19.3/19.4/19.5 with a prefix and self-signed CA |
| B-02 | Windows/macOS/Linux CI matrix not run here | P0 blocking | Push the PR and check the 3 jobs |
| B-03 | Deep pages on 1M: ~3.8 s/page via `--skip` | High (P1/P3) | Incremental cursor or targeted `gix`, before/after measurement |
| B-04 | Baseline measured on this machine only | Medium | Recalibrate on `macos-latest` before blocking `--assert` |
| B-05 | Native Tauri capture unavailable (screen recording permission) | Low | Production bundle captures via headless Chrome with mocked IPC (`docs/reviews/p0-*.png`); native window and logs verified |
| B-06 | PERF-07 (staging) and PERF-10 (fetch) not measurable | Low | P1 features; scenarios declared as explicit errors |
| B-07 | Lanes > 16,384 aggregated | Low | Flagged in the graph; 5k-branch corpus does not saturate |
| B-08 | CRLF rendering: `\r` removed from display | Low | Readability choice, documented |

No unidentified critical risk. No lock is deleted, no
application backup is created (ADR-0008 followed).

## 7. Decision

**NO-GO for declaring P0 closed** until B-02 is cleared.
**Technical GO for starting P1** on local components (status, staging,
branches, sync), with B-03 scheduled before announcing 1M-commit support.
B-01 is cleared for P0 on a real instance; its “version
matrix / internal CA” part remains a non-blocking residual risk for P1.

Conditions for moving to GO:

1. Green CI jobs on all three OSes (frontend, Rust, Tauri smoke).
2. Baseline recalibrated on the CI runner or `--assert` limited to the reduced set
   with absolute budgets.
3. SP-05 completed on 19.3/19.4/19.5 before communicating self-hosted GitLab
   support beyond the pilot instance.

## 8. Fix from live evidence

Real validation revealed that `keyring` was compiled **without a backend**
(empty default features): `set` succeeded, `get` returned `NoEntry`.
Native features are now enabled per platform
(`apple-native`, `windows-native`, `sync-secret-service`); the macOS
OS keychain roundtrip is proven. Without this evidence, the GitLab token would never
have been persisted.

## 9. Decision updates

- No ADR hypothesis is invalidated: single CLI retained (ADR-0001), canvas
  retained (ADR-0003), REST v4 retained (ADR-0004), per-repository serialization
  retained (ADR-0005), no application backup (ADR-0008).
- The diff cap changes from 20,000 to 4,000 lines per file / 6,000
  total to meet ADR-0005's IPC < 1 MiB rule, without changing the
  decision.
