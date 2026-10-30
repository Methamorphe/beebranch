# ADR-0001 — Git CLI as the single engine

- **Status:** accepted
- **Date:** 2026-10-27
- **Supersedes:** revision 1 decision (`gix` reads + CLI writes + occasional `git2`)

## Context

The client must work with the enterprise's existing repositories, configurations, and tools: hooks, LFS, worktrees, submodules, SSH, GPG/SSH signatures, credential helpers, filters, global and local configuration.

Revision 1 proposed three engines:

- `gix` for fast reads;
- Git CLI for mutations;
- `git2`/libgit2 for certain cases.

This combination multiplies code paths, behavioral divergences, and tests. It also assumes an unmeasured performance gain. No product need justifies three engines at the outset.

## Decision

1. **Git CLI is the only Git engine** used by the application at the outset.
2. All invocations go through a single Rust module (`git`), which:
   - builds commands as **argv** (never a shell, never interpolation);
   - enforces machine-readable formats (`--porcelain`, `-z`, explicit formats);
   - captures `stdout`, `stderr`, exit code, and duration;
   - handles cancellation, streaming, and timeouts;
   - serializes mutations per repository.
3. `gix` may only be introduced if a reproducible benchmark demonstrates a **significant** gain on an identified read path, without changing observable behavior.
4. No `GitBackend` trait, plugin system, or second implementation is created in advance.

## Consequences

**Positive**

- A single Git behavior, identical to that of the terminal and CI.
- Hooks, LFS, signatures, worktrees, submodules, and credential helpers work without reimplementation.
- Reduced test surface.
- Real Git errors can be reported to the user.

**Negative**

- Process startup cost per operation (measured, generally low).
- Text output parsing to maintain.
- Some bulk reads may be slower than a native implementation; this is a performance issue to measure, not an architectural reason.
- Dependency on a minimum Git version and its options.

**Neutral**

- The `git` module isolates commands: replacing a specific read with `gix` remains possible without touching the rest of the application.

## Rejected alternatives

| Alternative | Reason |
|---|---|---|
| `gix` everywhere | Does not cover push, commit merges, rebase, reset (project status as of 2026-10). |
| `git2` everywhere | Possible divergences with hooks, LFS, signatures, and credential helpers; second behavior model. |
| Immediate hybrid | Complexity and double testing without evidence of a gain. |

## Revision criteria

Revisit this ADR if:

- a P0 benchmark scenario exceeds its budget and the cause is process or parsing cost;
- `gix` covers the missing operations with sufficient stability;
- a product need requires a read that is impossible or too slow via CLI.

Any revision must include: before/after measurement, exact scope, regression tests, and an update to this ADR.
