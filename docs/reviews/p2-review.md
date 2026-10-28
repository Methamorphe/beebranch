# P2 — Revue d'implémentation

**Date :** 2026-10-27
**Version :** 0.3.0
**Périmètre :** P2-T01 → P2-T14 + refonte visuelle et écrans d'après la maquette
de référence.

## Résultat

Toutes les fiches P2 sont implémentées côté backend et interface. Les
vérifications automatisées sont vertes : `cargo test --workspace` (313 tests),
`npm run build`, `npm run lint` (avertissements uniquement), `npm run ui:smoke`
(9 écrans P2 + parcours P1, résolution de conflit exercée).

## Preuves par fiche

| Fiche | Implémentation | Tests / preuve |
|---|---|---|
| P2-T01 Rebase interactif | `crates/git/src/history.rs` (`rebase_candidates`, `rebase_candidates_detail`, `rebase_interactive`), `crates/app/src/commands/history.rs`, `src/components/RebasePanel.tsx` | `p2_ops::interactive_rebase_reorders_reworks_and_drops`, `interactive_rebase_squashes_with_combined_message`, `interactive_rebase_rejects_a_partial_plan`, `rebase_conflict_is_visible_and_abortable` |
| P2-T02 Conflits 3 panneaux | `crates/git/src/conflict.rs`, `history.rs` (stages, mark resolved), `src/components/ConflictsPanel.tsx` | `conflict_workspace_reads_stages_and_saves_atomically`, `conflict_save_preserves_crlf` ; smoke `p2-conflicts.png` |
| P2-T03 Cherry-pick / revert | `history::cherry_pick` / `history::revert`, commandes `history_cherry_pick` / `history_revert` | `cherry_pick_and_revert_keep_order`, `cherry_pick_conflict_can_be_aborted` |
| P2-T04 Worktrees | `crates/git/src/worktree.rs`, `commands/worktrees.rs`, `src/components/WorktreesPanel.tsx` | `worktrees_are_listed_locked_and_removed`, `removing_a_dirty_worktree_requires_force` ; smoke `p2-worktrees.png` |
| P2-T05 Blame / historique fichier | `crates/git/src/blame.rs`, `commands/inspect.rs`, `src/components/FileHistoryPanel.tsx` | `blame_and_file_history_follow_renames` |
| P2-T06 Palette / raccourcis | `src/components/CommandPalette.tsx`, `src/hooks/useShortcuts.ts`, `src/lib/shortcuts.ts`, éditeur dans `ProfilesPanel` | smoke : navigation des 9 écrans P2 ; validation des doublons et des formats |
| P2-T07 Recherche approfondie | `crates/git/src/search.rs` (chemin, contenu, dates, auteur), `src/components/SearchPanel.tsx` | `deep_search_is_bounded_and_scoped`, `deep_search_pages_are_offset_based` ; recherche de contenu annulable via `operation_cancel` |
| P2-T08 Discussions inline | `crates/gitlab/src/client.rs` (discussions, positions snake_case, `diff_refs`), `commands/gitlab_advanced.rs`, `src/components/MrDetailExtras.tsx` | `lists_discussions_with_positions`, `creates_an_inline_discussion_with_snake_case_position`, `resolving_a_discussion_uses_put`, `reads_diff_refs_from_the_changes_endpoint` |
| P2-T09 Approbations / merge | `gitlab_advanced.rs`, `MrDetailExtras.tsx` | `approvals_404_exposes_the_status`, `merge_conflict_is_not_retried`, `merge_sends_auto_merge_and_shas` ; mapping 405/406/409 |
| P2-T10 Jobs / logs | `client::pipeline_jobs`, `client::job_log`, `gitlab_mr_jobs`, `gitlab_job_log` | `pipeline_jobs_are_paged`, `job_logs_are_truncated_at_the_cap`, `job_log_offset_pages_without_range_support` |
| P2-T11 Submodules | `crates/git/src/submodule.rs`, `commands/repository_admin.rs`, `src/components/SubmodulesPanel.tsx` | `submodule_status_and_update_are_bounded` |
| P2-T12 Tags / remotes | `crates/git/src/refs_admin.rs`, `commands/repository_admin.rs`, `src/components/RefsAdminPanel.tsx` | `tags_and_remotes_are_validated`, `pushing_a_tag_to_a_bare_remote_is_explicit` |
| P2-T13 Profils | `crates/app/src/commands/profiles.rs`, `src/components/ProfilesPanel.tsx` | `profiles::tests` ; identité visible via `commit_identity`, token isolé par instance |
| P2-T14 Patches | `crates/git/src/patch.rs`, `commands/patch.rs`, `src/components/PatchesPanel.tsx` | `patch_roundtrip_and_conflict_leave_the_worktree_untouched` |
| Secrets développement | `crates/store/src/secrets.rs`, `setup.rs` | `file_store_roundtrips_with_restricted_permissions` ; keychain en release |
| Clone depuis GitLab | `crates/git/src/clone.rs`, `repo_clone`, `src/components/Home.tsx` | `clones_a_local_repository_into_a_new_directory`, `askpass_returns_oauth2_username_and_the_token` ; smoke : sélection d’un projet et URL auto-remplie (`clone.projectPicked`, `clone.selectedUrl`) ; HTTPS authentifié par le token GitLab (askpass 0600) |

## Commandes exécutées

```sh
cargo test --workspace
npm run build
npm run lint
npm run ui:smoke
```

Résultats :

- `cargo test --workspace` : 313 tests, 0 échec.
- `npm run build` : TypeScript + Vite OK.
- `npm run lint` : 0 erreur (avertissements React `set-state-in-effect` sur
  des resets de formulaires).
- `npm run ui:smoke` : `"ok": true`, 9/9 écrans P2, 6/6 vues P1, résolution de
  conflit (`conflict_save`) exercée, sélection de projet GitLab avec URL
  auto-remplie, suite UX (focus, clavier, context menu, responsive). Le smoke
  vérifie aussi la présence de la police Geist embarquée, une base de 13 px et
  un contraste latéral ≥ 7:1 en thème sombre et clair (12,6:1 et 9,4:1
  mesurés). Sortie :
  `docs/reviews/p2-smoke.json`, captures : `p2-conflicts.png`,
  `p2-worktrees.png`, `p2-tags.png`.

## Garanties vérifiées

- Rebase : plan strictement égal à `upstream..HEAD`, ordre libre, aucun commit
  de base supprimé, conflits/abort couverts.
- Conflits : écriture atomique, CRLF préservé, marqueurs refusés par défaut,
  binaires et fichiers > 8 Mio traités explicitement.
- Worktrees : suppression sale refusée sans `force`, `force` exige la saisie
  exacte du chemin, lock/unlock et prune.
- Patches : `--check` avant application, conflit sans altération du worktree,
  binaires refusés, provenance affichée.
- GitLab : positions ancrées sur `diff_refs`, payloads snake_case côté API,
  aucun HTML brut rendu, logs plafonnés, erreurs 404/405/406/409/422 expliquées.
- Profils : une instance GitLab par profil, token lu dans le trousseau sous
  l'identifiant d'instance, aucun secret copié.

## Limites connues

- Le drag & drop du plan de rebase est laissé à P3 (T01 le sort du périmètre) ;
  les flèches assurent le réordonnancement.
- Aucun test GitLab live : les contrats HTTP sont couverts par `wiremock`.
- Le dogfooding humain multi-profils reste à planifier.
- Les tests ont été exécutés sur macOS uniquement. Les chemins Windows/Linux
  sont couverts par la conception (chemins normalisés pour l’éditeur de
  séquence, remplacement de fichier avec repli Windows) mais n’ont pas été
  exécutés dans cet environnement.
- Les captures visuelles sont produites par Chrome headless avec IPC simulé ;
  elles couvrent la structure et les états, pas une session GitLab réelle.
