# P1 — Exit review

**Date:** 2026-10-27
**Version:** 0.2.0
**Decision:** Technical GO for P1. The P1-T14 human criterion remains open.

## 1. Delivered scope

| Area | Implementation | Tests |
|---|---|---|
| File/hunk/line staging | `crates/git/src/index.rs` | `crates/git/tests/p1_ops.rs` (line, hunk, CRLF, no-newline, unicode, mode, rename) |
| Commit/amend | `crates/git/src/commit.rs` | hook failure/success, missing identity, empty index, amend keep/replace |
| Branches | `crates/git/src/branches.rs` | preflight, unmerged, current, dirty checkout, upstream, comparison |
| Sync | `crates/git/src/sync.rs` | local bare remote, push, fetch, pull ff-only, force-with-lease policy |
| Merge/rebase/conflicts | `crates/git/src/history.rs` | conflict/resolution/continue, abort, session recovery, rejection of concurrent operations |
| Stash | `crates/git/src/stash.rs` | create/pop/drop, conflicting pop, recoverable SHA |
| Search | `crates/git/src/search.rs` | message/author/SHA, depth |
| GitLab | `crates/gitlab/src/models.rs`, `client.rs`, `pipeline.rs` | wiremock contract for list/creation/draft/422/pipelines, mapping of all statuses |
| Destructive | `crates/core/src/actions.rs`, SQLite journal | missing confirmation, incorrect input, reversible action |
| External tools | `crates/app/src/commands/tools.rs` | placeholders, paths, unsafe URL |
| Full workflow | `crates/git/tests/p1_workflow.rs` | branch → staging → commit → stash → push → conflicting merge → continue → fetch |

## 2. Checks run

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings   → OK
cargo test --workspace                                  → 269 tests OK
npm run lint                                            → 0 errors (React effect warnings)
npm run build                                           → OK
npm run ui:smoke                                        → OK
```

`ui:smoke` exercises the graph, diff, line selection, the
`index_unstage` call, and opening the P1 views.

Benchmarks:

```text
PERF-07 dirty-10k full, 3 runs: p50 35.3 ms, p95 48.5 ms
PERF-10 linear-10k full, 3 runs: p50 87.2 ms, p95 98.6 ms
```

The `PERF-07`/`PERF-10` entries are in `crates/bench/baselines/ci.json`
with absolute budgets (60/100 ms and 150/250 ms).

## 3. Gaps and risks

| Item | Status | Next step |
|---|---|---|
| P1-T14 human dogfooding | not run | apply `docs/reviews/p1-dogfooding.md` |
| `--all-reduced --assert` | PERF-05/06 exceed the baseline on this machine (machine factor, unchanged code) | recalibrate the baseline on the CI agent before blocking, as planned by B-04 |
| Sync cancellation | path implemented (SIGTERM + revalidation); no deterministic blocking-network test | add a fake slow Git helper in CI |
| HTTPS credential helper | delegation to existing Git helpers/SSH config, no token in URL/argv | application OS keychain helper if a real need is measured |
| Real GitLab MR | full HTTP contract + wiremock; P0 live instance already validated | run the creation flow on a test project |

## 4. Decision

- **GO** for using P1 on real repositories outside P2 operations.
- **NO-GO** for declaring the P1-T14 human exit criterion satisfied without the
  three planned developers.
