# ADR-0002 — Explicit undo, never universal

- **Status:** superseded by [ADR-0008](0008-no-application-backups.md) (2026-10-27)
- **Date:** 2026-10-27
- **Supersedes:** revision 1 ref/index snapshot strategy

> Retained for history. The targeted backup strategy described here is superseded by ADR-0008: no application backups, undo limited to operations reversible by Git.

## Context

Revision 1 proposed restoring references and the index before each mutation. This approach does not restore the working tree, does not cover untracked files, and can overwrite user changes if applied without checks.

Git does not provide universal undo: an operation can be partially applied, a hook can have external effects, a push cannot be undone locally, and a `reset --hard` destroys unversioned data.

## Decision

1. The application exposes undo **only** for operations whose inverse is defined and tested.
2. Each undoable operation has:
   - a **typed inverse** (never a generic `reset --hard`);
   - **preconditions** checked before execution;
   - **data captured** before mutation;
   - defined behavior in case of partial failure.
3. A repository state fingerprint is checked before any undo. If the repository has changed since the operation, undo is refused with an explanation.
4. Untracked files, local changes, conflicts, and interrupted operations are handled explicitly, never ignored.
5. Destructive operations capture a targeted backup before acting (deleted file contents, refs, index), in application storage outside the repository.
6. The complete system is P3 and **non-blocking** for the MVP. Minimal confirmations and backups are in P1.
7. A push is never locally undoable. A force-push requires explicit confirmation and records the old remote SHA; restoring the remote is a separate action, not an “undo”.

## Consequences

- The UI never generically promises “undo the last action”.
- Some actions are marked as not undoable.
- Backup storage must be bounded, cleaned up, and documented.
- Tests cover partial failures and interruptions.

## Rejected alternatives

| Alternative | Reason |
|---|---|---|
| Full repository snapshot before each action | Unacceptable disk/time cost on large repositories. |
| Generic `git reset --hard HEAD@{1}` | Destroys local changes and untracked files; does not handle intermediate states. |
| Undo by replaying unchecked inverse Git commands | Incorrect in cases involving conflicts, hooks, signatures, and partial operations. |
| Universal undo | Impossible promise to keep. |

## Revision criteria

Revisit if Git exposes a safe, portable undo primitive, or if the product decides to accept a full snapshot for very small repositories. Any matrix extension requires restoration tests and a data loss analysis.
