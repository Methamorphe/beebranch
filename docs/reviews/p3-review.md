# P3 — Implementation review

**Date:** 2026-10-27
**Version:** 0.4.0
**Scope:** P3-T01 → P3-T07 + signed distribution.

## Result

The seven P3 task sheets are implemented and verified by real Rust tests, an
extended UI smoke test (113 checks) and before/after benchmarks. Run evidence
is listed at the end of the document.

## Evidence by task sheet

| Task sheet | Implementation | Tests / evidence |
|---|---|---|
| P3-T01 Undo / redo | `crates/git/src/undo.rs`, `crates/store/src/undo.rs`, `crates/app/src/commands/undo.rs`, `src/components/RecoveryPanel.tsx`, RepoBar buttons, `Mod+Z`/`Mod+Shift+Z` shortcuts | `crates/git/tests/undo.rs` (14 scenarios: commit, amend, checkout, branches, tags, remotes, stash, worktrees, conflicting/completed merge, fingerprint, partial failure, no copying), `crates/app/tests/undo.rs` (pipeline, precondition rejection, crash), `crates/store/src/undo.rs` (bounded stack, invalidated redo, recovery) |
| P3-T02 Drag & drop | `crates/git/src/integration.rs`, `branch_integration_preview/start`, `BranchesPanel` (drag + preview + confirmation), `RebasePanel` (drag reordering) | `crates/git/tests/integration.rs` (consistent merge, conflict + abort, rebase, blockers), smoke: `branch-drag-rows`, `drop-preview-shows-commits`, `drop-no-mutation-before-confirm`, `drop-cancel-no-mutation`, `drop-confirm-calls-integration`, `rebase-drag-reorders-preview`, `rebase-drag-no-mutation-before-start` |
| P3-T03 Design system | `src/styles/tokens.css` (spacing, typography, depth, motion, density), `src/components/ui/Button.tsx`, `Dialog.tsx`, `view-enter` animations, density preference | Smoke: dark/light contrasts, `density-compact-tokens`, `density-restored`, captures `p3-density-compact.png`, `p3-light.png`, `p3-branch-drop.png`, `p3-workspaces.png`, `p3-updates.png` |
| P3-T04 Large repositories | `LogStream` in `crates/git/src/log.rs` + `RepoSession`, `index:sha` cursor, `--skip` fallback only for non-sequential access | `cursor_pages_reconstruct_*`, `session_graph_stream_pages_match_the_full_log`, PERF-03 bench: `linear-1m` 38.6 s → 18 ms, baseline updated |
| P3-T05 Workspaces | `crates/store/src/workspaces.rs`, `crates/app/src/commands/workspaces.rs`, `src/components/WorkspacesPanel.tsx` | `crates/app/tests/workspaces.rs`: 10 repositories, isolated failure, closed sessions, clean/dirty pull, store; smoke: per-repository status, bound of 20, partial failure |
| P3-T06 Accessibility | skip link, `main#main-content`, single Dialog with focus trap/restoration, contrasts, roles/labels, announcements, keyboard navigation | Smoke: `a11y-workspaces`, `a11y-graph`, `a11y-profiles`, `skip-link`, `skip-link-target`, token contrasts, existing keyboard/focus scenarios (palette, dialogs, canvas, menus) |
| P3-T07 Distribution | `src-tauri/tauri.conf.json` (packaging, updater, signatures), `src-tauri/entitlements.plist`, `crates/app/src/commands/update.rs`, `ProfilesPanel`, `.github/workflows/release.yml`, `scripts/update-manifest.mjs`, `merge-manifests.mjs`, `audit-no-telemetry.mjs`, release notes | `crates/app/tests/update_signature.rs` (signed artifact accepted, tampered/missing rejected), smoke: signed update settings + no telemetry, telemetry audit, latest/rollback manifests generated |

## Verified guarantees

- No irreversible operation (discard, reset --hard, stash drop/apply/pop,
  fetch, push, submodule update) is offered for undo; an inverse `reset --hard`
  is used only after fingerprint equality.
- An untracked file is never deleted by an undo.
- A partial failure preserves the step, command and recovery SHA;
  an interrupted restoration is not replayed at startup.
- A branch drop mutates nothing before confirmation; cancellation changes
  nothing; conflicts remain visible.
- The graph no longer traverses the prefix for deep pages; one
  `git log` process per session is canceled on close.
- A workspace reports one result per repository and closes sessions opened
  for the action.
- Contrasts are ≥ 7:1 for text, ≥ 4,5:1 for secondary text
  and ≥ 3:1 for lanes, in both themes.
- An unsigned or tampered update is rejected; rollback uses the
  same signature check.

## Commands run

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build
npm run lint
npm run ui:smoke
node scripts/audit-no-telemetry.mjs
target/release/beebranch-bench --all-reduced --assert
```

## Run results

- `cargo fmt --all -- --check`: compliant.
- `cargo clippy --workspace --all-targets -- -D warnings`: 0 warnings.
- `cargo test --workspace`: 351 tests, 0 failures.
- `npm run build`: TypeScript + Vite OK.
- `npm run lint`: 0 errors (inherited `set-state-in-effect` warnings).
- `npm run ui:smoke`: `ok: true`, 113 green P1/P2/P3 UX checks —
  output [p3-smoke.json](p3-smoke.json), captures
  [p3-workspaces.png](p3-workspaces.png),
  [p3-branch-drop.png](p3-branch-drop.png),
  [p3-updates.png](p3-updates.png),
  [p3-density-compact.png](p3-density-compact.png),
  [p3-light.png](p3-light.png).
- `node scripts/audit-no-telemetry.mjs`: no references.
- `target/release/beebranch-bench --all-reduced --assert`: reduced set within
  its budgets; PERF-03 30,46 ms p50 (baseline updated).
- Manifests: `latest.json` and `rollback.json` generated from
  `.sig` artifacts; tampered minisign signature rejected by a test.

## Known limitations

- Installation on a clean machine and real notarization depend on
  CI secrets and runners; they are not reproducible in this
  environment. Release CI checks each platform's signature.
- Rollback requires a previous signed version to still be published at
  the `rollback.json` endpoint.
- Human multi-profile dogfooding remains to be scheduled.
- Tests are run on macOS; Windows/Linux paths are covered
  by CI and design, not by a local run.
