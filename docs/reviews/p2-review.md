# P2 — Implementation review

**Date:** 2026-10-27
**Version:** 0.3.0
**Scope:** P2-T01 → P2-T14 + visual redesign and screens based on the reference
mockup.

## Result

All P2 task sheets are implemented in the backend and interface. Automated
checks are green: `cargo test --workspace` (313 tests),
`npm run build`, `npm run lint` (warnings only), `npm run ui:smoke`
(9 P2 screens + P1 flows, conflict resolution exercised).

## Evidence by task sheet

| Task sheet | Implementation | Tests / evidence |
|---|---|---|
| P2-T01 Interactive rebase | `crates/git/src/history.rs` (`rebase_candidates`, `rebase_candidates_detail`, `rebase_interactive`), `crates/app/src/commands/history.rs`, `src/components/RebasePanel.tsx` | `p2_ops::interactive_rebase_reorders_reworks_and_drops`, `interactive_rebase_squashes_with_combined_message`, `interactive_rebase_rejects_a_partial_plan`, `rebase_conflict_is_visible_and_abortable` |
| P2-T02 3-panel conflicts | `crates/git/src/conflict.rs`, `history.rs` (stages, mark resolved), `src/components/ConflictsPanel.tsx` | `conflict_workspace_reads_stages_and_saves_atomically`, `conflict_save_preserves_crlf`; smoke `p2-conflicts.png` |
| P2-T03 Cherry-pick / revert | `history::cherry_pick` / `history::revert`, commands `history_cherry_pick` / `history_revert` | `cherry_pick_and_revert_keep_order`, `cherry_pick_conflict_can_be_aborted` |
| P2-T04 Worktrees | `crates/git/src/worktree.rs`, `commands/worktrees.rs`, `src/components/WorktreesPanel.tsx` | `worktrees_are_listed_locked_and_removed`, `removing_a_dirty_worktree_requires_force`; smoke `p2-worktrees.png` |
| P2-T05 Blame / file history | `crates/git/src/blame.rs`, `commands/inspect.rs`, `src/components/FileHistoryPanel.tsx` | `blame_and_file_history_follow_renames` |
| P2-T06 Palette / shortcuts | `src/components/CommandPalette.tsx`, `src/hooks/useShortcuts.ts`, `src/lib/shortcuts.ts`, editor in `ProfilesPanel` | smoke: navigation of the 9 P2 screens; duplicate and format validation |
| P2-T07 Deep search | `crates/git/src/search.rs` (path, content, dates, author), `src/components/SearchPanel.tsx` | `deep_search_is_bounded_and_scoped`, `deep_search_pages_are_offset_based`; content search cancellable via `operation_cancel` |
| P2-T08 Inline discussions | `crates/gitlab/src/client.rs` (discussions, snake_case positions, `diff_refs`), `commands/gitlab_advanced.rs`, `src/components/MrDetailExtras.tsx` | `lists_discussions_with_positions`, `creates_an_inline_discussion_with_snake_case_position`, `resolving_a_discussion_uses_put`, `reads_diff_refs_from_the_changes_endpoint` |
| P2-T09 Approvals / merge | `gitlab_advanced.rs`, `MrDetailExtras.tsx` | `approvals_404_exposes_the_status`, `merge_conflict_is_not_retried`, `merge_sends_auto_merge_and_shas`; 405/406/409 mapping |
| P2-T10 Jobs / logs | `client::pipeline_jobs`, `client::job_log`, `gitlab_mr_jobs`, `gitlab_job_log` | `pipeline_jobs_are_paged`, `job_logs_are_truncated_at_the_cap`, `job_log_offset_pages_without_range_support` |
| P2-T11 Submodules | `crates/git/src/submodule.rs`, `commands/repository_admin.rs`, `src/components/SubmodulesPanel.tsx` | `submodule_status_and_update_are_bounded` |
| P2-T12 Tags / remotes | `crates/git/src/refs_admin.rs`, `commands/repository_admin.rs`, `src/components/RefsAdminPanel.tsx` | `tags_and_remotes_are_validated`, `pushing_a_tag_to_a_bare_remote_is_explicit` |
| P2-T13 Profiles | `crates/app/src/commands/profiles.rs`, `src/components/ProfilesPanel.tsx` | `profiles::tests`; identity visible via `commit_identity`, token isolated per instance |
| P2-T14 Patches | `crates/git/src/patch.rs`, `commands/patch.rs`, `src/components/PatchesPanel.tsx` | `patch_roundtrip_and_conflict_leave_the_worktree_untouched` |
| Development secrets | `crates/store/src/secrets.rs`, `setup.rs` | `file_store_roundtrips_with_restricted_permissions`; OS keychain in release |
| Clone from GitLab | `crates/git/src/clone.rs`, `repo_clone`, `src/components/Home.tsx` | `clones_a_local_repository_into_a_new_directory`, `askpass_returns_oauth2_username_and_the_token`; smoke: project selection and auto-filled URL (`clone.projectPicked`, `clone.selectedUrl`); HTTPS authenticated with the GitLab token (askpass 0600) |

## Commands run

```sh
cargo test --workspace
npm run build
npm run lint
npm run ui:smoke
```

Results:

- `cargo test --workspace`: 313 tests, 0 failures.
- `npm run build`: TypeScript + Vite OK.
- `npm run lint`: 0 errors (React `set-state-in-effect` warnings on
  form resets).
- `npm run ui:smoke`: `"ok": true`, 9/9 P2 screens, 6/6 P1 views, conflict
  resolution (`conflict_save`) exercised, GitLab project selection with an
  auto-filled URL, UX suite (focus, keyboard, context menu, responsive). The smoke test
  also checks the presence of the bundled Geist font, a 13 px base and
  sidebar contrast ≥ 7:1 in dark and light themes (12,6:1 and 9,4:1
  measured). Output:
  `docs/reviews/p2-smoke.json`, captures: `p2-conflicts.png`,
  `p2-worktrees.png`, `p2-tags.png`.

## Verified guarantees

- Rebase: plan strictly equal to `upstream..HEAD`, free ordering, no base
  commit deleted, conflicts/abort covered.
- Conflicts: atomic writes, CRLF preserved, markers rejected by default,
  binaries and files > 8 MiB handled explicitly.
- Worktrees: dirty removal rejected without `force`, `force` requires typing
  the exact path, lock/unlock and prune.
- Patches: `--check` before application, conflict without altering the worktree,
  binaries rejected, provenance displayed.
- GitLab: positions anchored to `diff_refs`, snake_case payloads on the API side,
  no raw HTML rendered, capped logs, 404/405/406/409/422 errors explained.
- Profiles: one GitLab instance per profile, token read from the OS keychain under
  the instance identifier, no secret copied.

## Known limitations

- Rebase plan drag & drop is left to P3 (T01 excludes it from scope);
  arrows handle reordering.
- No live GitLab test: HTTP contracts are covered by `wiremock`.
- Human multi-profile dogfooding remains to be scheduled.
- Tests were run on macOS only. Windows/Linux paths
  are covered by design (normalized paths for the sequence
  editor, file replacement with Windows fallback) but were not
  run in this environment.
- Visual captures are produced by headless Chrome with simulated IPC;
  they cover structure and states, not a real GitLab session.
