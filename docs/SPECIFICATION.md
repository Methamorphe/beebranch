# BeeBranch — consolidated specification

> P0–P3 design document. To discover, install, and contribute to the
> project, see the [README](../README.md).

**Status:** P3 implemented and verified — evidence in [reviews/p3-review.md](reviews/p3-review.md). Human dogfooding remains to be carried out.
**Date:** 2026-10-27
**Product name:** BeeBranch
**Frontend:** React 19.3 + TypeScript + Vite
**Compatibility:** Git ≥ 2.34 (tested 2.55.0) / GitLab 19.3–19.5 (latest maintained versions) / GitHub.com and GitHub Enterprise Server (REST v3)
**Current scope:** P3 — polish: P2 + explicit undo/redo, branch/commit drag & drop, design system and density, streaming graph pages for large repositories, multi-repository workspaces, audited accessibility, signed distribution and signed updates/rollback.

---

## 1. Purpose

With **BeeBranch**, an open-source desktop Git client, provide an alternative
to commercial Git clients:

- **local-first**: Git is the source of truth; local work does not depend on any service;
- **fast and predictable**: measured performance, not assumed;
- **reliable**: no silent data loss, visible intermediate Git states;
- **integrated with self-hosted GitLab** from the first usable product;
- **maintainable**: a single Git engine, few abstractions, controlled scope;
- **no AI, no proprietary cloud, no intrusive telemetry, no vendor account**.

## 2. Key decisions

| Topic | Decision | ADR |
|---|---|---|
| Git engine | **Git CLI only** at the outset, centralized in a Rust module | [ADR-0001](adr/0001-git-cli-single-engine.md) |
| Undo / Redo | **Explicit** undo, limited to operations reversible by Git, **no application backups**; delivered in P3 | [ADR-0008](adr/0008-no-application-backups.md) |
| Performance | **Benchmark-first**: real corpora and scenarios, budgets derived from measurements, virtualized canvas rendering | [ADR-0003](adr/0003-benchmark-first-and-canvas.md) |
| GitLab | REST v4, PAT + OS keychain, non-deprecated endpoints, offline degradation | [ADR-0004](adr/0004-gitlab-rest-v4.md) |
| Concurrency / IPC | Mutations serialized per repository, streaming for long operations, no large IPC payloads | [ADR-0005](adr/0005-per-repo-serialization-and-ipc.md) |
| Frontend | **React 19.3** + TypeScript + Vite | [ADR-0006](adr/0006-react-frontend.md) |
| Editor | **CodeMirror 6**, lazily loaded, theme mapped onto the app CSS variables | [ADR-0009](adr/0009-codemirror-in-app-editor.md) |
| Versions | Stable React, Git ≥ 2.34 (distro LTS floor), GitLab's 3 latest maintained versions | [ADR-0007](adr/0007-version-baseline.md) |
| Visual identity | Ergonomics inspired by established desktop Git clients, **amber palette** (accent `#FED100`, variant `#F5BB45` in the P2 mockup), original assets | [10-design-direction](10-design-direction.md) |
| Worktrees | Repository identity and sessions **worktree-aware from P0**, full interface delivered in P2 | [01-product-scope](01-product-scope.md) |
| GitLab in the MVP | Required integration in P0/P1, not P2 | [01-product-scope](01-product-scope.md) |

## 3. Corrections applied to revision 1

| Initial decision | Correction | Impact |
|---|---|---|
| `gix` for reads + CLI for writes + occasional `git2` | Single CLI; `gix` only if a benchmark proves a significant gain | Removal of two engines and their divergences; initial reads to be measured |
| Undo through ref/index snapshots | Explicit matrix of operations reversible by Git, preconditions, **no application backups** | No more promise of universal undo; destructive actions are explicitly irreversible |
| Benchmark focused on 1 M commits | Suite of representative scenarios (branches, merges, files, diffs, repository switching, idle) | Optimizations are chosen based on evidence, not intuition |
| GitLab in a later phase | GitLab required in P0 (connection) and P1 (MR/CI workflow) | The first product is usable in enterprises |
| Worktrees only in P2 | Worktree-aware repository model from P0 | Avoids redesigning the session engine |
| Anticipated backend abstractions | No engine or provider abstraction before a real need | Less code, fewer tests, documented reversible decisions |

Revision 1 decisions **retained**: local-first, Tauri 2, virtualized canvas rendering, incremental loading, no tokens in the frontend, verified TLS, no AI/cloud/telemetry, GitLab REST v4, delegation of complex Git operations to Git.

### 3.1 Reference versions

| Component | Selected reference | Rationale |
|---|---|---|
| React | **19.3** (Latest channel) | React has no LTS channel; Latest is the recommended stable channel for user-facing applications ([React policy](https://react.dev/community/versioning-policy)). |
| TypeScript / Vite | Latest stable, exact version pinned at scaffold time | No LTS; versions frozen in the lockfile. |
| Git | **Floor 2.34**, target and tests on **2.56.0** | Git has no LTS channel; 2.34 is the version shipped by Ubuntu 22.04 LTS, covering current LTS distributions. Feature detection beyond that. |
| GitLab | **3 latest maintained versions** (19.3, 19.4, 19.5 as of 2026-10-27), target latest stable | GitLab has no LTS; its official policy maintains only the three latest monthly versions ([maintenance](https://docs.gitlab.com/policy/maintenance/)). Feature detection for older instances. |

## 4. Documentation index

| Document | Contents |
|---|---|
| [docs/01-product-scope.md](01-product-scope.md) | Goals, non-goals, principles, complete P0–P3 inventory, acceptance criteria |
| [docs/02-architecture.md](02-architecture.md) | Target architecture, crates, modules, Tauri boundaries, IPC, states, errors, security |
| [docs/03-git-engine.md](03-git-engine.md) | Git CLI engine: commands, parsing, streaming, cancellation, conflicts, worktrees, LFS |
| [docs/04-undo-redo.md](04-undo-redo.md) | Reversibility matrix, preconditions, storage, restoration, tests |
| [docs/05-gitlab.md](05-gitlab.md) | Authentication, endpoints, flows, cache, offline, TLS, errors, data model |
| [docs/06-github.md](06-github.md) | GitHub Cloud/Enterprise: authentication, endpoints, REST limits, provider separation |
| [docs/06-performance.md](06-performance.md) | Corpora, scenarios, metrics, instrumentation, budgets, governance |
| [docs/07-reliability-security.md](07-reliability-security.md) | Preflight, confirmations, crash recovery, threat model, secrets, TLS |
| [docs/08-roadmap.md](08-roadmap.md) | Phases, tasks, dependencies, Definition of Done, test strategy |
| [docs/09-risks-and-prototypes.md](09-risks-and-prototypes.md) | Risk register, required prototypes, open decisions |
| [docs/10-design-direction.md](10-design-direction.md) | Visual direction, density, benchmark-client inspiration, IP safeguards |
| [docs/tasks/](tasks/) | Task briefs ready to be assigned to an agent |
| [docs/releases/](releases/) | Release notes used by the update manifest |
| [docs/adr/](adr/) | Key decisions |

## 5. Distribution and updates

- Packaging via `npm run tauri build`; `release.yml` builds all three OSes and
  signs/notarizes when the `APPLE_*` and `TAURI_WINDOWS_CERTIFICATE` secrets
  exist. Since 0.5.1, the macOS Apple Silicon build is signed with
  `Developer ID Application`, notarized and stapled (app and DMG); releases
  are still produced locally. See [docs/releases/README.md](releases/README.md).
- `latest.json` and `rollback.json` are generated by
  `scripts/update-manifest.mjs` and `scripts/merge-manifests.mjs`.
- No telemetry: `npm run audit:telemetry` checks the sources.

### Installing a build (macOS, Apple Silicon)

1. Download the DMG from the latest release:
   <https://github.com/Methamorphe/beebranch/releases/latest>
   (`BeeBranch_<version>_aarch64.dmg`).
2. Open the DMG, drag `BeeBranch.app` into `/Applications`.
3. Since 0.5.1, the build is signed and notarized: Gatekeeper accepts it without
   a workaround. For an earlier version (not notarized), macOS kills the
   first launch (signal 9); choose either of two approaches:
   - System Settings → Privacy & Security → “Open Anyway”,
     then relaunch the application;
   - or in a terminal: `xattr -dr com.apple.quarantine /Applications/BeeBranch.app`.
4. Check: `/Applications/BeeBranch.app/Contents/MacOS/beebranch --version`
   must display `BeeBranch <version>`.

Published matrix: `darwin-aarch64` (signed and notarized), `linux-x86_64` and
`windows-x86_64` (optional OS signing). No macOS Intel build.
Usage prerequisite: Git ≥ 2.34. Subsequent updates are installed by
the application, after verifying the artifact's minisign signature.

## 6. Reading rules for a development agent

1. One task = one brief in `docs/tasks/`, a closed scope, one PR.
2. Do not expand the scope: any feature absent from the brief is out of scope.
3. Do not introduce unrequested abstractions (Git backend trait, plugin system, generic GitLab provider).
4. A feature is **not** complete just because the UI exists: acceptance criteria + tests + evidence of a real run.
5. Every performance claim must be accompanied by a reproducible measurement.
6. Every unverified hypothesis must remain marked `[HYPOTHESIS]` in code, tests, or documentation.

## 7. Decisions still open

See [docs/09-risks-and-prototypes.md §4](09-risks-and-prototypes.md). The main ones:

- support for bare, shallow, and partial clone repositories in the MVP;
- binary update and signing mechanism;
- target accessibility level;
- possible encryption of the local cache;
- MR diff calculated through the API or from the local ref;
- possible allowance of non-TLS HTTP;
- telemetry policy (none by default).

## 8. Getting started

Prerequisites: Rust ≥ 1.85, Node ≥ 22, Git ≥ 2.34, Tauri 2 system dependencies.

```bash
npm install
npm run tauri dev
```

P1 features available in the application:

- **Repositories**: open locally, clone from GitLab or a URL, create with `git init`
  in a new directory or an existing unversioned directory, with an optional
  initial branch.
- **Status**: staged/unstaged/untracked/conflicted files, stage/unstage
  file-hunk-line (interactive diff), confirmed discard, explicit ignore,
  external editor/merge tool.
- **Commit**: message, amend, displayed hooks, Git signing respected.
- **Branches & history**: create, checkout, rename, delete with
  name entry, upstream, comparison, merge/rebase, conflicts,
  continue/skip/abort.
- **Sync**: streamed fetch/pull/push, cancellation, explicit force-with-lease,
  progress and remote revalidation.
- **Stash**: create/list/apply/pop/drop, untracked by explicit choice,
  non-destructive conflicting pop.
- **Multi-repository**: tabs, isolated sessions, restored active tab.
- **Search**: message/author/SHA, stated depth, cancellation.
- **Graph**: filters, context menu, MR/CI badges, stash through all refs.
- **GitLab**: MR (my MRs, to review, assigned, project), details, creation,
  pipelines, CI badge, repository ↔ project association.
- **GitHub**: pull requests (my PRs, to review, assigned, project), details,
  creation, reviews and approvals, review comments, CI checks and Actions
  logs, repository ↔ project association. REST API limitations documented
  in [docs/06-github.md](06-github.md).
- **Tools**: editor, terminal, diff, merge detection/configuration.
- **Recovery**: operation journal, logged destructive actions, recovery
  after interruption.

Checks:

```bash
npm run lint
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Benchmarks:

```bash
# reduced set, blocking on regression (versioned baseline)
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --all-reduced \
  --runs 5 --warmup 2 \
  --out target/bench-report.json \
  --baseline crates/bench/baselines/ci.json --assert

# targeted P1 scenarios
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus dirty-10k \
  --scenario PERF-07 --runs 3 --warmup 1
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus linear-10k \
  --scenario PERF-10 --runs 3 --warmup 1

# 100k corpus, first graph page
cargo run -p beebranch-bench --release -- \
  --root target/bench-corpus --corpus linear-100k \
  --scenario PERF-02 --runs 3 --warmup 1 \
  --out target/bench-graph-100k.json
```

Current structure:

```text
crates/
  core/       shared types and UI contracts
  git/        Git process, index/commit/branches/sync/history/stash/search, lanes
  gitlab/     REST v4 client, URL/CA, ETag cache, remote matching
  github/     REST v3 client, GitHub Cloud/Enterprise, checks, Actions, remotes
  store/      SQLite (journal, cache, preferences) and keychain
  app/        Tauri shell: typed commands, setup, logging, recovery
  bench/      deterministic corpus, PERF scenarios, reports and thresholds
src/
  components/ reusable components
  hooks/      presentation hooks
  data/       static UI data
  styles/     tokens and global styles
src-tauri/    Tauri bootstrap and configuration
```

To regenerate the icons after modifying the logo:

```bash
npm run tauri icon assets/beebranch.svg
```
