# 03 — Git CLI engine

## 1. Invariants

1. **A single entry point**: `crates/git::process`. No other code launches `git`.
2. **Never use a shell.** `std::process::Command` / `tokio::process::Command` with `arg()`.
3. **Machine-readable formats** wherever possible.
4. **No assumptions about user configuration.** Read `git config` and respect hooks, LFS, signatures, credential helpers, `core.autocrlf`, `core.fsmonitor`, `pull.rebase`.
5. **No unserialized mutations** per repository.
6. **No swallowed errors**, no truncated `stderr` without reporting it.
7. **No writes to the repository** outside the requested Git command.
8. **No bypassing hooks** without explicit user action.
9. **No application backups.** Destructive actions are irreversible, confirmed, and never delete untracked files.

## 2. Process construction

```rust
struct CommandSpec {
    repo: RepoPath,
    program: GitProgram,          // resolved once (PATH or override)
    subcommand: GitSubcommand,    // allowlist
    args: Vec<OsString>,          // never interpreted by a shell
    env: Vec<(OsString, OsString)>,
    stdin: StdinMode,             // null | pipe | file
    timeout: Option<Duration>,
    capture: CaptureMode,         // bounded stdout/stderr
    operation: OperationContext,
}
```

Rules:

- `git -C <worktree> [global opts] <subcommand> [args] -- <paths>`.
- Fixed global options: `--no-pager`, `-c color.ui=false`, `-c core.quotepath=false` (paths), `--no-optional-locks` for reads.
- `GIT_TERMINAL_PROMPT=0` to fail rather than block on input.
- `GIT_PAGER=cat`, `PAGER=cat`.
- Bounded `stdout`/`stderr` (configurable value, 16 KiB by default for errors, unbounded streaming for long-running operations).
- `stdin` closed unless explicitly needed (credential helper, editor).
- Timeout: 30 s for local reads/writes; no default timeout for fetch/push/clone (progress heartbeat instead).
- Windows: `CREATE_NO_WINDOW`.
- The `git` program is resolved at startup (`git --version`), with an override in settings.

### Environment

| Variable | Policy |
|---|---|
| `PATH`, `HOME`, `USERPROFILE` | inherited |
| `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` | inherited (respect the user's SSH configuration) |
| `GIT_TERMINAL_PROMPT` | forced to `0` |
| `GIT_PAGER`, `PAGER` | forced to `cat` |
| `LC_ALL` | not forced; parsed formats are locale-independent |
| `GIT_CONFIG_*` | not inherited if they allow arbitrary configuration injection; strict allowlist |
| Secrets | never in arguments; see §13 |

## 3. Capability detection

On first use:

- `git --version` → parsed version.
- `git lfs version` → LFS availability.
- Critical options checked against documented versions, with tests:
  - `status --porcelain=v2` (≥ 2.11);
  - `switch` / `restore` (≥ 2.23);
  - `worktree list --porcelain` (≥ 2.7);
  - `rebase --update-refs` (≥ 2.38, optional).

Chosen minimum version: **Git ≥ 2.34**, target and tests on **2.56.0** ([ADR-0007](adr/0007-version-baseline.md)). Below this: blocking message with the detected version. Optional features are disabled by capability, not by a hard-coded version.

## 4. Read commands

All commands in this section use `--no-optional-locks` and do not write to the repository.

### Discovery

```text
git -C <path> rev-parse --show-toplevel --absolute-git-dir --git-common-dir
                        --is-bare-repository --is-inside-work-tree
```

Result: worktree, git dir, common dir, bare, inside-worktree. The common dir links worktrees to the same logical session.

### Status

```text
git -C <repo> --no-optional-locks status --porcelain=v2 -z --branch
    --untracked-files=all --ignore-submodules=none --find-renames
```

Parsing:

- `# branch.oid`, `# branch.head`, `# branch.upstream`, `# branch.ab`.
- `1`: ordinary change (XY, submodule, modes, path).
- `2`: rename/copy (two NUL-separated paths).
- `u`: conflict (XY, modes, stages, path).
- `?`: untracked; `!`: ignored (only if requested).
- `-z`: no path escaping, everything is NUL-terminated.

Full status can be expensive; it runs in the background, with watcher-based invalidation, never on every frame.

### Refs

```text
git -C <repo> for-each-ref --format='%(refname)%09%(objectname)%09%(objecttype)%09%(upstream)%09%(HEAD)%09%(symref)'
```

Ref names cannot contain tabs or control characters; field-based parsing. Remote refs are grouped by remote.

### Log (graph page)

```text
git -C <repo> --no-optional-locks log <order> --parents
    --format='%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s'
    --max-count=<N> [<cursor>]
```

- `<order>`: `--date-order` by default (recent activity, parents after children); `--topo-order` available if lane readability warrants it. The choice is measured (lane stability, cost on large histories).
- `%s` is the subject (one line); the body is loaded only on demand.
- Fields are separated by `0x1F` (unit separator), records by `\n`.
- Pagination with a **growing window**: `N = 500`, then 1,000, 2,000, 4,000… with caching. Deep jumps use `--skip` and are measured; no implicit full load.
- Topology (parents) computed on the Rust side from `%P`; lanes are assigned in `git::log`.

### Commit details

```text
git show -s --format='%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B' <sha>
git diff-tree --no-commit-id --name-status -r -z <sha>
git diff-tree --no-commit-id --numstat -z <sha>
```

The body is bounded; files are paginated. For a merge commit, the default diff is against the first parent, with an option to choose the parent.

### Diff

```text
git -C <repo> diff --no-color --no-ext-diff --no-textconv --unified=<n>
    [--cached] <base> [<target>] -- <path>
```

- `--no-ext-diff` and `--no-textconv` for deterministic rendering; external diff tools are a separate action.
- Rust unified diff parser: hunks, lines, missing final newline, binary (`Binary files ... differ`).
- Per-file limit (size and line count); beyond it, an explicit message and an option to open externally.
- Untracked: read the file directly with a limit, never through a fragile synthetic diff.

### Blame and file history

```text
git blame --line-porcelain -- <path>
git log --follow --name-status --format='...' -- <path>
```

`--follow` only works for a single path; document this in the UI.

## 5. Mutation commands

Every mutation goes through the repository queue and a **preflight**.

| Action | Command | Preflight |
|---|---|---|
| Stage paths | `git add -A -- <paths>` | valid paths, no `.git` |
| Unstage | `git restore --staged -- <paths>` | nonempty index |
| Discard worktree | `git restore --worktree -- <paths>` | explicit confirmation; irreversible action |
| Commit | `git commit -F <tmp> [--amend] [--cleanup=strip]` | configured identity, nonempty index, hooks |
| Switch | `git switch <branch>` / `git switch -c <branch> [<start>]` | compatible worktree, no operation in progress |
| Delete branch | `git branch -d/-D <branch>` | not current, merged or strong confirmation |
| Rename branch | `git branch -m <old> <new>` | valid name, no collision |
| Fetch | `git fetch --prune --progress <remote>` | remote exists |
| Pull | `git pull --progress [--ff-only\|--rebase\|--no-rebase] <remote> <branch>` | clean worktree, upstream; strategy read from `branch.<name>.rebase`, then `pull.rebase`, then `pull.ff`; nonzero exit code = reported failure |
| Push | `git push --progress <remote> <ref>` | upstream, non-fast-forward detected |
| Force push | `git push --force-with-lease=<ref>:<expected>` | explicit confirmation, old SHA recorded |
| Merge | `git merge --no-edit [--ff\|--ff-only\|--no-ff] <ref>` | explicit strategy: `--ff` by default, `--ff-only` for a requested fast-forward, `--no-ff` for a merge commit; clean worktree, no operation (branch→branch integration stashes tracked changes) |
| Rebase | `git rebase <upstream>` | clean worktree, no unhandled merge commits |
| Cherry-pick | `git cherry-pick <sha>...` | clean worktree |
| Revert | `git revert --no-edit <sha>...` | clean worktree |
| Reset | `git reset --soft\|--mixed\|--hard <ref>` | strong confirmation; `--hard` irreversible |
| Stash push | `git stash push -m <msg> [-- <paths>]` | — |
| Stash apply/pop | `git stash apply\|pop <ref>` | possible conflicts |
| Worktree add | `git worktree add <path> <ref>` | path absent |
| Worktree remove | `git worktree remove <path>` | no uncommitted changes |
| Tag | `git tag -a <name> -m <msg> <ref>` | valid name, no collision |

### Refused push recovery

A refused push is never a dead end. The refusal (`git.non_fast_forward`, or
`git.push_lease_stale` when the lease went stale) opens a recovery decision:

1. `git fetch <remote>` refreshes the remote-tracking refs;
2. `git rev-list --left-right --count <remote>/<branch>...<branch>` gives the
   two counts shown to the user (missing locally / missing remotely);
3. the user integrates (`git pull --rebase|--merge|--ff-only <remote> <branch>`,
   immediately followed by the push), retries when nothing is missing
   remotely, or replaces the remote tip (`--force-with-lease`, behind a typed
   confirmation of the branch name).

The expected SHA of a force push is read with `git ls-remote` right before the
send, never taken from the UI or an older fetch.

### Branch→branch integration

Dropping branch `source` onto `target` checks out `target` then merges or rebases
`source` into `target`. If the worktree contains tracked changes, a merge
automatically protects them:

1. `git stash push -m "BeeBranch auto-stash …"` (tracked files only);
2. check out `target`, then `git merge --no-edit [--ff|--ff-only|--no-ff] <source>`;
3. `git stash pop` immediately afterward.

A requested fast-forward merge (`--ff-only`) is refused before any
checkout when `target` has commits absent from `source`: the error
`git.merge_not_fast_forward` reports the number of commits involved and offers a
merge commit or a rebase. An `--ff` merge advances `target` when
possible and creates a merge commit otherwise; `--no-ff` forces the merge
commit. The flag is always passed explicitly, so `merge.ff` in the
repository configuration never changes the requested result.

If the merge stops on conflicts, or if the pop itself conflicts, the
stash is not deleted: its selector and SHA are returned in the
result and displayed in the interface. A checkout or merge failure
also restores the stash. Untracked files are neither stashed nor moved; a
checkout that Git refuses for this reason fails explicitly. A rebase remains
refused whenever a tracked file is modified; untracked files do not
block it.

### Partial staging

Staging by hunk/line relies on generating a unified patch, then:

```text
git apply --cached [--reverse] --recount --whitespace=nowarn <patch>
```

- The patch is generated from `git diff` (working tree) or `git diff --cached` (index) with the exact context.
- A line patch is built by reducing the selected hunks; line numbers are recalculated.
- `--recount` tolerates count headers; it must not hide a context error.
- Required tests: CRLF, missing final newline, renamed file, mode `100755`, Unicode path, ambiguous context, empty patch.
- On failure: no partial modification accepted; the index is reread and the error reported.

### Discard

- **Irreversible** action: no application copy is kept.
- Explicit confirmation with the exact diff and the number of files affected.
- Tracked file: fingerprint check, then `git restore --worktree`.
- Staged file + worktree: restore the selected areas, after confirmation.
- Untracked file: **never deleted by the application**; offer to open the directory or add it to `.gitignore`.
- Hunk: reverse-apply the selected patch to the worktree, with a fingerprint check before/after.
- A discard is never performed if the file has changed since the diff was displayed (fingerprint).

### Interactive rebase (P2)

- The plan is validated against `git rev-list --reverse --no-merges <upstream>..HEAD`:
  same commits, uniqueness, arbitrary order, explicit `drop`.
- The todo is written to a temporary directory; `GIT_SEQUENCE_EDITOR` is
  set to `cp '<todo>'`, so Git installs our plan without an interactive editor.
- `reword` and `squash` use `exec git commit --amend -F <message>`, which
  avoids `GIT_EDITOR` and makes messages deterministic.
- A conflict is a status, not an opaque error; `--continue`, `--skip` and
  `--abort` remain explicit.

### 3-panel conflict resolution (P2)

- `git show :1:path`, `:2:path`, `:3:path` provide base/ours/theirs.
- The working file is read and written atomically (temporary file
  then `rename`), preserving the detected LF/CRLF.
- Binaries and files > 8 MiB are never decoded; the UI explains this.
- Remaining markers are rejected unless explicitly editing raw content.
- `git add -- path` marks the conflict as resolved.

### Patches (P2)

- Create from the worktree, index, commit (`git show --format= --patch`) or
  commit range.
- Binary patches are explicitly rejected.
- Two-phase application: `git apply --check` then `git apply`; a
  check conflict leaves the worktree intact.

## 6. Long-running operations, streaming and cancellation

| Operation | Streaming | Cancellation |
|---|---|---|
| `clone` | stderr (progress) | SIGTERM, then kill after 5 s; partial directory marked |
| `fetch` | stderr (progress) | SIGTERM; remote status revalidated afterward |
| `push` | stderr (progress) | SIGTERM; **the push may have succeeded** → `ls-remote` to check |
| `pull` | stderr | SIGTERM; local status revalidated |
| `merge`/`rebase`/`cherry-pick` | stdout/stderr | No mid-command cancellation; offer abort after stable status |

Rules:

- No immediate `kill -9`: graceful shutdown, then forced.
- On Windows, `Child::kill()`; on Unix, signal the process group if a helper is launched.
- Every cancellation produces an `AppError { code: "op.cancelled" }` and a status refresh.
- Hooks can launch child processes; timeouts and cancellation must cover them.

## 7. Intermediate statuses and recovery

Paths resolved via `git rev-parse --git-path <name>` (essential for worktrees).

| Status | Detection | Offered actions |
|---|---|---|
| Merge | `MERGE_HEAD` | continue, abort, resolve |
| Rebase (merge) | `rebase-merge/` | continue, skip, abort |
| Rebase (apply) | `rebase-apply/` | continue, skip, abort |
| Cherry-pick | `CHERRY_PICK_HEAD` | continue, skip, abort |
| Revert | `REVERT_HEAD` | continue, skip, abort |
| Sequencer | `sequencer/todo` | continue the sequence |
| Bisect | `BISECT_LOG`, `BISECT_START` | reset, finish |
| Conflicts | `status` entries `u` | open, mark resolved |
| Locks | `index.lock`, `HEAD.lock` | explain, offer to check for another process |

When a session starts, the status is computed and displayed **before** any action. No destructive action is allowed until an intermediate status is understood.

## 8. Conflicts

- `git status --porcelain=v2 -z` provides conflicting paths.
- Versions are read via `git cat-file` / `git show :1:path`, `:2:path`, `:3:path` (base, ours, theirs) — only for the 3-panel editor (P2).
- Resolution: write the working file, then `git add -- <path>`.
- `continue`: `git merge --continue`, `git rebase --continue`, `git cherry-pick --continue`.
- `abort`: corresponding command, with a check that no unsaved user changes will be lost.
- In P1, editing takes place in the external editor; the app tracks status and allows `add`, `continue`, `abort`.

## 9. Interactive rebase

The todo is generated by the application, never edited manually in an interactive editor.

```text
GIT_SEQUENCE_EDITOR=<helper> GIT_EDITOR=<helper> \
git -c sequence.editor=<helper> rebase -i --autosquash <base>
```

- The helper (`beebranch-editor`) receives the todo file path and a mode (`sequence` or `message`).
- It reads a JSON plan from a temporary file created by the application (permissions 0600) and writes the todo.
- For `reword`, the helper writes the prepared message; for `squash`, the message is composed by the application.
- The plan is validated before launch: no `drop` of the base commit, no empty todo, no unknown reference.
- On conflict: `Rebase` status, resolution, `--continue`/`--abort`.
- No parsing of the todo generated by Git is used as a source of truth; the application keeps its plan.

## 10. Worktrees

- `git worktree list --porcelain` lists worktrees (path, HEAD, branch, bare, locked, prunable).
- A session is identified by the **worktree**, but shares the common dir.
- Ref operations are shared; index/worktree operations are local to the worktree.
- Creation: `git worktree add <path> <ref>`; refused if the path exists or is already registered.
- Removal: preflight (uncommitted changes), then `git worktree remove`; `--force` only with confirmation.
- Lock/unlock: `git worktree lock/unlock`.
- Status and index caches are keyed by `(worktree, generation)`.

## 11. Submodules, LFS, signatures, SSH

| Topic | Policy |
|---|---|
| Submodules | Delegate to `git submodule`; statuses via `git submodule status --recursive`; do not parse `.gitmodules` as a source of truth |
| LFS | Detect `git lfs`; filters are applied by Git; never read a pointer file as a normal file without indicating LFS |
| Signature | Respect `commit.gpgsign`, `user.signingkey`, `gpg.format`; never force |
| SSH | Use the agent, `~/.ssh/config`, `GIT_SSH_COMMAND` if set; do not generate keys in the MVP |
| HTTPS | Credential helper provided by the application, token read from the OS keychain; never in the URL |
| Hooks | Executed by Git; output displayed; blocking failure unless explicit action |

### HTTPS credential helper

- Fetch, pull, push (including remote SHA checks) append a temporary credential helper after the user's configured helpers.
- The helper answers only `get`, only for HTTPS and an exact connected host and port. Other protocols, hosts, `store` and `erase` receive no credentials.
- GitLab PAT/OAuth and GitHub tokens come from the OS keychain, with discovered Git credentials as a fallback. Tokens are written to private temporary files (0600 on Unix), never argv, URLs or environment values. The running process retains the files until completion or cancellation, then removes them.
- The stored remote remains `https://host/group/project.git`.

## 12. Error mapping

| Pattern / code | Application code | Remediation |
|---|---|---|
| `not a git repository` | `repo.not_git` | check the path |
| `Authentication failed`, `could not read Username` | `auth.failed` | check the token / helper |
| `Permission denied (publickey)` | `auth.ssh_key` | check the agent and key |
| `Host key verification failed` | `auth.host_key` | check `known_hosts` |
| `non-fast-forward`, `fetch first` | `git.non_fast_forward` | fetch then merge/rebase |
| `stale info` (push) | `git.push_lease_stale` | retry; the expected remote SHA is re-read before each send |
| `Not possible to fast-forward` (pull) | `git.pull_not_fast_forward` | rebase/merge or relax `pull.ff` |
| `Need to specify how to reconcile divergent branches` | `git.pull_strategy_missing` | configure `pull.rebase`/`pull.ff` or choose a strategy |
| `CONFLICT`, exit 1 on merge/rebase | `git.conflict` | resolve then continue |
| `Your local changes would be overwritten` | `git.dirty_worktree` | stash/commit |
| `index.lock` | `repo.busy` | check for another process |
| `detected dubious ownership` | `repo.safe_directory` | add `safe.directory` explicitly |
| `unable to auto-detect email address` | `git.identity_missing` | configure `user.name`/`user.email` |
| `gpg failed to sign` | `git.signing_failed` | check the key/agent |
| `this operation must be run in a work tree` | `repo.bare` | open a worktree |
| `no such remote` | `git.remote_missing` | check the configuration |
| `pathspec ... did not match` | `git.pathspec` | check the path |
| `untracked working tree files would be overwritten` | `git.untracked_collision` | manually move the affected files |
| `refusing to merge unrelated histories` | `git.unrelated_histories` | explicit decision |
| `You are not currently on a branch` | `git.detached` | create a branch |
| `unmerged files` | `git.unresolved_conflicts` | resolve |
| `bad object`, `invalid reference` | `git.bad_ref` | check the ref |
| `shallow` + unsupported operation | `git.shallow_unsupported` | fetch/unshallow |
| unknown | `git.exit_unknown` | raw details |

The mapping is tested with fixture repositories reproducing each case.

## 13. Engine security

- Allowlist of subcommands and options; no arbitrary options from the frontend.
- Paths go after `--` and are validated (no `..` outside the repository, no internal `.git`).
- Commit messages and branch names are never injected into a command line: they are passed through a file or argv.
- Tokens never pass through argv, URLs or environment variables readable by another process.
- Output is redacted before logging.
- Git commands are executed with the repository's working directory, not an arbitrary `cwd`.

## 14. Tests

### Generated fixtures

A version-controlled script creates, for each test:

- a linear repository;
- a repository with merges (including a merge of a merge);
- a repository with multiple branches and simulated remote refs;
- a repository with merge, rebase and cherry-pick conflicts;
- a repository with a rename, deletion, executable mode, symlink;
- a repository with CRLF, missing final newline, Unicode paths;
- a repository with large and binary files;
- a repository with a local submodule;
- a repository with multiple worktrees;
- a shallow repository;
- a repository with failing hooks;
- a repository with a simulated `index.lock`.

### Levels

| Level | Content |
|---|---|
| Unit | parsers (status, log, diff, refs), argv construction, error mapping |
| Integration | real commands on fixtures, assertions on the resulting Git status |
| Contract | each command returns the expected type and a stable error code |
| Platform | same tests on Windows/macOS/Linux |
| Fault injection | permissions, full disk, interruption, lock, failing hook |
| Performance | see [06-performance](06-performance.md) |

No test merely checks that a command “does not crash”: it checks the repository status after the operation.
