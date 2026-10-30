# ADR-0005 — Per-repository serialization and bounded IPC

- **Status:** accepted
- **Date:** 2026-10-27
- **New:** clarifies the revision 1 architecture

## Context

Git is not concurrency-safe within a single repository: two simultaneous mutations can corrupt the index or produce inconsistent states. Long operations (fetch, push, clone) must remain cancellable and observable. Large IPC payloads (full history, massive diffs) degrade the UI and memory usage.

## Decision

1. **One session per repository** identified by its worktree path; worktrees sharing a common dir are known to the same session.
2. **Serialized mutations** per repository via a single actor/queue. Reads may be concurrent, but are blocked during a destructive mutation.
3. Every long operation returns an `operation_id` immediately and streams:
   - `progress`, `stdout`, `stderr`, `done`, `error`;
   - cancellation via `cancel_operation`.
4. No large IPC payloads:
   - commits in pages (adaptive size, 500 by default);
   - diffs by hunks/files, with a cap and pagination;
   - paginated file lists.
5. The frontend never sees a token, credential path, or shell command.
6. Tauri commands are typed, versioned, and return a structured error.
7. The Git process is launched with a controlled environment that respects user configuration (SSH agent, credential helpers, PATH, HOME).

## Consequences

- Concurrent mutations are refused or queued, with UI feedback.
- A canceled operation can leave an intermediate state: it is detected and presented.
- The IPC format can evolve without breaking the frontend thanks to command versioning.
- Tests must cover cancellation during fetch/push and detection of `index.lock`.

## Rejected alternatives

| Alternative | Reason |
|---|---|---|
| Parallel mutations | Index corruption and inconsistent states. |
| One `git` per click without an operation registry | Impossible to cancel, track, or correlate errors. |
| Full history payload | Unacceptable memory and latency. |
| Direct reading of `.git` by the frontend | Leaks logic and security outside the backend. |

## Revision criteria

Revisit if a need for highly concurrent reads during mutations arises, or if measured IPC volume requires a binary format (MessagePack) — a decision based on measurement, not anticipation.
