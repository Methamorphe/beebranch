# P1 — Dogfooding protocol and report

**Date:** 2026-10-27
**Status:** not run — requires three volunteer developers.

## 1. Objective

Verify that a full workday is possible without the incumbent client or the
terminal for P1 operations:

branch → partial staging → commit → push → MR → simple review → merge →
conflict resolution → stash → repository switching.

## 2. Preparation

1. Install 0.2.0 on macOS, Linux and Windows.
2. Open three real repositories (including one with hooks and a self-hosted GitLab repository).
3. Configure the GitLab instance and associate each repository with its project.
4. Enable screen recording and the operation journal.

## 3. Required scenario

| Step | Expected | Trace |
|---|---|---|
| Create a branch from the graph | branch created and checked out | capture + `git branch --show-current` |
| Modify two separate lines | stage one hunk then the other | index diff + `git diff --cached` |
| Commit with a deliberately failing hook | commit rejected, output visible, message preserved | capture + `git log -1` |
| Fix and commit | commit created, signed if configured | `git log --show-signature` |
| Fetch/pull/push | progress visible; non-ff push rejected with remediation | capture |
| Create an MR | MR opened, CI badge in the graph | capture + URL |
| Merge with a conflict | conflict visible, resolution in the editor, Mark resolved, Continue | capture + final status |
| Abort a rebase | status restored, typing `abort` requested | capture |
| Stash then conflicting pop | stash intact after conflict | `git stash list` |
| Open 5 repositories in alternation | no measured leak, isolated errors | RSS/CPU + captures |
| Close a tab with an operation | explicit confirmation | capture |
| Restart the application | active tab restored, conflict/merge still displayed | capture |

## 4. Measurements

- RSS before/after 10 tab switches (cap to define: +50 MiB).
- Perceived latency of staging actions (< 100 ms on the test corpus).
- Number of returns to the terminal (target: 0 outside P2).
- Data loss incidents (target: 0).

## 5. Blockers and backlog

To fill in during the session:

| # | Step | Symptom | Workaround | Severity | Decision |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## 6. Automated coverage available before the session

- `cargo test --workspace`: 269 tests, including 40 dedicated P1 tests and the full
  daily workflow.
- `npm run ui:smoke`: graph, diff, line selection, staging IPC, P1 views.
- `PERF-07`/`PERF-10`: versioned budgets.

This evidence does not replace the human criterion: three developers must
still run the scenario above.
