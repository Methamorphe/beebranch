# 01 — Product scope and feature inventory

## 1. Objective

Build **BeeBranch**, a professional, local-first desktop Git client for the company's developers, replacing GitKraken for daily use and integrated with the self-hosted GitLab instance.

The product must be:

- **fast**: low perceived latency, smooth rendering, controlled startup;
- **reliable**: the repository's actual status always visible, no silent loss;
- **dense**: plenty of useful information without visual overload;
- **predictable**: actions do what they say, errors are actionable;
- **maintainable**: a single Git engine, bounded scope, few abstractions.

## 2. Users and context

| Item | Value |
|---|---|
| Users | Company developers, from junior to expert |
| Platforms | Windows, macOS, Linux |
| Hosting | Self-hosted GitLab, internal URLs and certificates |
| Network | May be restricted; Git must work offline |
| Repositories | Monorepos, many files, many branches, submodules, worktrees, LFS |
| UI language | French and English, selectable in Settings (typed i18n, FR/EN) |

## 3. Product principles

1. **Local-first.** Git is the source of truth. No core Git feature depends on GitLab or an account.
2. **No silent destructive actions.** Confirmation, explicit consequences, preflight.
3. **Actual status before aesthetics.** A repository with conflicts, a rebase in progress, or a detached HEAD must be obvious.
4. **Controlled density.** Important information is visible; noise can be hidden (hide/solo, filters).
5. **Keyboard first, mouse second.** Every frequent action has a shortcut and a command palette.
6. **No false promises.** A feature only exists if its behavior is real, tested, and verified.
7. **Native contextual integration.** GitLab is a first-class citizen, not a plugin.
8. **No vendor dependency.** No AI, no proprietary cloud, no intrusive telemetry, no required login.
9. **Distinct identity.** Ergonomics and density inspired by GitKraken, but no GitKraken assets, icons, logos, exact palette, or brand elements are copied.

## 4. Non-goals

- Exhaustive reproduction of GitKraken.
- Copying GitKraken's assets, icons, logos, fonts, or exact palette.
- Integrated code editor.
- Locally executed CI/CD.
- Multi-provider account management (GitHub, Bitbucket, Azure) in the MVP.
- AI features, code suggestions, MCP.
- Cloud team dashboards, Insights, Automations, Codemaps.
- Managing multiple GitLab instances per profile in the MVP (one active instance at a time).
- Supporting bare repositories as working repositories in the MVP.

## 5. Definitions

| Term | Definition |
|---|---|
| **Repository session** | Backend context associated with an open worktree: watcher, cache, mutation queue, Git status. |
| **Operation** | Tracked Git invocation: identifier, command, duration, output, exit code, possible cancellation. |
| **Git status** | Structural status: normal, merge, rebase, cherry-pick, revert, bisect, detached, unborn, conflict. |
| **Mutation** | Operation that modifies refs, index, or working tree. Serialized per repository. |
| **Preflight** | Checks before mutation (cleanliness, upstream, conflicts, overwritten files). |
| **Irreversible action** | Operation that cannot be undone by Git (discard, `reset --hard`, stash drop); confirmation required. |
| **Baseline** | Measured reference result for a performance scenario. |

## 6. Prioritized feature inventory

Each feature is considered **unfinished** until:

- actual behavior is implemented (not just the UI);
- acceptance criteria are covered by automated tests or documented run evidence;
- error cases and intermediate states are handled;
- performance meets the associated scenario's budget, if one exists.

### P0 — Foundations and technical validation

Objective: demonstrate the riskiest components and set budgets.

| ID | Feature | Acceptance criteria | Depends on |
|---|---|---|---|
| P0-01 | Tauri 2 application shell | Launch on Windows/macOS/Linux; persisted preferences; structured logs; error boundary; no network telemetry | — |
| P0-02 | Secure Git CLI engine | No commands through a shell; explicit argv; captured `stdout/stderr/exit code`; cancellation; per-repository mutation queue; typed errors; integration tests on real repositories | P0-01 |
| P0-03 | Repository opening and session | Open via picker, path, recents; worktree/submodule/bare detection; path validation; clean session creation and destruction; invalid repository → actionable error | P0-02 |
| P0-04 | Basic read model | Refs, status, log page, commit details, diff; consistency after external changes; pagination; no implicit full loading | P0-02 |
| P0-05 | Virtualized graph prototype | Canvas rendering; correct topology on merge fixtures; 200k commits loaded in pages; measured smooth scrolling; bounded memory; no regression when switching repositories | P0-04 |
| P0-06 | Diff viewer prototype | Hunk/inline/split modes; syntax highlighting; hunk navigation; cap on large files; display time measurement | P0-04 |
| P0-07 | Self-hosted GitLab connection | URL + prefix, PAT, OS keychain, `GET /user`, internal CA, project list, explicit network/TLS/token errors | P0-01 |
| P0-08 | Benchmark harness | Generated synthetic corpus; defined scenarios; reproducible report; versioned baseline; CI run | P0-02, P0-04, P0-05, P0-06 |
| P0-09 | Errors and recovery | Error taxonomy; intermediate state detection; recovery screen after a crash; no hidden unknown state | P0-02, P0-03 |

**P0 exit criterion:** technical demonstration on at least two real repositories and one synthetic corpus, with published measurements, reproducible errors handled, and no identified blocker for the graph, diff, GitLab, or recovery.

### P1 — First usable replacement

Objective: a developer completes their daily workflow without returning to GitKraken.

| ID | Feature | Acceptance criteria | Depends on |
|---|---|---|---|
| P1-01 | Interactive graph | Commit/branch selection; context actions (checkout, create branch, compare, copy SHA); basic filters; MR badge; refresh after mutation | P0-05 |
| P1-02 | Working tree status | Staged/unstaged/untracked/ignored/conflicted files; renames; external change detection; no blocking UI wait | P0-04 |
| P1-03 | File/hunk/line staging | Stage/unstage/discard by file, hunk, and line; handle CRLF, missing final newline, renames; confirmed discard; consistent index after every action | P1-02 |
| P1-04 | Commit and amend | Message, amend, hook execution, output display, refusal if a hook fails, signing respected; no silent bypass | P1-03 |
| P1-05 | Local and remote branches | Create, checkout, rename, delete with preflight, upstream, comparison; unmerged branch → strong confirmation | P1-01 |
| P1-06 | Fetch / pull / push | Streamed progress; cancellation; `force-with-lease` only with confirmation; actionable auth/SSH/non-fast-forward errors | P1-05 |
| P1-07 | Standard merge and rebase | Preflight; merge/rebase with and without conflicts; `--abort`/`--continue`; visible intermediate state; never lose local work | P1-05 |
| P1-08 | Conflicts — basic level | Conflicted file list; open in external editor; mark resolved; abort/continue; consistent status after restart | P1-07 |
| P1-09 | Stash | Create, list, apply, pop, drop; stash visible in the graph; pop conflicts reported | P1-02 |
| P1-10 | Multiple repositories | Independent tabs; isolated sessions; fast switching without memory leaks or crossed state | P0-03 |
| P1-11 | Commit search | Message, SHA, author; paginated results; explicit depth; no blocking on large histories | P1-01 |
| P1-12 | GitLab — MR listing and creation | Filtered list (my MRs, to review, assigned), minimal details, creation from a pushed branch, open in browser | P0-07 |
| P1-13 | GitLab — CI status and MR badge | Pipeline status on the MR and in the graph; refresh; unknown states handled | P1-12 |
| P1-14 | Destructive operation safety | Confirmation with exact consequences; destructive actions declared **irreversible**; no silent deletion; untracked files never deleted by the application; refusal if status is inconsistent | P1-03, P1-05, P1-07 |
| P1-15 | External tools | Open configured editor, terminal, diff/merge tool; explicit failure if missing | P0-01 |
| P1-16 | Local repository creation | `git init` on an absolute directory, new or existing and unversioned; optional initial branch; refuse an existing repository (including bare); open immediately; existing files preserved and untracked | P0-03 |

**P1 exit criterion:** a volunteer developer completes a full workday (branch, partial staging, commit, push, MR, simple review, merge) without GitKraken or a terminal, except for explicitly P2 operations.

### P2 — Daily feature parity

| ID | Feature | Acceptance criteria | Depends on |
|---|---|---|---|
| P2-01 | Interactive rebase | Todo generated and executed through Git; reorder, pick/reword/squash/drop; editor cancellation; conflicts handled; no corrupted todo | P1-07 |
| P2-02 | 3-panel conflict resolution | Ours/theirs/base/output; editing; mark resolved; save result; consistency with Git markers | P1-08 |
| P2-03 | Advanced cherry-pick / revert | Multiple selection, ordering, conflicts, continue/abort, history | P1-07 |
| P2-04 | Worktrees | List, create, open, lock/unlock, remove; per-worktree status; isolated sessions; multiple WIPs | P0-03 |
| P2-05 | File history and blame | Per file and per line; navigate to commit; handle renames; bounded performance | P1-01 |
| P2-06 | Command palette | All frequent actions; fuzzy search; repository context; keyboard execution | P1 |
| P2-07 | Advanced keyboard shortcuts | Main action coverage; discoverable; customizable if measured as useful | P2-06 |
| P2-08 | In-depth search | Path, content (with limits), author, date; paginated results; explicit scope | P1-11 |
| P2-09 | GitLab — inline discussions | Read/write diff-positioned comments; resolution; error states | P1-12 |
| P2-10 | GitLab — approvals and merge | Approve, merge with strategy; tier feature detection; confirmation | P1-12 |
| P2-11 | GitLab — jobs and logs | Job list, status, paginated logs; cancellation if supported | P1-13 |
| P2-12 | Submodules | Panel, add, init, update, commit pointer, statuses; operations delegated to Git | P0-03 |
| P2-13 | Advanced tags and remotes | Annotated tags, tag push, remote management, URLs, prune | P1-05 |
| P2-14 | Profiles | Git identity, preferences, tabs; one active GitLab instance per profile | P1-10 |
| P2-15 | Patches | Create/apply a patch; refuse unsupported binaries; report conflicts | P1-03 |

### P3 — Polish — delivered and verified

Evidence: [reviews/p3-review.md](reviews/p3-review.md).

| ID | Feature | Acceptance criteria | Depends on |
|---|---|---|---|
| P3-01 | Full Undo / Redo | Matrix in [04-undo-redo](04-undo-redo.md) covered; preconditions; only Git-reversible operations; irreversible actions refused; partial failures reported; crash tests | P1-14 |
| P3-02 | Advanced drag & drop | Branches and commits; preview; cancellation; no ambiguous mutation | P2-01 |
| P3-03 | Design system and themes | Direction from [10-design-direction](10-design-direction.md); tokens, light/dark themes, density, non-blocking animations | — |
| P3-04 | Large repository optimizations | Measured gains on scenarios exceeding their budgets; no regression | P0-08 |
| P3-05 | Multi-repo workspaces | Local groups, multi-repository fetch/pull, bounded actions | P1-10 |
| P3-06 | Accessibility and ergonomics | Keyboard navigation, focus, contrast, screen readers on main views | P2-07 |
| P3-07 | Distribution | Signed updates, per-OS packaging, no telemetry | P0-01 |

## 7. GitKraken parity: keep, improve, drop

### Keep

- Immediately readable history, readable lanes, visible refs and merges.
- Relevant right-click context actions.
- Ergonomic partial staging (file, hunk, line).
- Comfortable diff viewer (split/inline/hunk, word diff, navigation).
- Simple branch manipulation (drag & drop in P3).
- Hide/solo, branch pinning, filters.
- Multiple repositories in tabs.
- Command palette, shortcuts.
- Integrated MR view and CI status.

### Improve

- Startup, responsiveness, memory.
- Information density and navigation consistency.
- Explicit handling of intermediate states.
- Native self-hosted GitLab integration.
- Error messages and remediation.
- Strict respect for existing Git configuration.

### Drop

- AI, code suggestions, MCP.
- Proprietary cloud, vendor accounts, Insights, Automations, Codemaps, cloud Launchpad.
- Intrusive telemetry.
- Features requiring a third-party server.
- Reproduction of GitKraken's visual identity and assets.

## 8. Explicitly out of scope

- Integrated code editing.
- Semantic conflict resolution beyond Git.
- Managing multiple Git providers.
- Local CI pipeline execution.
- Full SSH key management (generation/upload) in the MVP: use the existing agent and keys.
- Repository migration, bulk history rewriting, filtering.
- Support for Git < the chosen minimum version.
- Cloud preference synchronization.
