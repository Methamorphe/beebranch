# ADR-0008 — No application backups; undo limited to Git

- **Status:** accepted
- **Date:** 2026-10-27
- **Decision makers:** project team
- **Supersedes:** [ADR-0002](0002-explicit-undo-redo.md)

## Context

ADR-0002 planned targeted backups before destructive actions (deleted file contents, index, refs). The product decision is to **not maintain application backups**: no working tree copy, no quota, no retention.

This decision reduces complexity and storage, but increases the risk of loss from destructive actions. It must remain compatible with the “no silent loss” requirement: the answer is explicit confirmation and displaying irreversibility, not a promise of undo.

## Decision

1. **No application copies** of files, the index, or the working tree.
2. Undo/redo covers only operations whose inverse uses **refs, commits, index trees, and Git objects**.
3. Explicitly **irreversible** operations: file/hunk discard, `reset --hard`, `stash drop`, `stash apply/pop`, push, fetch, submodule update.
4. Irreversible actions require confirmation describing the exact effect and stating that no undo is possible.
5. The application never deletes untracked files; discard applies only to tracked content.
6. Full undo/redo remains in P3; confirmations and preflight are in P1.
7. A restoration failure displays the command, step, and recovery SHA via the reflog; no automatic repair.

## Alternatives considered

| Alternative | Advantages | Disadvantages | Why rejected |
|---|---|---|---|
| Targeted backups (ADR-0002) | Undo for discard/reset hard | Storage, quota, cleanup, complexity | Product decision: no backups |
| Full snapshot before each action | Maximum recovery | Unacceptable disk/time cost | Overengineered |
| No undo at all | Very simple | Loss of a useful differentiator | Git-based undo remains inexpensive |
| OS trash for deleted files | Recovery | Variable behavior, outside the Git model | Does not cover hunks |

## Consequences

### Positive

- Simple model: Git is the reference state.
- No ancillary storage, no quota, no data leaks into app data.
- Less code and fewer tests.

### Negative

- Discard and `reset --hard` permanently lose uncommitted work.
- The UX must be very clear about irreversibility.
- Work loss incidents are possible and accepted as a product risk.

### Risks

- **Work loss** (R-16): mitigation through strong confirmation, preflight, no deletion of untracked files, and user education.
- **False expectation of undo**: the UI never shows undo for an irreversible action.
- **Future reintroduction**: if a major incident occurs, reopen the decision with a new ADR and targeted backups.

## Revision criteria

Revisit after a significant data loss incident, or if users explicitly request recovery from discard/reset hard. Any reintroduction of backups must define storage, quota, retention, encryption, and restoration tests.
