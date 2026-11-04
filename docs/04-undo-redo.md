# 04 — Undo / Redo

## 1. Principles

1. **No application backups.** The application copies neither working tree files nor the index to restore a previous status.
2. **Only operations reversible through Git can be undone**: refs, commits, index, reflog, Git objects.
3. **Typed inverse.** Each undo is a specific Git operation, with verified preconditions.
4. **Never a generic `reset --hard`.** `reset --hard` is used only as the explicit inverse of an operation that requires it, after verifying that the worktree is clean.
5. **Destructive actions are irreversible.** Discard, `reset --hard` and stash drop cannot be undone and require explicit confirmation.
6. **Never overwrite user work.** If the repository has changed since the operation, undo is refused.
7. **No false promises.** An operation that cannot be undone is displayed as such.
8. **P3, nonblocking.** The MVP (P1) provides confirmations and preflight; full undo/redo arrives in P3.

## 2. Model

```rust
struct UndoRecord {
    id: UndoId,
    repo_id: RepoId,
    kind: UndoKind,
    payload: serde_json::Value,   // typed, versioned data
    before: Fingerprint,
    after: Fingerprint,
    created_at: Timestamp,
    state: UndoState,             // Available | Consumed | RestoreFailed | Evicted
}
```

- `before` / `after` describe the repository status around the operation.
- `payload` contains the data needed for the inverse: refs, SHAs, index trees, messages, paths.
- No working tree files are copied.
- Index trees are Git objects (`git write-tree`), not content backups.
- The stack is bounded (50 operations), with no disk quota.

## 3. Fingerprint and preconditions

```rust
struct Fingerprint {
    head: HeadState,              // branch + sha, or detached
    index_tree: Oid,              // index tree (git write-tree)
    status_hash: Sha256,          // hash of `status --porcelain=v2 -z` (no `--branch`)
    content_hash: Sha256,         // content of every path the status lists
    state: RepoState,             // running operation, conflicts
    refs: BTreeMap<String, Oid>,  // refs touched by the operation
    affected_files: BTreeMap<PathBuf, Sha256>,
}
```

Checks before undo (and redo, against `before`):

1. `id` matches the last undoable operation. The record is selected inside the
   serialized repository queue, so two quick undos take successive records.
2. No Git operation in progress (`merge`, `rebase`, `cherry-pick`, `revert`, `bisect`).
3. No locks (`index.lock`, `HEAD.lock`).
4. Touched refs and affected files match the expected fingerprint.
5. The rest depends on the inverse (the *guard*, derived from the typed action):

| Inverse | Also checked |
|---|---|
| Ref only (branch/tag create, delete, rename; remote add/remove; worktree add/remove) | nothing else: unrelated worktree changes never block it |
| `reset --soft` (commit, amend, soft reset) | `HEAD` (branch and commit) |
| `git switch` (checkout) | `HEAD`; Git itself refuses to overwrite local changes |
| `reset --mixed` + `read-tree` (mixed reset) | `HEAD` and index tree |
| Typed history inverse (merge, rebase, cherry-pick, revert, squash) | `HEAD` and **no tracked modification** (`undo.worktree_dirty`) |
| Stash re-application, abort of an operation in progress | full fingerprint (`HEAD`, index, status and worktree content); the stash commit must still exist, and an entry to drop must still be listed |

The status does not reflect worktree content (editing an already-modified or
still-conflicted file keeps the same line), so the full fingerprint also hashes
the content of every path the status lists. The status hash is computed without `--branch`: `HEAD` is compared on its own,
and the ahead/behind counts change on every fetch without touching local work.

If a condition fails: explicit refusal, no modification, message indicating what changed.

**Already shared history.** If the operation's result is already present on a remote-tracking branch, undo is a local history rewrite. It remains possible for operations in the matrix, but requires additional confirmation and an explicit warning: the remote is not modified, and a later push may require a manual decision. No undo pushes automatically.

## 4. Reversibility matrix

Legend: **Yes** = undo supported; **Partial** = supported with conditions; **No** = explicitly not undoable.

| Operation | Undo | Inverse | Captured data | Main preconditions | Redo |
|---|---|---|---|---|---|
| Commit | Yes | `reset --soft` to `before`; the current index is kept, so the commit reappears as staged changes and successive undos chain | `before_head`, `after_sha`, index tree before/after | HEAD == `after`, no operation | Yes |
| Commit --amend | Yes | Same, with the old commit | old SHA, new SHA, index trees | HEAD == new SHA | Yes |
| Checkout / switch | Yes | Return to `before` (branch or detached) | `before_head`, `after_head` | HEAD == `after`; `git switch` refuses to overwrite local changes | Yes |
| Branch creation | Yes | Delete the created ref | name, SHA | ref still points to the created SHA, not current | Yes |
| Branch deletion | Yes | Recreate the ref at the captured SHA + upstream | name, SHA, upstream | ref absent | Yes |
| Branch rename | Yes | Rename in the opposite direction | old/new name | new name exists, old absent | Yes |
| Merge in progress | Partial | `git merge --abort` | Git status | `MERGE_HEAD` present, confirmation (resolutions lost) | No |
| Merge commit | Partial | Typed `reset --keep before`, worktree verified clean | `before/after`, index trees | HEAD == `after`, no tracked modification, no operation | Yes |
| Branch→branch merge with automatic stash | Partial | `merge --abort`/`reset --hard before` then `stash apply --index <SHA>`; drop only if the stash had not already been popped | `before/after`, stash selector and SHA | HEAD == `after` (or `MERGE_HEAD` in progress) | No |
| Rebase in progress | Partial | `git rebase --abort` | Git status | rebase in progress, confirmation | No |
| Completed rebase | Partial | Typed `reset --keep before`, worktree verified clean | `before/after`, index trees | HEAD == `after`, no tracked modification | Yes |
| Cherry-pick in progress | Partial | `git cherry-pick --abort` | Git status | sequence in progress, confirmation | No |
| Completed cherry-pick | Partial | Typed `reset --keep before` | `before/after`, index trees | HEAD == `after`, no tracked modification | Yes |
| Completed revert | Yes | Typed `reset --keep` to `before` | `before/after`, index trees | HEAD == `after`, no tracked modification | Yes |
| Reset --soft | Yes | Inverse soft reset | `before/after` HEAD, index trees | HEAD == `after` | Yes |
| Reset --mixed | Yes | Inverse mixed reset + `read-tree` | `before/after` HEAD, index trees | HEAD == `after`, unchanged worktree | Yes |
| **Reset --hard** | **No** | — | — | — | — |
| **Discard file** | **No** | — | — | — | — |
| **Discard hunk** | **No** | — | — | — | — |
| Stage / unstage | No (outside the stack) | Opposite action in the UI | — | — | — |
| Stash create | Partial | `git stash apply --index` then drop on exact success | stash SHA, message | clean worktree, stash present | No |
| **Stash drop** | **No** | — | — | — | — |
| **Stash apply / pop** | **No** | — | — | — | — |
| Tag creation | Yes | Delete the tag | name, object | tag points to the same object | Yes |
| Tag deletion | Yes | Point the ref back at the original object (an annotated tag keeps its id, message, tagger and signature); if Git pruned it, rebuild the annotated tag on its commit | name, object, message, tagger | tag absent | Yes |
| Remote addition | Yes | Delete the remote | name, URLs | unchanged remote | Yes |
| Remote removal | Yes | Recreate the remote + refspec | name, URLs, refspec | remote absent | Yes |
| Fetch | No | — | — | — | — |
| Push | No | — | — | — | — |
| Force push | No | Separate “restore the remote” action | old remote SHA | strong confirmation | — |
| Worktree add | Yes | `git worktree remove` (without `--force`), then delete the branch it created | path, branch | worktree without changes, created branch not moved | Yes |
| Worktree remove | Yes | `git worktree add` at the same path (recreating the branch if it was deleted with it) | path, ref | available path, branch unchanged | Yes, never forced: Git refuses a worktree edited since, and the branch is deleted again |
| Forced removal of a dirty worktree | No | — | — | — | — |
| Submodule update | No | — | — | — | — |

### Explicitly irreversible actions

- file or hunk `discard`;
- `reset --hard`;
- forced removal of a worktree with local changes;
- `stash drop`, `stash apply`, `stash pop`;
- deleting untracked files (outside the application);
- push and force push;
- fetch;
- submodule update;
- aborting a merge/rebase with unrecorded conflict resolutions;
- any operation whose preconditions can no longer be verified.

The UI displays these actions as irreversible. No “Undo” button is associated with them.

## 5. Recovery without backups

The application keeps no copies. Recovery options depend on Git:

| Situation | Possible recovery |
|---|---|
| Undone commit | Object still present; `git reflog` / SHA |
| Deleted branch | Captured SHA; recreate the ref if the object exists |
| Undone merge/rebase | Old HEAD in the reflog |
| Discard | **None**: uncommitted content is lost |
| Reset --hard | **None** for uncommitted changes |
| Stash drop | **None** guaranteed: the object may be garbage-collected by Git |

The UI must make this difference explicit before the action, not afterward.

## 6. Restoration algorithm

```text
1. Load the UndoRecord.
2. Verify the fingerprint (section 3). Failure → refusal, no effect.
3. Execute the typed inverse, step by step:
   a. Git step (reset, switch, update-ref);
   b. index restoration via `read-tree` if applicable;
   c. verification after each step.
4. Recompute the repository state and the fingerprint.
5. Verify that the resulting state matches `before`.
6. Mark the operation as Consumed; keep the redo.
```

### Partial failure

- Stop immediately, no attempt to “repair” automatically.
- `RestoreFailed` status with:
  - step reached;
  - exact command executed;
  - Git output;
  - recovery suggestion via `git reflog` or SHA.
- No backup exists: the UI does not promise automatic restoration.
- The user sees a recovery panel, not a simple toast.

### Crash during restoration

- Each step writes a marker to the SQLite journal before and after execution.
- At startup, a `Restoring` operation is marked `RestoreInterrupted` and the repository status is recalculated.
- No data is restored automatically.

## 7. Redo

- Redo is offered only if the `before` status is still exact and the `after` action can be reapplied without loss.
- Redo replays the most recent undo first: the next redo is the lowest
  consumed record above the last available one, so the stack stays contiguous.
- A new recorded operation, and any mutation that is not recorded (stage,
  unstage, discard, pull, …, even when it fails, since it may have written),
  invalidates the redo branch inside the serialized queue. Fetch and
  push keep it: they only touch the remote side.
- For commit-based operations, redo moves HEAD, restores the index and leaves the worktree intact.
- No redo for irreversible actions.
- A failed redo leaves status unchanged and reports the error.

## 8. UI

- Undo button enabled only if the last operation is in the matrix **and** preconditions are satisfied at click time.
  `undo_status` evaluates the preconditions of the next undo and redo without
  writing anything and returns the refusal (`blocked`) so the buttons are
  disabled with the reason as tooltip; the real undo re-checks everything.
- Every recorded action is confirmed by a toast with an “Undo” button; an undo
  is confirmed by “Undone: …” with a “Redo” button. All triggers (shortcut,
  palette, toolbar, status bar, commit panel, toasts) share one entry point
  that ignores a second request while one runs.
- The commit panel's “Undo the commit” targets that commit's record only and
  disappears as soon as it is no longer the next operation to undo.
- Explicit label: “Undo commit `a1b2c3d`”, “Undo deletion of branch `feature/x`”.
- Refusal with reason: “The repository has changed since this operation”.
- Irreversible actions display a warning before execution and never appear as undoable.
- No additional confirmation for safe undo; confirmation for undo that abandons conflict resolutions.
- The recovery panel is accessible from settings and after a failure.

## 9. Tests

| Test | Expected |
|---|---|
| Each “Yes” row in the matrix, nominal case | `before` status restored exactly |
| Each “No” row | no undo offered, action indicated as irreversible |
| Precondition violated (HEAD changed) | refusal, no effect |
| File modified after the operation | refusal |
| Untracked file present | never deleted by an undo |
| Conflict in progress | undo refused or explicit abort |
| Detached repository | correct inverse checkout |
| Index restored | `git diff --cached` identical to `before` |
| Dirty worktree before an inverse reset | refusal |
| Simulated partial failure | `RestoreFailed` status, command and SHA displayed |
| Crash between two steps | recovery at startup, no silent restoration |
| Worktree | undo isolated to the correct worktree |
| Branch deleted then recreated | refusal if the SHA differs |
| No application copies | no working tree files created under app data |

Tests use real repositories and verify status through Git, not just the application's responses.

## 10. P3 implementation

- Module `crates/git/src/undo.rs`: fingerprint, preconditions, typed actions,
  step-by-step execution and fault injection for tests.
- SQLite journal `undo_records`: stack bounded to 50 per repository, statuses
  `available`/`consumed`/`restoring`/`restoreFailed`/`restoreInterrupted`/
  `evicted`, `position`, step, command and recovery SHA.
- Each step is written **before** execution; at startup, `restoring`
  becomes `restoreInterrupted` and is never replayed.
- Reversible mutations capture their fingerprint in the serialized repository
  queue (`run_undoable_mutation`), then record their typed inverse.
- A commit uses `reset --soft` and keeps the index; merge, rebase,
  cherry-pick and revert use a typed `reset --keep` after verifying that no
  tracked file is modified (`reset --keep` also refuses to overwrite an
  untracked file), never a generic `reset --hard`. `reset --hard` remains only
  in the branch-integration inverse that re-applies the automatic stash right
  after, guarded by an exact status and content match; a `git stash create`
  snapshot of the local changes is taken first and journaled as the step's
  recovery SHA. The stash is dropped by its commit, never by a positional
  selector.
- Stash create: `stash apply --index`, check the expected status hash,
  then `stash drop` only if application is exact.
- A new record invalidates the redo branch (`consumed` → `evicted`).
